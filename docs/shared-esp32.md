# Shared ESP32 setup and rollout

## Identify the existing board without exposing a key

1. On the physical board, open Arduino IDE's Serial Monitor at 115200 baud. The updated sketch prints `ESP32 Hardware ID:` on reset. To read the ID **before flashing**, note the USB port from Arduino IDE, close Serial Monitor, and run Espressif's installed `esptool.exe --chip esp32 --port COMx read-mac` (replace `COMx` and use the actual board family). This reads the factory MAC and does not write flash. The Arduino sketch prints the eFuse bytes as a little-endian integer: reverse the order of the six MAC byte pairs and concatenate them, keeping leading zeros. For example, `AA:BB:CC:11:22:33` becomes `332211CCBBAA`. The existing sketch used the same integer as its saved reading ID prefix.
2. On the currently running sketch, find an earlier `Server accepted device #N, telemetry #M` line. Verify that the device number and eFuse ID correspond to the same physical board. Do not open, print, or share the firmware secrets file, key, or key hash. Verify an existing saved upload using only its device ID, telemetry ID and eFuse prefix. Do not infer hardware from credential counts or old device names.
3. In the updated Admin Console, open **Devices → Register Hardware**. Enter the name and verified eFuse ID. To reuse the current key, enter the **Existing credential ID** and confirm operator verification. The server checks for a matching saved upload and leaves the stored hash unchanged. If it cannot verify the record, stop and confirm the board and the historical upload; do not guess a credential ID. For a genuinely new board, leave that field blank and copy the new key once.

An authorized operator with read-only database access can verify the saved telemetry ID from step 2 without selecting any credentials:

```sql
SELECT id AS telemetry_id, device_id AS credential_id,
       LPAD(UPPER(SUBSTRING_INDEX(client_reading_id, '-', 1)), 12, '0') AS board_id,
       recorded_at
FROM sensor_telemetry
WHERE id = ?;
```

Bind the telemetry ID in the database client. Confirm the returned board ID and credential ID against the physical board and Serial output; if they disagree or the prefix is missing, do not adopt the record.

## Arduino IDE and wiring

1. Open `hardware/pondsense_temperature_turbidity_lcd/pondsense_temperature_turbidity_lcd.ino` with its companion headers in the same folder. Select the installed ESP32 core, the actual matching board, and its USB port. The sketch uses ArduinoJson, OneWire, DallasTemperature, and LiquidCrystal_I2C.
2. Keep the existing private `device_secrets.h`. If creating an isolated setup, use `device_secrets.h.example` as the template and enter Wi-Fi credentials and the board key privately. Keep `server_ca_cert.h` in place; staging needs an authorized HTTPS API URL and the matching trusted CA. Do not disable TLS verification. The default host is the production API; override it for staging before uploading.
3. The sketch keeps the existing wiring and calibration: pH analog signal GPIO35; turbidity analog signal GPIO34; DS18B20 data GPIO4; LCD SDA GPIO21 and SCL GPIO22, I2C address `0x27`, 20×4. Keep the existing power, grounds, signal conditioning, and pull-up arrangements. GPIO27 is only for the optional configured immersion switch and remains disabled by default. Never bypass existing level shifting or feed a 5 V signal into an ESP32 GPIO.
4. The release sketch does not read or upload DO. Keep the DO interface disconnected and do not flash a prior DO-enabled build. Live DO stays missing, never zero; measured manual DO entry remains available. Integrating DO after calibration is a separate firmware change and bench test.
5. Verify in Arduino IDE, upload once, open Serial Monitor at 115200, and confirm the ID, Wi-Fi, and successful V2 upload after assignment. With the probes installed, compare an LCD reading to the matching saved telemetry ID and verify uncalibrated/missing values stay missing.

## Move the board

1. In Devices, end the current assignment and wait for confirmation. Power down and physically move the monitor and probes.
2. Install the probes in the next fishpen, choose that farmer/fishpen in Devices, and confirm the board is physically there before activating the new assignment.
3. Power on the board or resume monitoring. The sketch fetches the active assignment before each uploadable sample. It never re-labels or re-queues an older sample. The server rejects old assignment IDs even if the key is still valid. No reflash or key change is required for a move.
4. Check both farmer accounts: the new farmer receives new uploads; the previous farmer sees their saved records and retains Manual Analysis and Harvest Management. Values without a known historical fishpen are not backfilled.

## Migration, staging, and rollback

Use the [unified production release plan](unified-production-release.md) for deployment approval and the SMS cutover.

- On a restored, isolated database, run `npm run db:hardware:local` with loopback MySQL explicitly configured. For a fresh local test database, initialize the base schema then run `npm run db:prepare:local`. Normal startup only validates: it never applies this migration.
- The migration adds the hardware registry, assignment ledger and active assignment uniqueness constraints, along with nullable telemetry and SMS attribution fields and an optional owner SMS number per fishpen. No existing user, reading, historical fishpen, or key is updated by the migration.
- Before production approval, restore and verify a backup separately, confirm the exact physical ID and current key record, compile for the actual board, and validate staging with the physical hardware moving between two disposable farmer accounts. Verify the API startup check and reconcile table/record counts before and after.
- On authorized cutover, stop old firmware uploads. An operator explicitly applies the additive migration before the matching backend starts. Keep hardware uploads paused with `PONDSENSE_PAUSE_HARDWARE_UPLOADS=true` until the V2 backend, frontend, credential adoption and physical placement are ready. V1 uploads are rejected by the new backend. Release the pause and verify isolation using authorized test accounts and a mock or disabled SMS sender on staging only.
- If verification fails, pause ingestion and physically disconnect the board. Preserve the assignment ledger and all new readings. Do not drop tables or restore a backup over production as routine rollback. Do not re-enable legacy owner-based uploads after a board move; an earlier backend does not enforce the current assignment. Resume V2 ingestion only after attribution and compatibility are reverified.
