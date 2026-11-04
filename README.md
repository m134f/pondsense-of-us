# PondSense of Us

## ESP32 temperature and turbidity monitoring

The updated sketch is `hardware/pondsense_temperature_turbidity_lcd/pondsense_temperature_turbidity_lcd.ino`. In Arduino IDE, install the ESP32 board package and the OneWire, DallasTemperature, ArduinoJson 7, and LiquidCrystal_I2C libraries. Copy `device_secrets.h.example` beside the sketch as `device_secrets.h`, then enter the Wi-Fi details and the one-time key supplied by an administrator. `device_secrets.h` is git-ignored. Never share its contents or put a device key in React code.

The older turbidity-only sketch also uses its own ignored `device_secrets.h` and example file. If its previous key was committed or shared, ask the administrator to provision a replacement device key before reflashing. Removing a secret from the current file does not erase it from Git history.

An administrator creates a device or assigns an existing device to a farmer in Admin Settings > Sensor devices. Existing device keys remain valid when reassigned. The ESP32 sends a combined temperature and turbidity reading to `/api/v1/sensors/measurements` every five seconds. The server stores it in `sensor_telemetry` under the assigned farmer. The dashboard polls every three seconds and marks a reading stale after 30 seconds. `Server: Updated` on the LCD requires a successful save confirmation from the API; it does not mean the farmer's browser is open or has finished its next poll.

Pin connections (ESP32 DevKit WROOM-32):

| Part | ESP32 pin | Notes |
| --- | --- | --- |
| TS-300B analog output | GPIO 34 | **Never exceed 3.3 V** at the GPIO. Use a suitable divider or level conditioner if the module is powered at 5 V. |
| DS18B20 data | GPIO 4 | Power from 3.3 V and GND. Add a 4.7 kOhm pull-up from data to 3.3 V unless the adapter already provides one. |
| 20x4 LCD SDA | GPIO 21 | Use an I2C level shifter if the LCD backpack pulls SDA to 5 V. |
| 20x4 LCD SCL | GPIO 22 | Use an I2C level shifter if the LCD backpack pulls SCL to 5 V. |
| All modules | GND | Connect grounds together. |

The LCD and dashboard display raw turbidity **ADC signal**, not NTU, until the probe is calibrated against known turbidity standards. The analog module can produce a signal in air; it cannot detect immersion reliably, so a nonzero signal does not prove that water was measured. Do not make a safe/dirty or fish-suitability decision from uncalibrated signal. A disconnected DS18B20 is sent as `null` and displayed as a sensor error, never as a sample temperature. If the LCD shows a temperature but the dashboard does not, check that the LCD says `Server: Updated` and that the dashboard's last-reading timestamp advances. Only temperature and turbidity are measured by this sketch. pH, dissolved oxygen, and ammonia are not implied to be live or zero. A full five-parameter fish recommendation still requires measured values for all five parameters through manual analysis or future sensors.

The new sketch includes the public Google Trust Services Root R4 certificate in `server_ca_cert.h`. This currently verifies the Render API certificate chain, so `device_secrets.h` needs only the private Wi-Fi details and device key. The sketch waits for NTP time and will not upload before the clock is set. If the API host changes its certificate chain, update the public CA from a trusted source and reflash the ESP32. The older turbidity-only sketch still needs a PEM CA in its private header. Use the admin device assignment screen to migrate old devices before relying on the new owner-scoped telemetry. Apply the database changes through normal startup migrations, or update the corresponding `sensor_telemetry` columns and `harvest_batches` table from `server/schema.sql` in the target MySQL database. Back up the database before any manual schema import; the full schema file contains seed data and is not intended as an incremental migration script.

## Fish harvesting

Farmers can open Harvests to record stocked batches, planned harvest dates, actual harvest weight, and optional selling price. Each batch belongs to the signed-in farmer. Days remaining are calculated from the farmer's chosen target date; this is a schedule, not a biological growth or yield prediction.

Full-stack capstone project for **A Digital Decision Support System for Fish Pond Management**.

## Tech Stack From The Paper

- Frontend: React.js, Vite, Tailwind CSS, Recharts, Lucide icons
- Backend: Node.js with Express.js
- Database: MySQL using `mysql2`
- Hardware: ESP32 sends owner-scoped sensor readings to the Express API

## How To Run In VS Code

1. Open this folder in VS Code.
2. Open the terminal in VS Code.
3. Run:

```bash
npm install
npm run dev
```

4. Open the web URL shown by Vite, usually:

```text
http://localhost:5173
```

The frontend can render without MySQL, but login, registration, device monitoring, harvest records, and server-backed history require a running database. Manual analysis can still be explored in guest mode.

## XAMPP MySQL Setup

1. Start Apache and MySQL in XAMPP.
2. Open `http://localhost/phpmyadmin`.
3. Create a database named `pondsense`.
4. Import `server/schema.sql`.
5. Copy `.env.example` to `.env`.
6. Use the usual XAMPP default settings:

```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=pondsense
```

7. Restart `npm run dev`.

The schema follows the Replit database blueprint:

- `users`: registered farmers/admin accounts
- `water_readings`: manual or ESP32 water quality readings
- `alerts`: warning/critical alerts generated per reading
- `corrective_action_log`: farmer notes on actions taken
- `fish_species`: the 8 fish species and optimal parameter ranges
- `admin_settings`: admin PIN and future system settings

## Why This Is A Decision Support System

PondSense does monitoring, but it also analyzes readings, scores fish suitability, detects risk, recommends corrective actions, provides feeding guidance, stores history, shows trends, and supports admin management.
