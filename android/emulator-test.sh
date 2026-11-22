#!/bin/bash
# Installs the test build on an Android emulator, lets the app test itself, and saves what it reports.
mkdir -p test-out
adb install -r internot-ai-test.apk > test-out/install.txt 2>&1 || { echo "INSTALL FAILED" >> test-out/report.txt; cat test-out/install.txt; exit 0; }
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION BLUETOOTH_SCAN BLUETOOTH_ADVERTISE BLUETOOTH_CONNECT NEARBY_WIFI_DEVICES CAMERA POST_NOTIFICATIONS; do adb shell pm grant org.internot.app android.permission.$p || true; done
adb shell cmd location set-location-enabled true || true
adb shell svc power stayon false || true
adb logcat -G 64M || true
adb logcat -c
adb shell am start -n org.internot.app/.MainActivity
adb shell dumpsys package com.google.android.webview | grep -m1 versionName > test-out/webview.txt 2>&1 || true

# Run and walk: once the app says run-start, walk about 1.6 km through Maseru with GPS fixes once a second
# (no internet involved), up and down a 30 m hill, and switch the screen off for about 70 seconds on the way.
feed() {
  for i in $(seq 1 900); do adb logcat -d 2>/dev/null | grep -q "INTERNOT-TEST run-start" && break; sleep 2; done
  python3 - <<'P' > test-out/fixes.txt
import math
lat, lon, out = -29.3155, 27.4790, []
for i in range(300):
    a = i / 300 * 2 * math.pi
    lat += 5.2 / 110574 * math.cos(a * 0.8); lon += 5.2 / 96800 * math.sin(a * 0.8 + 0.4)
    out.append(f"{lon:.7f} {lat:.7f} {1560 + 30 * math.sin(i / 300 * math.pi):.1f}")
print("\n".join(out))
P
  n=0
  while read -r lo la al; do
    n=$((n+1))
    adb emu geo fix "$lo" "$la" "$al" < /dev/null > /dev/null 2>&1
    if [ "$n" = 120 ]; then adb shell input keyevent KEYCODE_SLEEP < /dev/null; echo "screen off at fix $n" >> test-out/feed.txt; fi
    if [ "$n" = 190 ]; then adb shell input keyevent KEYCODE_WAKEUP < /dev/null; adb shell wm dismiss-keyguard < /dev/null; adb shell am start -n org.internot.app/.MainActivity < /dev/null > /dev/null; echo "screen on at fix $n" >> test-out/feed.txt; fi
    sleep 1
  done < test-out/fixes.txt
  echo "fed $n fixes" >> test-out/feed.txt
}
feed &
# The run video opens the share menu: close it again
( for i in $(seq 1 2400); do adb logcat -d 2>/dev/null | grep -q "INTERNOT-TEST run-back" && { adb shell input keyevent KEYCODE_BACK < /dev/null; break; }; sleep 2; done ) &

seen=0
for i in $(seq 1 3200); do
  sleep 2
  adb logcat -d -v time 2>/dev/null | grep -E "INTERNOT-TEST|Capacitor.*(E/|rror)|AndroidRuntime|chromium.*(Uncaught|rror)" | cut -c1-1500 > test-out/now.txt
  cat test-out/report.txt test-out/now.txt 2>/dev/null | awk '!seen[$0]++' > test-out/merged.txt && mv test-out/merged.txt test-out/report.txt   # keep lines even if the log rolls over
  n=$(grep -c "INTERNOT-TEST shot" test-out/report.txt)
  if [ "$n" -gt "$seen" ]; then seen=$n; sleep 2; adb exec-out screencap -p > test-out/shot-$n.png; fi
  grep -q "INTERNOT-TEST done" test-out/report.txt && break
done
adb exec-out screencap -p > test-out/shot-end.png
rm -f test-out/now.txt
adb shell dumpsys activity services org.internot.app | grep -i -m3 "RunService\|foreground" > test-out/services.txt 2>&1 || true
cat test-out/webview.txt test-out/feed.txt test-out/services.txt test-out/report.txt
exit 0
