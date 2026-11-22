package org.internot.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NearbyPlugin.class);
        registerPlugin(BrainPlugin.class);
        registerPlugin(PacksPlugin.class);
        registerPlugin(RunPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
