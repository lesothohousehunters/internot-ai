package org.internot.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;

/** Run tab: GPS recording that keeps going with the screen off, and saving a replay video. */
@CapacitorPlugin(name = "Run", permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
})
public class RunPlugin extends Plugin {

    private boolean gpsOn() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        try { return lm != null && lm.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception e) { return false; }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) { requestPermissionForAlias("location", call, "afterLocation"); return; }
        begin(call);
    }

    @PermissionCallback
    private void afterLocation(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) begin(call);
        else call.reject("Allow location for Internot AI to record a run. GPS works with no internet.");
    }

    private void begin(PluginCall call) {
        if (!gpsOn()) { call.reject("Location (GPS) is switched off. Turn on Location in the phone's quick settings, then press Start again."); return; }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            try { ActivityCompat.requestPermissions(getActivity(), new String[] { "android.permission.POST_NOTIFICATIONS" }, 4107); } catch (Exception ignored) { }
        }
        if (!RunService.running) {
            RunService.prepare(getContext(), call.getBoolean("keep", false));
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), RunService.class));
        }
        RunService.paused = false;
        call.resolve(state());
    }

    @PluginMethod
    public void pause(PluginCall call) { RunService.paused = true; call.resolve(state()); }

    @PluginMethod
    public void resume(PluginCall call) {
        if (RunService.paused) { RunService.segment++; RunService.paused = false; }
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RunService.class));
        RunService.running = false;
        call.resolve(state());
    }

    /** Forget the saved fixes (after the run is saved in the app, or thrown away). */
    @PluginMethod
    public void clear(PluginCall call) {
        if (!RunService.running) { RunService.points.clear(); RunService.file(getContext()).delete(); }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    private JSObject state() {
        JSObject o = new JSObject();
        o.put("running", RunService.running);
        o.put("paused", RunService.paused);
        o.put("count", RunService.running ? RunService.points.size() : RunService.fromFile(getContext()).size());
        o.put("gps", gpsOn());
        o.put("lastFix", RunService.lastFix);
        o.put("accuracy", RunService.lastAccuracy);
        o.put("error", RunService.error);
        return o;
    }

    /** Fixes from number `from` on: from memory while recording, otherwise from the saved file. */
    @PluginMethod
    public void points(PluginCall call) {
        int from = Math.max(0, call.getInt("from", 0));
        List<double[]> src;
        if (RunService.running) { synchronized (RunService.points) { src = new ArrayList<>(RunService.points); } }
        else src = RunService.fromFile(getContext());
        JSArray list = new JSArray();
        try {
            for (int i = from; i < src.size(); i++) {
                double[] p = src.get(i); JSONArray a = new JSONArray();
                for (double v : p) a.put(v);
                list.put(a);
            }
        } catch (Exception e) { call.reject(e.getMessage()); return; }
        JSObject o = new JSObject(); o.put("points", list); o.put("total", src.size());
        call.resolve(o);
    }

    /** Saves a replay video and opens the share menu (save to the gallery, WhatsApp, Quick Share...). */
    @PluginMethod
    public void shareVideo(PluginCall call) {
        String data = call.getString("data"), name = call.getString("name", "internot-run.webm");
        if (data == null) { call.reject("No video"); return; }
        try {
            File dir = new File(getContext().getCacheDir(), "videos"); dir.mkdirs();
            for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
            File f = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(Base64.decode(data, Base64.DEFAULT)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(call.getString("type", "video/webm"));
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Share your run video");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            JSObject o = new JSObject(); o.put("path", f.getAbsolutePath()); o.put("bytes", f.length());
            call.resolve(o);
        } catch (Exception e) { call.reject("Could not save the video: " + e.getMessage()); }
    }
}
