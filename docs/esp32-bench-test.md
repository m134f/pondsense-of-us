# Local ESP32 bench test

No production deployment or database is needed. This release tests pH, DS18B20 temperature, calibrated turbidity, and the existing 20x4 I2C LCD. DO is not read, displayed on the LCD, or uploaded by this sketch. Keep the DO probe disconnected until calibration and a separate firmware review are complete.

## 1. Start the isolated bench

Run from the project root. Windows needs the project's Node dependencies, XAMPP's MariaDB/OpenSSL tools, and Arduino IDE. XAMPP does not need to be running. If installed elsewhere, set `PONDSENSE_BENCH_XAMPP` to its folder. Find this PC's private Wi-Fi IPv4 address with `ipconfig`; use it in place of the example if it has changed:

```powershell
node scripts/esp32-bench.mjs 192.168.1.37
```

- Start a **fresh hardware-mode bench** for release testing; do not resume an older DO-capable sketch or older bench database. If a prior web-only bench is using ports 5100, 5180 or 3310, stop it from its own launcher before starting this one. Keep this terminal open; it prints the local Admin login, temporary bench credentials, and the path to the generated Arduino sketch. Stop with Ctrl+C. `--resume "<bench state folder>"` is only for reusing this same release's bench and matching LAN IP/certificate.
- For a web-only preview, use `node scripts/esp32-bench.mjs 127.0.0.1 --resume "<bench state folder>" --web-only`. This preserves accounts without depending on the old LAN IP or ESP32 certificate. Hardware uploads are paused, even on the local backend, until the bench is restarted in hardware mode.
- The browser workspace is [local only](http://127.0.0.1:5180/admin/login). The board uses HTTPS to reach this PC on TCP 8443; only the two authenticated V2 hardware endpoints are available there. Use a trusted private Wi-Fi network where the board and PC can reach each other. Do not expose the port to the internet. If Windows blocks the connection, check the private-network firewall and Wi-Fi client isolation; do not disable the firewall or TLS verification.
- Use only bench accounts and the newly generated bench hardware key. No production key, Wi-Fi credential, or SMS provider token is required from the server. SMS is disabled in this environment.

## 2. Register and flash once

1. Connect the ESP32 using a USB **data** cable. Open **Tools → Port** in Arduino IDE and verify a new USB serial COM port appears. Bluetooth COM ports are not the ESP32. If nothing appears, try another known data cable and USB port, then check the USB serial driver for your board.
2. Get the board ID without showing a key: follow [the eFuse steps](shared-esp32.md#identify-the-existing-board-without-exposing-a-key) using `esptool read-mac`. Do not upload the old sketch just to identify the board.
3. Sign in to the bench Admin Console, create **Bench Farmer A / Test Pen A** and **Bench Farmer B / Test Pen B**, then log into each in separate browser profiles or sign out between sessions. Change their temporary passwords on first login. Use two disposable, different Philippine-format mobile numbers.
4. In **Devices → Register Hardware**, enter the physical board ID, leave **Existing credential ID** blank, and use **Copy Key** once. Open the generated Arduino sketch printed in the terminal. In its `device_secrets.h`, privately set the local Wi-Fi network, Wi-Fi password, and temporary **bench** hardware key. The sketch already includes its matching `bench_config.h` with the local HTTPS URL and CA.
5. Verify the wiring against the existing installation: pH signal GPIO35, turbidity signal GPIO34, DS18B20 data GPIO4, LCD SDA GPIO21/SCL GPIO22, address `0x27`, 20 columns by 4 rows. Preserve the power and signal conditioning. No pH/turbidity calibration constants, DS18B20 configuration, or immersion settings were changed. The optional GPIO27 switch remains disabled by default.
6. Select the exact board and new USB port in Arduino IDE. **Verify**, then **Upload**. Open Serial Monitor at **115200** baud. Confirm it prints the expected ESP32 Hardware ID and the local bench message. With no assignment, the LCD should show **Not assigned** once Wi-Fi and the clock are ready. No telemetry should be saved yet.

## 3. Compare one snapshot in three places

1. Put the three usual probes in the test water and let their readings settle. Use the operator's normal references within the established calibration ranges. Do not adjust constants to make a test pass.
2. Assign the board to **Test Pen A** only after it is physically there. Open Farmer A's **Monitoring** and wait for a reading. Record the displayed LCD sample time (PHT) and values. The Serial Monitor prints the same sample's UTC timestamp, pH, temperature, and calibrated turbidity, followed or preceded by its receipt ID on the adjacent line. If needed film the LCD briefly **without** capturing any credentials.
3. In **Admin → Devices → board name → Upload history**, match the **Telemetry ID** shown in Serial Monitor. Compare pH, temperature, and calibrated turbidity on that exact row. An LCD time in PHT is eight hours ahead of the UTC serial timestamp. Dashboard polling can show a newer snapshot, and display precision may differ; use the upload row for a definitive comparison.
4. A valid calibrated turbidity measurement should match the website NTU value. Outside the existing calibration span the firmware may show an estimate marked `est`; the saved calibrated NTU must be missing. Do not treat an estimate as a valid NTU reading.
5. Confirm **DO** is **Missing/Unavailable**, never 0, and there is no low-DO sensor action. In **Manual Analysis** confirm the DO field still exists; a measured manual DO may be reviewed and saved intentionally and must not fill the live DO card or trigger automatic SMS. Never enter a fabricated measurement.

6. Briefly remove the board's Wi-Fi access without moving the probes. Confirm uploads stop and Monitoring changes to stale/offline. On reconnect, confirm the next receipt is a fresh sample, not a backfill. Check the disconnected DS18B20 case with the board powered off before changing the wiring; it should return missing, not zero, after restart. A disconnected analog signal can float, so power down or use the serial `D` pause before removing a pH/turbidity probe.

## 4. Move the same board and key to Farmer B

1. Note a successful Telemetry ID in Test Pen A. In Admin select **Unassign Hardware** and confirm. Wait at least one normal upload cycle and confirm the LCD shows **Not assigned**, the saved telemetry ID does not advance, and the website no longer shows live readings for A. End the assignment before moving the probes.
2. Move and install the board at Test Pen B, then select **Assign Hardware**, choose Farmer B/Test Pen B, and confirm physical placement. **Do not use Replace Key, edit the sketch, or reflash.**
3. Confirm a new accepted ID reaches only B. In Admin Upload history, the earlier receipt remains attributed to A/Test Pen A and the new receipt belongs to B/Test Pen B. On A, check Session History for the earlier readings, and confirm B's data is absent. On B, confirm the date and measurements come from the new pen.
4. Unassign at the end, power off the ESP32, and stop the local bench. Keep only the test evidence required: board identifier, timestamp, Telemetry IDs, values/states, and pass/fail notes. Never include Wi-Fi secrets, API keys, cookies, or the bench TLS private key.

Before approval, record the exact board model/FQBN, the Arduino Verify result, both receipt IDs, the LCD-to-website comparison, Wi-Fi/power-loss behavior, and DO missing. In Admin verify that editing the SMS recipients shows the expected masked contacts to the matching farmer only. SMS stays disabled on this bench; use the automated mock sender for attribution and duplicate tests.

## Troubleshooting

- **Waiting for clock:** verify that the network permits NTP and use the existing time sync. Do not fake clock values.
- **Key or ID invalid:** verify that the selected board ID and private key both came from this same running bench. Do not replace a production key.
- **Assignment unavailable:** check the PC IP printed by the launcher, same Wi-Fi, current bench CA, and TCP 8443 access on the private network. If the bench was restarted, its old CA and key will not work.
- **Not assigned:** check Devices for an active farmer/fishpen assignment; this is expected while moving the board.
