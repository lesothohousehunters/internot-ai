package org.internot.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Brain, run natively with llama.cpp on the phone's processor cores.
 * Several times faster than the web engine, which can only use one core inside an app.
 */
@CapacitorPlugin(name = "Brain")
public class BrainPlugin extends Plugin {

    private static boolean libOk = false;
    private static String libError = "";

    static {
        try {
            System.loadLibrary("internotbrain");
            libOk = true;
        } catch (Throwable t) {
            libError = String.valueOf(t.getMessage());
        }
    }

    static native String nativeLoad(String path, int threads, int ctx);
    static native String nativeGenerate(String[] roles, String[] contents, int maxTokens, float temp, Sink sink);
    static native void nativeStop();
    static native void nativeFree();

    public interface Sink {
        boolean piece(byte[] utf8);
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile boolean loaded = false;
    private volatile String loadedPath = "";

    private File modelFile() { return new File(getContext().getFilesDir(), "model.gguf"); }
    private File metaFile() { return new File(getContext().getFilesDir(), "model.json"); }

    static int threads() {
        int cores = Runtime.getRuntime().availableProcessors();
        if (cores >= 6) return 4;
        if (cores >= 4) return cores - 1;
        return Math.max(1, cores - 1);
    }

    private JSObject meta() {
        try {
            File f = metaFile();
            if (!f.exists() || !modelFile().exists()) return null;
            byte[] b = new byte[(int) f.length()];
            try (RandomAccessFile r = new RandomAccessFile(f, "r")) { r.readFully(b); }
            JSObject o = new JSObject(new String(b, StandardCharsets.UTF_8));
            o.put("size", modelFile().length());
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private void writeMeta(String name) throws Exception {
        JSONObject o = new JSONObject();
        o.put("name", name);
        try (FileOutputStream out = new FileOutputStream(metaFile())) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", libOk);
        r.put("error", libError);
        r.put("threads", threads());
        r.put("cores", Runtime.getRuntime().availableProcessors());
        r.put("loaded", loaded);
        r.put("model", meta());
        boolean bundled = false;
        try (AssetFileDescriptor fd = getContext().getAssets().openFd("public/bundled/model.gguf")) { bundled = fd.getLength() > 0; } catch (Exception ignored) {}
        r.put("bundled", bundled);
        call.resolve(r);
    }

    private void copyIn(InputStream in, long total, String name) throws Exception {
        File part = new File(getContext().getFilesDir(), "model.gguf.part");
        byte[] buf = new byte[1 << 20];
        long done = 0, lastNote = 0;
        try (OutputStream out = new FileOutputStream(part)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (done - lastNote > (8 << 20)) {
                    lastNote = done;
                    JSObject p = new JSObject();
                    p.put("done", done);
                    p.put("total", total);
                    notifyListeners("progress", p);
                }
            }
        }
        byte[] magic = new byte[4];
        try (RandomAccessFile r = new RandomAccessFile(part, "r")) { r.readFully(magic); }
        if (!"GGUF".equals(new String(magic, StandardCharsets.US_ASCII))) {
            part.delete();
            throw new Exception("That is not a GGUF model file.");
        }
        unloadNow();
        modelFile().delete();
        if (!part.renameTo(modelFile())) throw new Exception("Could not save the model.");
        writeMeta(name);
    }

    /** First launch of the full app: copy the model that ships inside the app to where it can be read quickly. */
    @PluginMethod
    public void prepareBundled(PluginCall call) {
        io.execute(() -> {
            try {
                JSObject m = meta();
                if (m != null) { call.resolve(m); return; }   // a model is already here: never replace it
                try (AssetFileDescriptor fd = getContext().getAssets().openFd("public/bundled/model.gguf"); InputStream in = fd.createInputStream()) {
                    copyIn(in, fd.getLength(), "Qwen2.5 1.5B (built in)");
                }
                JSONObject o = new JSONObject();
                o.put("name", "Qwen2.5 1.5B (built in)");
                o.put("bundled", true);
                try (FileOutputStream out = new FileOutputStream(metaFile())) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
                call.resolve(meta());
            } catch (Exception e) {
                call.reject("Setup could not finish: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void pickModel(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        final Uri uri = result.getData().getData();
        io.execute(() -> {
            try {
                String name = "model.gguf";
                long size = -1;
                try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE);
                        if (ni >= 0) name = c.getString(ni);
                        if (si >= 0) size = c.getLong(si);
                    }
                }
                try (InputStream in = getContext().getContentResolver().openInputStream(uri)) { copyIn(in, size, name); }
                call.resolve(meta());
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        unloadNow();
        modelFile().delete();
        metaFile().delete();
        call.resolve();
    }

    private void unloadNow() {
        if (libOk && loaded) {
            nativeStop();
            nativeFree();
        }
        loaded = false;
        loadedPath = "";
    }

    @PluginMethod
    public void load(PluginCall call) {
        if (!libOk) { call.reject("Native engine missing: " + libError); return; }
        final int ctx = call.getInt("ctx", 2048);
        worker.execute(() -> {
            File f = modelFile();
            if (!f.exists()) { call.reject("NO_MODEL"); return; }
            if (loaded && loadedPath.equals(f.getAbsolutePath())) { call.resolve(); return; }
            long t0 = System.currentTimeMillis();
            String err = nativeLoad(f.getAbsolutePath(), threads(), ctx);
            if (!err.isEmpty()) { call.reject(err); return; }
            loaded = true;
            loadedPath = f.getAbsolutePath();
            JSObject r = new JSObject();
            r.put("ms", System.currentTimeMillis() - t0);
            r.put("threads", threads());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        worker.execute(() -> { unloadNow(); call.resolve(); });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (libOk) nativeStop();
        call.resolve();
    }

    /** Streams the answer as "piece" events, then resolves with timing figures. */
    @PluginMethod
    public void generate(PluginCall call) {
        if (!libOk) { call.reject("Native engine missing"); return; }
        final JSArray msgs = call.getArray("messages");
        final int max = call.getInt("maxTokens", 256);
        final float temp = call.getFloat("temperature", 0.6f);
        final String id = call.getString("id", "");
        worker.execute(() -> {
            try {
                if (!loaded) { call.reject("NOT_LOADED"); return; }
                int n = msgs.length();
                String[] roles = new String[n], contents = new String[n];
                for (int i = 0; i < n; i++) {
                    JSONObject m = msgs.getJSONObject(i);
                    roles[i] = m.optString("role", "user");
                    contents[i] = m.optString("content", "");
                }
                String res = nativeGenerate(roles, contents, max, temp, utf8 -> {
                    JSObject p = new JSObject();
                    p.put("id", id);
                    p.put("text", new String(utf8, StandardCharsets.UTF_8));
                    notifyListeners("piece", p);
                    return true;
                });
                if (!res.startsWith("ok:")) { call.reject(res); return; }
                String[] s = res.substring(3).split(",");
                JSObject r = new JSObject();
                r.put("promptTokens", Integer.parseInt(s[0]));
                r.put("promptMs", Integer.parseInt(s[1]));
                r.put("tokens", Integer.parseInt(s[2]));
                r.put("genMs", Integer.parseInt(s[3]));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }
}
