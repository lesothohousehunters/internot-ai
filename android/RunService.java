package org.internot.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Records a run or walk from the phone's GPS, also while the screen is off. GPS needs no internet,
 * no SIM and no Google services. Every fix is also written to a file, so a run survives the app
 * being closed by the phone. One fix: time, latitude, longitude, altitude, accuracy, speed, segment
 * (the segment number goes up after each pause, so the gap is not counted as distance).
 */
public class RunService extends Service implements LocationListener {

    /** Voice coach settings, set by the app before a run (null = no voice). */
    static volatile JSONObject coach = null;
    static volatile String lastSaid = "";
    // the coach's own running totals (same filters as the app: poor fixes and GPS jumps are skipped)
    private double cDist = 0, cMoving = 0, nextDist = 0, nextTime = 0; private double[] cPrev = null; private boolean goalSaid = false, halfSaid = false;
    private final ArrayList<double[]> win = new ArrayList<>();
    private int ivIndex = -1; private double ivStartDist = 0, ivStartTime = 0;
    private TextToSpeech tts; private boolean ttsReady = false;

    static final List<double[]> points = Collections.synchronizedList(new ArrayList<>());
    static volatile boolean running = false;
    static volatile boolean paused = false;
    static volatile int segment = 0;
    static volatile long lastFix = 0;
    static volatile float lastAccuracy = -1;
    static volatile String error = null;

    private LocationManager lm;
    private PowerManager.WakeLock wake;
    private FileWriter out;

    static File file(Context c) { return new File(c.getFilesDir(), "run-current.csv"); }

    /** Starts a new run (keep = false) or carries on with the one saved in the file. */
    static void prepare(Context c, boolean keep) {
        points.clear(); segment = 0; paused = false; error = null; lastFix = 0; lastAccuracy = -1;
        File f = file(c);
        if (!keep) { f.delete(); return; }
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) {
                String[] a = line.split(","); if (a.length < 7) continue;
                double[] p = new double[7];
                for (int i = 0; i < 7; i++) p[i] = Double.parseDouble(a[i]);
                points.add(p); segment = (int) p[6];
            }
        } catch (Exception ignored) { }
        if (!points.isEmpty()) segment++;   // carrying on after a stop counts as a pause
    }

    /** The fixes saved in the file, when the app was closed during a run. */
    static List<double[]> fromFile(Context c) {
        List<double[]> list = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new FileReader(file(c)))) {
            String line;
            while ((line = r.readLine()) != null) {
                String[] a = line.split(","); if (a.length < 7) continue;
                double[] p = new double[7];
                for (int i = 0; i < 7; i++) p[i] = Double.parseDouble(a[i]);
                list.add(p);
            }
        } catch (Exception ignored) { }
        return list;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel ch = new NotificationChannel("run", "Run and walk recording", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while Internot AI records a run or walk");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, "run")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Internot AI is recording")
                .setContentText("Your run or walk is being recorded with GPS. No internet used.")
                .setOngoing(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        ServiceCompat.startForeground(this, 41, n, type);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) { wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "internot:run"); wake.acquire(6L * 60 * 60 * 1000); }
        try { out = new FileWriter(file(this), true); } catch (Exception e) { out = null; }
        try { tts = new TextToSpeech(this, (st) -> { ttsReady = st == TextToSpeech.SUCCESS; if (ttsReady) { try { tts.setLanguage(Locale.UK); } catch (Exception ignored) { } coachStart(); } }); } catch (Exception e) { tts = null; }
        // carry on the coach's totals when an interrupted run is continued
        synchronized (points) { for (double[] p : points) coachStep(p, false); }
        instance = this;
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper());
            running = true;
        } catch (SecurityException e) {
            error = "Location permission is needed to record a run."; stopSelf();
        } catch (Exception e) {
            error = "This phone has no GPS available: " + e.getMessage(); stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }

    @Override
    public void onLocationChanged(Location l) {
        lastFix = System.currentTimeMillis();
        lastAccuracy = l.hasAccuracy() ? l.getAccuracy() : -1;
        if (paused) return;
        double[] p = new double[] { l.getTime(), l.getLatitude(), l.getLongitude(),
                l.hasAltitude() ? l.getAltitude() : -9999, l.hasAccuracy() ? l.getAccuracy() : -1,
                l.hasSpeed() ? l.getSpeed() : -1, segment };
        points.add(p);
        coachStep(p, true);
        if (out != null) {
            try {
                StringBuilder b = new StringBuilder();
                for (int i = 0; i < 7; i++) { if (i > 0) b.append(','); b.append(i == 0 || i == 6 ? String.valueOf((long) p[i]) : String.valueOf(p[i])); }
                out.write(b.append('\n').toString()); out.flush();
            } catch (Exception ignored) { }
        }
    }

    @Override public void onProviderEnabled(String provider) { error = null; }
    @Override public void onProviderDisabled(String provider) { error = "Location (GPS) is switched off. Turn it on to keep recording."; }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }

    @Override
    public void onDestroy() {
        running = false; instance = null;
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) { }
        try { if (out != null) out.close(); } catch (Exception ignored) { }
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { }
        try { if (tts != null) tts.shutdown(); } catch (Exception ignored) { }
        super.onDestroy();
    }


    /* ---------------- voice coach ---------------- */
    static double hav(double la1, double lo1, double la2, double lo2) {
        double r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
        double h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
        return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    static String clock(double s) {
        long t = Math.round(s), h = t / 3600, m = (t / 60) % 60, x = t % 60;
        String out = "";
        if (h > 0) out += h + (h == 1 ? " hour " : " hours ");
        if (m > 0 || h > 0) out += m + (m == 1 ? " minute " : " minutes ");
        if (h == 0) out += x + (x == 1 ? " second" : " seconds");
        return out.trim();
    }
    static String pace(double secPerKm) {
        if (!(secPerKm > 0) || secPerKm > 3600) return "";
        long t = Math.round(secPerKm); return (t / 60) + " " + String.format(Locale.UK, "%02d", t % 60) + " per kilometre";
    }
    static String km(double m) {
        double k = m / 1000; if (Math.abs(k - Math.round(k)) < 0.005) { long n = Math.round(k); return n + (n == 1 ? " kilometre" : " kilometres"); }
        return String.format(Locale.UK, "%.1f kilometres", k);
    }
    void say(String text) {
        lastSaid = text;
        if (tts != null && ttsReady) { try { tts.speak(text, TextToSpeech.QUEUE_ADD, null, "run" + System.nanoTime()); } catch (Exception ignored) { } }
    }
    private JSONArray intervals() { JSONObject c = coach; return c == null ? null : c.optJSONArray("intervals"); }
    private void coachStart() {
        JSONObject c = coach; if (c == null) return;
        if (points.isEmpty()) {
            String hello = c.optString("hello", ""); if (!hello.isEmpty()) say(hello);
            JSONArray iv = intervals(); if (iv != null && iv.length() > 0) { ivIndex = 0; ivStartDist = cDist; ivStartTime = cMoving; say(iv.optJSONObject(0).optString("say", "")); }
        }
    }
    /** Called for every fix: keeps the totals and speaks when a mark is passed. */
    private void coachStep(double[] p, boolean speak) {
        JSONObject c = coach; if (c == null) return;
        double maxSpeed = c.optDouble("maxSpeed", 12);
        if (p[4] > 40) return;
        if (cPrev != null && cPrev[6] == p[6]) {
            double dt = (p[0] - cPrev[0]) / 1000; if (dt <= 0) return;
            double d = hav(cPrev[1], cPrev[2], p[1], p[2]);
            if (d / dt > maxSpeed) return;
            // standing still = slower than `still` m/s over the last 10 seconds (auto-pause), the same rule as the app
            while (win.size() > 1 && p[0] - win.get(1)[0] >= 10000) win.remove(0);
            double[] w0 = win.isEmpty() ? cPrev : win.get(0);
            double span = (p[0] - w0[0]) / 1000, v = span > 0 ? hav(w0[1], w0[2], p[1], p[2]) / span : 0;
            if (span < 3 || v >= c.optDouble("still", 0.5)) { cDist += d; cMoving += Math.min(60, dt); }
            win.add(p);
        } else { win.clear(); win.add(p); }
        cPrev = p;
        if (!speak) { double e = c.optDouble("everyM", 0); nextDist = e > 0 ? (Math.floor(cDist / e) + 1) * e : 0; double t = c.optDouble("everyS", 0); nextTime = t > 0 ? (Math.floor(cMoving / t) + 1) * t : 0; return; }
        double everyM = c.optDouble("everyM", 0), everyS = c.optDouble("everyS", 0);
        boolean mark = false;
        if (everyM > 0) { if (nextDist <= 0) nextDist = everyM; if (cDist >= nextDist) { mark = true; while (nextDist <= cDist) nextDist += everyM; } }
        if (everyS > 0) { if (nextTime <= 0) nextTime = everyS; if (cMoving >= nextTime) { mark = true; while (nextTime <= cMoving) nextTime += everyS; } }
        if (mark) {
            StringBuilder b = new StringBuilder();
            b.append(km(Math.floor(cDist / 10) * 10)).append(". Time ").append(clock(cMoving)).append(".");
            String pc = pace(cDist > 50 ? cMoving / (cDist / 1000) : 0); if (!pc.isEmpty() && c.optBoolean("pace", true)) b.append(" Average pace ").append(pc).append(".");
            say(b.toString()); updateNotice();
        }
        double goalM = c.optDouble("goalM", 0), goalS = c.optDouble("goalS", 0);
        if (!halfSaid && ((goalM > 0 && cDist >= goalM / 2) || (goalS > 0 && cMoving >= goalS / 2))) { halfSaid = true; say("Halfway to your goal."); }
        if (!goalSaid && ((goalM > 0 && cDist >= goalM) || (goalS > 0 && cMoving >= goalS))) { goalSaid = true; say("Goal reached. Well done!"); }
        JSONArray iv = intervals();
        if (iv != null && ivIndex >= 0 && ivIndex < iv.length()) {
            JSONObject step = iv.optJSONObject(ivIndex);
            double m = step.optDouble("m", 0), s = step.optDouble("s", 0);
            boolean done = (m > 0 && cDist - ivStartDist >= m) || (s > 0 && (cMoving - ivStartTime) >= s);
            if (done) {
                ivIndex++; ivStartDist = cDist; ivStartTime = cMoving;
                if (ivIndex < iv.length()) say(iv.optJSONObject(ivIndex).optString("say", ""));
                else say(c.optString("ivDone", "Workout complete. Well done! You can walk to cool down."));
            }
        }
    }
    private void updateNotice() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Intent open = new Intent(this, MainActivity.class); open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new NotificationCompat.Builder(this, "run").setSmallIcon(android.R.drawable.ic_menu_mylocation)
                    .setContentTitle("Internot AI is recording").setContentText(String.format(Locale.UK, "%.2f km · %s", cDist / 1000, clock(cMoving)))
                    .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(pi).setPriority(NotificationCompat.PRIORITY_LOW).build();
            if (nm != null) nm.notify(41, n);
        } catch (Exception ignored) { }
    }
    /** Pause and resume, said out loud. */
    void sayPause(boolean paused) { if (coach != null) say(paused ? "Paused." : "Resumed."); }
    static RunService instance;

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
