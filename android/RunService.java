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
        running = false;
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) { }
        try { if (out != null) out.close(); } catch (Exception ignored) { }
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
