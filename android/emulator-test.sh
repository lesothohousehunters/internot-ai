#!/bin/bash
# Installs the test build on an Android emulator, lets the app test itself, and saves what it reports.
mkdir -p test-out
adb install -r internot-ai-test.apk > test-out/install.txt 2>&1 || { echo "INSTALL FAILED" >> test-out/report.txt; cat test-out/install.txt; exit 0; }
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION BLUETOOTH_SCAN BLUETOOTH_ADVERTISE BLUETOOTH_CONNECT NEARBY_WIFI_DEVICES CAMERA; do adb shell pm grant org.internot.app android.permission.$p || true; done
adb logcat -G 16M || true
adb logcat -c
adb shell am start -n org.internot.app/.MainActivity
adb shell dumpsys package com.google.android.webview | grep -m1 versionName > test-out/webview.txt 2>&1 || true
seen=0
for i in $(seq 1 2600); do
  sleep 2
  adb logcat -d -v time 2>/dev/null | grep -E "INTERNOT-TEST|Capacitor.*(E/|rror)|AndroidRuntime|chromium.*(Uncaught|rror)" | cut -c1-1500 > test-out/report.txt
  n=$(grep -c "INTERNOT-TEST shot" test-out/report.txt)
  if [ "$n" -gt "$seen" ]; then seen=$n; sleep 2; adb exec-out screencap -p > test-out/shot-$n.png; fi
  grep -q "INTERNOT-TEST done" test-out/report.txt && break
done
adb exec-out screencap -p > test-out/shot-end.png
cat test-out/webview.txt test-out/report.txt
exit 0
