package org.internot.app;

import android.Manifest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import com.getcapacitor.JSArray;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Links phones that are close to each other with no internet, using Google's Nearby Connections
 * (Bluetooth, Bluetooth Low Energy and shared Wi-Fi). Every phone both announces itself and looks
 * for others; connections are accepted automatically because the messages are encrypted by the app.
 */
@CapacitorPlugin(
    name = "Nearby",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "bluetooth", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT" }),
        @Permission(alias = "wifi", strings = { "android.permission.NEARBY_WIFI_DEVICES" })
    }
)
public class NearbyPlugin extends Plugin {

    private static final String SERVICE = "org.internot.mesh";
    private final String token = UUID.randomUUID().toString().substring(0, 8);
    private final Set<String> asked = new HashSet<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ConnectionsClient client;
    private boolean running = false;
    private String myName = "";
    // Sending maps and models to a linked phone: names of linked phones, offers waiting for a yes, files on the way.
    private static final String CTRL = "\u0001IF|";
    private final Map<String, String> names = new ConcurrentHashMap<>();
    private final Map<String, String> linked = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> outgoing = new ConcurrentHashMap<>();
    private final Map<String, JSONObject> incoming = new ConcurrentHashMap<>();
    private final Map<Long, String> payloadOffer = new ConcurrentHashMap<>();
    private final Map<Long, Payload> filePayloads = new ConcurrentHashMap<>();

    private String[] needed() {
        if (Build.VERSION.SDK_INT >= 33) return new String[] { "location", "bluetooth", "wifi" };
        if (Build.VERSION.SDK_INT >= 31) return new String[] { "location", "bluetooth" };
        return new String[] { "location" };
    }

    private boolean granted() {
        for (String alias : needed()) if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        return true;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!granted()) {
            requestPermissionForAliases(needed(), call, "afterPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (granted()) begin(call);
        else call.reject("Permission was not given. Allow Nearby devices and Location for Internot AI in the phone settings.");
    }

    private void begin(final PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }
        try {
            if (client == null) client = Nearby.getConnectionsClient(getContext());
            final String name = token + "|" + call.getString("name", "Internot");
            myName = name;
            final Strategy strategy = Strategy.P2P_CLUSTER;
            client
                .startAdvertising(name, SERVICE, lifecycle, new AdvertisingOptions.Builder().setStrategy(strategy).build())
                .addOnSuccessListener(a ->
                    client
                        .startDiscovery(SERVICE, discovery, new DiscoveryOptions.Builder().setStrategy(strategy).build())
                        .addOnSuccessListener(d -> {
                            running = true;
                            call.resolve();
                        })
                        .addOnFailureListener(e -> {
                            client.stopAdvertising();
                            call.reject("Could not look for nearby phones: " + e.getMessage());
                        })
                )
                .addOnFailureListener(e -> call.reject("Nearby linking could not start on this phone: " + e.getMessage()));
        } catch (Exception e) {
            call.reject("Nearby linking is not available on this phone: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (client != null) {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
        running = false;
        asked.clear();
        call.resolve();
    }

    @PluginMethod
    public void send(final PluginCall call) {
        String endpoint = call.getString("endpoint");
        String data = call.getString("data");
        if (client == null || endpoint == null || data == null) {
            call.reject("Not linked");
            return;
        }
        client
            .sendPayload(endpoint, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)))
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage()));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String endpoint = call.getString("endpoint");
        if (client != null && endpoint != null) client.disconnectFromEndpoint(endpoint);
        call.resolve();
    }

    private void emit(String event, String endpoint, String data) {
        JSObject o = new JSObject();
        o.put("endpoint", endpoint);
        if (data != null) o.put("data", data);
        notifyListeners(event, o);
    }

    private void connect(final String endpointId, final int triesLeft) {
        if (!running || client == null) return;
        client
            .requestConnection(myName.isEmpty() ? token : myName, endpointId, lifecycle)
            .addOnFailureListener(e -> {
                if (triesLeft > 0 && asked.contains(endpointId)) handler.postDelayed(() -> connect(endpointId, triesLeft - 1), 3000);
                else asked.remove(endpointId);
            });
    }

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(String endpointId, Payload payload) {
            if (payload.getType() == Payload.Type.FILE) { filePayloads.put(payload.getId(), payload); return; }
            byte[] bytes = payload.getType() == Payload.Type.BYTES ? payload.asBytes() : null;
            if (bytes == null) return;
            String s = new String(bytes, StandardCharsets.UTF_8);
            if (s.startsWith(CTRL)) { control(endpointId, s.substring(CTRL.length())); return; }
            emit("data", endpointId, s);
        }

        @Override
        public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) { fileUpdate(endpointId, update); }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
            String n = info.getEndpointName();
            int bar = n.indexOf('|');
            if (bar > 0) names.put(endpointId, n.substring(bar + 1));
            client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(String endpointId, ConnectionResolution result) {
            if (result.getStatus().isSuccess()) { linked.put(endpointId, "1"); emit("connected", endpointId, null); }
            else asked.remove(endpointId);
        }

        @Override
        public void onDisconnected(String endpointId) {
            asked.remove(endpointId);
            linked.remove(endpointId);
            emit("disconnected", endpointId, null);
        }
    };

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(String endpointId, DiscoveredEndpointInfo info) {
            String other = info.getEndpointName();
            int bar = other.indexOf('|');
            String theirs = bar > 0 ? other.substring(0, bar) : other;
            if (bar > 0) names.put(endpointId, other.substring(bar + 1));
            // Only the phone with the smaller token asks, so two requests never cross.
            if (token.compareTo(theirs) >= 0 || !asked.add(endpointId)) return;
            connect(endpointId, 3);
        }

        @Override
        public void onEndpointLost(String endpointId) {
            asked.remove(endpointId);
        }
    };

    /* ---------- maps and models to a linked phone ---------- */

    @PluginMethod
    public void peers(PluginCall call) {
        JSArray a = new JSArray();
        for (String ep : linked.keySet()) {
            JSObject o = new JSObject();
            o.put("endpoint", ep);
            o.put("name", names.containsKey(ep) ? names.get(ep) : "Nearby phone");
            a.put(o);
        }
        JSObject r = new JSObject();
        r.put("peers", a);
        r.put("on", running);
        call.resolve(r);
    }

    private void ctrl(String endpoint, String s) {
        client.sendPayload(endpoint, Payload.fromBytes((CTRL + s).getBytes(StandardCharsets.UTF_8)));
    }

    /** Offers a file to a linked phone. It is sent once the other person says yes. */
    @PluginMethod
    public void sendFile(PluginCall call) {
        String endpoint = call.getString("endpoint"), path = call.getString("path");
        if (client == null || endpoint == null || path == null || !new File(path).exists()) { call.reject("Not linked, or the file is missing"); return; }
        try {
            JSONObject o = new JSONObject();
            String id = UUID.randomUUID().toString().substring(0, 12);
            o.put("id", id);
            o.put("kind", call.getString("kind", ""));
            o.put("name", call.getString("name", ""));
            o.put("file", call.getString("file", new File(path).getName()));
            o.put("size", new File(path).length());
            o.put("from", myName.contains("|") ? myName.substring(myName.indexOf('|') + 1) : "");
            outgoing.put(id, new JSONObject(o.toString()).put("path", path).put("endpoint", endpoint));
            ctrl(endpoint, "offer|" + o.toString());
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void answerFile(PluginCall call) {
        String id = call.getString("id", ""), endpoint = call.getString("endpoint", "");
        boolean yes = Boolean.TRUE.equals(call.getBoolean("accept", false));
        if (client == null) { call.reject("Not linked"); return; }
        if (!yes) incoming.remove(id);
        ctrl(endpoint, (yes ? "accept|" : "decline|") + id);
        call.resolve();
    }

    private void control(String endpoint, String s) {
        try {
            int bar = s.indexOf('|');
            String verb = bar > 0 ? s.substring(0, bar) : s, rest = bar > 0 ? s.substring(bar + 1) : "";
            if ("offer".equals(verb)) {
                JSONObject o = new JSONObject(rest);
                incoming.put(o.getString("id"), o);
                JSObject e = new JSObject(o.toString());
                e.put("endpoint", endpoint);
                notifyListeners("fileOffer", e);
            } else if ("accept".equals(verb) || "decline".equals(verb)) {
                JSONObject o = outgoing.get(rest);
                if (o == null) return;
                JSObject e = new JSObject();
                e.put("id", rest);
                if ("decline".equals(verb)) { outgoing.remove(rest); e.put("phase", "declined"); notifyListeners("fileProgress", e); return; }
                Payload p = Payload.fromFile(new File(o.getString("path")));
                payloadOffer.put(p.getId(), rest);
                ctrl(endpoint, "payload|" + rest + "|" + p.getId());
                client.sendPayload(endpoint, p);
                e.put("phase", "sending");
                notifyListeners("fileProgress", e);
            } else if ("payload".equals(verb)) {
                String[] a = rest.split("\\|");
                if (a.length == 2 && incoming.containsKey(a[0])) payloadOffer.put(Long.parseLong(a[1]), a[0]);
            }
        } catch (Exception ignored) {}
    }

    private void fileUpdate(String endpoint, PayloadTransferUpdate u) {
        String id = payloadOffer.get(u.getPayloadId());
        if (id == null) return;
        boolean receiving = incoming.containsKey(id);
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("done", u.getBytesTransferred());
        e.put("total", u.getTotalBytes());
        e.put("dir", receiving ? "in" : "out");
        int st = u.getStatus();
        if (st == PayloadTransferUpdate.Status.IN_PROGRESS) { e.put("phase", "moving"); notifyListeners("fileProgress", e); return; }
        payloadOffer.remove(u.getPayloadId());
        if (st != PayloadTransferUpdate.Status.SUCCESS) {
            incoming.remove(id); outgoing.remove(id); filePayloads.remove(u.getPayloadId());
            e.put("phase", "failed");
            notifyListeners("fileProgress", e);
            return;
        }
        if (!receiving) { outgoing.remove(id); e.put("phase", "sent"); notifyListeners("fileProgress", e); return; }
        final JSONObject o = incoming.remove(id);
        final Payload p = filePayloads.remove(u.getPayloadId());
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                File dir = new File(getContext().getFilesDir(), "packs/dl");
                dir.mkdirs();
                File out = new File(dir, o.optString("file", "received").replaceAll("[^A-Za-z0-9._-]", "_"));
                ParcelFileDescriptor pfd = p.asFile().asParcelFileDescriptor();
                try (InputStream in = new FileInputStream(pfd.getFileDescriptor()); OutputStream w = new FileOutputStream(out)) {
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = in.read(buf)) > 0) w.write(buf, 0, n);
                } finally {
                    try { pfd.close(); } catch (Exception ignored) {}
                    try { if (p.asFile().asUri() != null) getContext().getContentResolver().delete(p.asFile().asUri(), null, null); } catch (Exception ignored) {}
                }
                if (out.length() != o.optLong("size", -1)) { out.delete(); throw new Exception("incomplete"); }
                JSObject r = new JSObject(o.toString());
                r.put("phase", "received");
                r.put("path", out.getAbsolutePath());
                notifyListeners("fileProgress", r);
            } catch (Exception ex) {
                JSObject r = new JSObject();
                r.put("id", id);
                r.put("phase", "failed");
                notifyListeners("fileProgress", r);
            }
        });
    }
}
