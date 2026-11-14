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
import java.nio.charset.StandardCharsets;
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
            .requestConnection(token, endpointId, lifecycle)
            .addOnFailureListener(e -> {
                if (triesLeft > 0 && asked.contains(endpointId)) handler.postDelayed(() -> connect(endpointId, triesLeft - 1), 3000);
                else asked.remove(endpointId);
            });
    }

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(String endpointId, Payload payload) {
            byte[] bytes = payload.getType() == Payload.Type.BYTES ? payload.asBytes() : null;
            if (bytes != null) emit("data", endpointId, new String(bytes, StandardCharsets.UTF_8));
        }

        @Override
        public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {}
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
            client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(String endpointId, ConnectionResolution result) {
            if (result.getStatus().isSuccess()) emit("connected", endpointId, null);
            else asked.remove(endpointId);
        }

        @Override
        public void onDisconnected(String endpointId) {
            asked.remove(endpointId);
            emit("disconnected", endpointId, null);
        }
    };

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(String endpointId, DiscoveredEndpointInfo info) {
            String other = info.getEndpointName();
            int bar = other.indexOf('|');
            String theirs = bar > 0 ? other.substring(0, bar) : other;
            // Only the phone with the smaller token asks, so two requests never cross.
            if (token.compareTo(theirs) >= 0 || !asked.add(endpointId)) return;
            connect(endpointId, 3);
        }

        @Override
        public void onEndpointLost(String endpointId) {
            asked.remove(endpointId);
        }
    };
}
