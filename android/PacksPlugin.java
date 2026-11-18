package org.internot.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.PowerManager;
import android.os.StatFs;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Maps and AI models after install: downloads that continue where they stopped, checked against their
 * SHA-256; files imported from a memory card, USB stick or a received file; and sharing the app, a map
 * or the model through the phone's share menu (Quick Share, Bluetooth, WhatsApp and similar).
 */
@CapacitorPlugin(name = "Packs")
public class PacksPlugin extends Plugin {

    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();

    private File dir(String name) { File d = new File(getContext().getFilesDir(), name); d.mkdirs(); return d; }
    private File dlDir() { return dir("packs/dl"); }
    private File mapsDir() { return dir("packs/maps"); }
    private File modelFile() { return new File(getContext().getFilesDir(), "model.gguf"); }
    private File modelMeta() { return new File(getContext().getFilesDir(), "model.json"); }
    private static String safe(String f) { return f == null ? "" : f.replaceAll("[^A-Za-z0-9._-]", "_"); }

    @PluginMethod
    public void info(PluginCall call) {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        StatFs fs = new StatFs(getContext().getFilesDir().getAbsolutePath());
        JSObject r = new JSObject();
        r.put("ram", mi.totalMem);
        r.put("free", fs.getAvailableBytes());
        r.put("maps", listMaps());
        call.resolve(r);
    }

    private JSArray listMaps() {
        JSArray a = new JSArray();
        File[] fs = mapsDir().listFiles();
        if (fs != null) for (File f : fs) {
            if (!f.getName().endsWith(".imap")) continue;
            JSObject h = header(f);
            if (h == null) continue;
            h.put("file", f.getName());
            h.put("path", f.getAbsolutePath());
            h.put("mb", Math.round(f.length() / 1048576.0));
            a.put(h);
        }
        return a;
    }

    /** The name, area and house count from the start of an Internot map file, or null if it is not one. */
    static JSObject header(File f) {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            byte[] b = new byte[(int) Math.min(800, f.length())];
            r.readFully(b);
            if (b.length < 16 || b[0] != 'I' || b[1] != 'M' || b[2] != 'A' || b[3] != 'P') return null;
            String s = new String(b, 12, b.length - 12, StandardCharsets.UTF_8);
            JSObject o = new JSObject();
            Matcher m = Pattern.compile("\"name\":\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(s);
            o.put("name", m.find() ? m.group(1) : f.getName().replace(".imap", ""));
            m = Pattern.compile("\"bbox\":\\[([-0-9.,e]+)\\]").matcher(s);
            if (m.find()) { JSArray bb = new JSArray(); for (String v : m.group(1).split(",")) bb.put(Double.parseDouble(v)); o.put("bbox", bb); }
            m = Pattern.compile("\"B\":(\\d+)").matcher(s);
            o.put("houses", m.find() ? Long.parseLong(m.group(1)) : 0);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private void progress(String id, String phase, long done, long total) {
        JSObject p = new JSObject();
        p.put("id", id);
        p.put("phase", phase);
        p.put("done", done);
        p.put("total", total);
        notifyListeners("progress", p);
    }

    /** Bytes already downloaded for a file, so the screen can say "continue". */
    @PluginMethod
    public void partial(PluginCall call) {
        File part = new File(dlDir(), safe(call.getString("file")) + ".part");
        JSObject r = new JSObject();
        r.put("bytes", part.exists() ? part.length() : 0);
        call.resolve(r);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        cancelled.put(id, true);
        call.resolve();
    }

    /** Downloads url to packs/dl/<file>, continuing a partial file. Resolves once the size and SHA-256 match. */
    @PluginMethod
    public void download(PluginCall call) {
        final String id = call.getString("id", "");
        final String url = call.getString("url");
        final String file = safe(call.getString("file"));
        final long size = (long) (double) call.getDouble("size", -1.0);
        final String sha = call.getString("sha256", "");
        if (url == null || file.isEmpty()) { call.reject("url and file are needed"); return; }
        if (size > 0) {
            long free = new StatFs(getContext().getFilesDir().getAbsolutePath()).getAvailableBytes();
            File part = new File(dlDir(), file + ".part");
            long need = size - (part.exists() ? part.length() : 0) + (64L << 20);
            if (free < need) { call.reject("Not enough free space: " + (need >> 20) + " MB needed, " + (free >> 20) + " MB free."); return; }
        }
        cancelled.remove(id);
        net.execute(() -> {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "internot:download");
            lock.acquire(6 * 60 * 60 * 1000L);
            try {
                File part = new File(dlDir(), file + ".part"), done = new File(dlDir(), file);
                done.delete();
                String err = null;
                for (int attempt = 0; attempt < 6; attempt++) {
                    if (Boolean.TRUE.equals(cancelled.get(id))) { call.reject("paused"); return; }
                    try { err = null; fetch(id, url, part, size); break; }
                    catch (Exception e) {
                        err = e.getMessage();
                        if ("paused".equals(err) || (err != null && err.startsWith("The server"))) break;
                        progress(id, "retry", part.length(), size);
                        Thread.sleep(Math.min(30000, 2000L << attempt));
                    }
                }
                if (err != null) { call.reject(err); return; }
                if (size > 0 && part.length() != size) { call.reject("The file is incomplete. Tap to continue."); return; }
                if (!sha.isEmpty()) {
                    progress(id, "checking", 0, part.length());
                    String got = sha256(part, id);
                    if (!sha.equalsIgnoreCase(got)) { part.delete(); call.reject("The file was damaged on the way and was removed. Please download it again."); return; }
                }
                if (!part.renameTo(done)) { call.reject("Could not save the file."); return; }
                JSObject r = new JSObject();
                r.put("path", done.getAbsolutePath());
                r.put("size", done.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                if (lock.isHeld()) lock.release();
            }
        });
    }

    private void fetch(String id, String url, File part, long size) throws Exception {
        long have = part.exists() ? part.length() : 0;
        if (size > 0 && have == size) return;
        if (size > 0 && have > size) { part.delete(); have = 0; }
        HttpURLConnection c = null;
        String at = url;
        for (int hop = 0; hop < 6; hop++) {   // follow redirects by hand so the Range header is kept on every hop
            c = (HttpURLConnection) new URL(at).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "InternotAI");
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) { at = new URL(new URL(at), c.getHeaderField("Location")).toString(); c.disconnect(); continue; }
            break;
        }
        int code = c.getResponseCode();
        if (code == 416 && size > 0 && have == size) return;
        if (code == 404 || code == 403 || code == 401) throw new Exception("The server does not have this file (" + code + ").");
        boolean append = code == 206;
        if (code != 200 && code != 206) throw new Exception("Download failed (" + code + ")");
        if (!append) have = 0;
        byte[] buf = new byte[1 << 16];
        long last = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                if (Boolean.TRUE.equals(cancelled.get(id))) throw new Exception("paused");
                out.write(buf, 0, n);
                have += n;
                if (have - last > (2 << 20)) { last = have; progress(id, "download", have, size); }
            }
        } finally {
            c.disconnect();
        }
        progress(id, "download", have, size);
        if (size > 0 && have < size) throw new Exception("connection dropped");
    }

    private String sha256(File f, String id) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[1 << 20];
        long done = 0, last = 0, total = f.length();
        try (InputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
                done += n;
                if (done - last > (32 << 20)) { last = done; progress(id, "checking", done, total); }
            }
        }
        StringBuilder s = new StringBuilder();
        for (byte b : md.digest()) s.append(String.format("%02x", b));
        return s.toString();
    }

    /** Puts a downloaded or received file in place: a model becomes The Brain's model, a map joins the maps. */
    @PluginMethod
    public void install(PluginCall call) {
        final String kind = call.getString("kind", "");
        final String from = call.getString("path");
        final String name = call.getString("name", "");
        io.execute(() -> {
            try {
                File src = new File(from == null ? "" : from);
                if (!src.exists()) { call.reject("The file is missing."); return; }
                call.resolve(place(kind, src, name, true));
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private JSObject place(String kind, File src, String name, boolean move) throws Exception {
        byte[] magic = new byte[4];
        try (RandomAccessFile r = new RandomAccessFile(src, "r")) { r.readFully(magic); }
        String m = new String(magic, StandardCharsets.US_ASCII);
        if (kind.isEmpty()) kind = "GGUF".equals(m) ? "model" : "IMAP".equals(m) ? "map" : "";
        JSObject out = new JSObject();
        out.put("kind", kind);
        if ("model".equals(kind)) {
            if (!"GGUF".equals(m)) throw new Exception("That is not a GGUF model file.");
            File dst = modelFile();
            File tmp = new File(getContext().getFilesDir(), "model.gguf.new");
            if (move) { tmp.delete(); if (!src.renameTo(tmp)) throw new Exception("Could not save the model."); } else copy(src, tmp, "import");
            dst.delete();
            if (!tmp.renameTo(dst)) throw new Exception("Could not save the model.");
            JSONObject o = new JSONObject();
            o.put("name", name.isEmpty() ? "AI model" : name);
            try (FileOutputStream w = new FileOutputStream(modelMeta())) { w.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
            out.put("name", o.getString("name"));
            out.put("size", dst.length());
            return out;
        }
        if ("map".equals(kind)) {
            if (!"IMAP".equals(m)) throw new Exception("That is not an Internot map file (.imap).");
            String fn = safe(src.getName().endsWith(".imap") ? src.getName() : (name.isEmpty() ? "map" : name) + ".imap");
            File dst = new File(mapsDir(), fn);
            if (move) { dst.delete(); if (!src.renameTo(dst)) throw new Exception("Could not save the map."); } else copy(src, dst, "import");
            JSObject h = header(dst);
            if (h == null) { dst.delete(); throw new Exception("That map file is damaged."); }
            h.put("file", dst.getName());
            h.put("path", dst.getAbsolutePath());
            h.put("mb", Math.round(dst.length() / 1048576.0));
            h.put("kind", "map");
            return h;
        }
        throw new Exception("This file is not a map (.imap) or an AI model (.gguf).");
    }

    private void copy(File src, File dst, String id) throws Exception {
        try (InputStream in = new FileInputStream(src)) { copy(in, src.length(), dst, id); }
    }

    private void copy(InputStream in, long total, File dst, String id) throws Exception {
        File tmp = new File(dst.getParentFile(), dst.getName() + ".copy");
        byte[] buf = new byte[1 << 20];
        long done = 0, last = 0;
        try (OutputStream out = new FileOutputStream(tmp)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (done - last > (8 << 20)) { last = done; progress(id, "copy", done, total); }
            }
        }
        dst.delete();
        if (!tmp.renameTo(dst)) throw new Exception("Could not save the file.");
    }

    @PluginMethod
    public void remove(PluginCall call) {
        File f = new File(mapsDir(), safe(call.getString("file")));
        f.delete();
        call.resolve();
    }

    /** The phone's own file picker: a map or a model from a memory card, USB stick, Downloads or a received file. */
    @PluginMethod
    public void importFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("cancelled"); return; }
        final Uri uri = result.getData().getData();
        io.execute(() -> {
            try {
                String name = "file";
                long size = -1;
                try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE);
                        if (ni >= 0) name = c.getString(ni);
                        if (si >= 0) size = c.getLong(si);
                    }
                }
                File tmp = new File(dlDir(), safe(name));
                try (InputStream in = getContext().getContentResolver().openInputStream(uri)) { copy(in, size, tmp, "import"); }
                String base = name.replaceAll("(?i)\\.(gguf|imap)$", "");
                try { call.resolve(place("", tmp, base, true)); } finally { tmp.delete(); }
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** A file on the phone for sharing: the app itself, a map (copied out of the app if it is built in) or the model. */
    private File fileFor(String what, String file) throws Exception {
        File share = dir("share");
        if ("app".equals(what)) {
            File apk = new File(getContext().getApplicationInfo().sourceDir);
            File named = new File(share, "Internot-AI.apk");
            if (named.exists() && named.length() == apk.length() && named.lastModified() >= apk.lastModified()) return named;
            long free = new StatFs(share.getAbsolutePath()).getAvailableBytes();
            if (free < apk.length() + (64L << 20)) return apk;   // no room for a copy with a friendly name: share it as it is
            copy(apk, named, "share");
            return named;
        }
        if ("model".equals(what)) {
            if (!modelFile().exists()) throw new Exception("There is no AI model on this phone yet.");
            return modelFile();
        }
        if ("map".equals(what)) {
            String f = safe(file);
            File own = new File(mapsDir(), f);
            if (own.exists()) return own;
            File out = new File(share, f);
            if (out.exists() && out.length() > 0) return out;
            try (InputStream in = getContext().getAssets().open("public/maps/" + f)) { copy(in, -1, out, "share"); }
            return out;
        }
        throw new Exception("Nothing to share");
    }

    @PluginMethod
    public void pathFor(PluginCall call) {
        final String what = call.getString("what", ""), file = call.getString("file", "");
        io.execute(() -> {
            try {
                File f = fileFor(what, file);
                JSObject r = new JSObject();
                r.put("path", f.getAbsolutePath());
                r.put("size", f.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        final String what = call.getString("what", ""), file = call.getString("file", "");
        io.execute(() -> {
            try {
                File f = fileFor(what, file);
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("app".equals(what) ? "application/vnd.android.package-archive" : "application/octet-stream");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Share with no data");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> {
                    try { getActivity().startActivity(chooser); call.resolve(); }
                    catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
                });
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }
}
