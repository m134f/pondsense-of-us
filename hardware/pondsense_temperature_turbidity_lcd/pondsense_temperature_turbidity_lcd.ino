#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ArduinoJson.h>
#include <time.h>
#include "device_secrets.h"
#include "server_ca_cert.h"

const char* API_URL = "https://pondsense-of-us.onrender.com/api/v1/sensors/measurements";

constexpr int TURBIDITY_PIN = 34;
constexpr int TEMPERATURE_PIN = 4;
constexpr int PH_PIN = 35;
constexpr float PH_CAL_VOLTAGE_4_1 = 2.29f;
constexpr float PH_CAL_VOLTAGE_6_8 = 1.80f;
constexpr float PH_CAL_VOLTAGE_9_1 = 1.39f;
// Enable only when a real normally-open immersion switch is installed.
constexpr bool USE_WATER_SWITCH = false;
constexpr int WATER_SWITCH_PIN = 27;
// Continuous mode assumes fixed submerged installation, not detected immersion.
bool waterConfirmed = true;

bool hasWaterSample() {
  return USE_WATER_SWITCH ? digitalRead(WATER_SWITCH_PIN) == LOW : waterConfirmed;
}

void checkWaterConfirmation() {
  // Optional pause/resume only; no serial command is required at startup.
  while (Serial.available()) {
    char command = Serial.read();
    if (command == 'W' || command == 'w') {
      waterConfirmed = true;
      Serial.println("Continuous monitoring resumed. Keep probes submerged.");
    } else if (command == 'D' || command == 'd') {
      waterConfirmed = false;
      Serial.println("Water test stopped. Uploads paused.");
    }
  }
}
constexpr int SENSOR_SAMPLE_COUNT = 10;
constexpr unsigned long SEND_INTERVAL_MS = 5000;
constexpr unsigned long WIFI_RETRY_MS = 15000;
constexpr uint16_t HTTP_TIMEOUT_MS = 60000;

LiquidCrystal_I2C lcd(0x27, 20, 4);
OneWire oneWire(TEMPERATURE_PIN);
DallasTemperature temperatureSensor(&oneWire);
WiFiClientSecure secureClient;
unsigned long lastSentAt = 0;
unsigned long lastWifiAttemptAt = 0;

void showLine(int row, const String& message) {
  lcd.setCursor(0, row);
  lcd.print(message.substring(0, 20));
  for (int index = min((int)message.length(), 20); index < 20; index++) lcd.print(' ');
}

int readTurbidityRaw() {
  uint32_t total = 0;
  for (int sample = 0; sample < SENSOR_SAMPLE_COUNT; sample++) {
    total += analogRead(TURBIDITY_PIN);
    delay(20);
  }
  return total / SENSOR_SAMPLE_COUNT;
}

float readTemperatureC() {
  DeviceAddress sensorAddress;
  if (temperatureSensor.getDeviceCount() == 0 || !temperatureSensor.getAddress(sensorAddress, 0)) {
    Serial.println("DS18B20 not detected on GPIO 4. Check VCC, GND, DATA, and pull-up.");
    return NAN;
  }
  temperatureSensor.requestTemperatures();
  float value = temperatureSensor.getTempCByIndex(0);
  if (value == DEVICE_DISCONNECTED_C || value == 85.0f || value < -10.0f || value > 60.0f) {
    Serial.printf("DS18B20 returned invalid temperature: %.2f C\n", value);
    return NAN;
  }
  Serial.printf("DS18B20 temperature: %.2f C\n", value);
  return value;
}

float readPhVoltage() {
  uint32_t totalMillivolts = 0;
  for (int sample = 0; sample < SENSOR_SAMPLE_COUNT; sample++) {
    totalMillivolts += analogReadMilliVolts(PH_PIN);
    delay(10);
  }
  return (totalMillivolts / (float)SENSOR_SAMPLE_COUNT) / 1000.0f;
}

float phFromCalibratedVoltage(float voltage) {
  if (!isfinite(voltage) || voltage < PH_CAL_VOLTAGE_9_1 || voltage > PH_CAL_VOLTAGE_4_1) return NAN;
  if (voltage >= PH_CAL_VOLTAGE_6_8) {
    return 4.1f + (voltage - PH_CAL_VOLTAGE_4_1) * ((6.8f - 4.1f) / (PH_CAL_VOLTAGE_6_8 - PH_CAL_VOLTAGE_4_1));
  }
  return 6.8f + (voltage - PH_CAL_VOLTAGE_6_8) * ((9.1f - 6.8f) / (PH_CAL_VOLTAGE_9_1 - PH_CAL_VOLTAGE_6_8));
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiAttemptAt && millis() - lastWifiAttemptAt < WIFI_RETRY_MS) return;
  lastWifiAttemptAt = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

String makeSample(int rawValue, float voltage, float temperatureC, float phVoltage, float ph, time_t sampledAt) {
  JsonDocument payload;
  payload["waterContactConfirmed"] = true;
  payload["waterContactSource"] = USE_WATER_SWITCH ? "switch" : "configured-submerged-installation";
  char readingId[40];
  snprintf(readingId, sizeof(readingId), "%llX-%08lX-%08lX", ESP.getEfuseMac(), millis(), esp_random());
  payload["clientReadingId"] = readingId;
  if (sampledAt >= 1700000000) {
    struct tm utcTime;
    gmtime_r(&sampledAt, &utcTime);
    char timestamp[25];
    strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utcTime);
    payload["sampledAt"] = timestamp;
  }
  JsonArray verified = payload["verifiedParameters"].to<JsonArray>();
  if (!isnan(temperatureC)) verified.add("temperature");
  if (!isnan(ph)) verified.add("ph");
  payload["rawValue"] = rawValue;
  payload["voltage"] = voltage;
  if (isnan(temperatureC)) payload["temperatureC"] = nullptr;
  else payload["temperatureC"] = temperatureC;
  if (isnan(ph)) payload["ph"] = nullptr;
  else payload["ph"] = ph;
  payload["phVoltage"] = phVoltage;
  String body;
  serializeJson(payload, body);
  return body;
}

bool sendTelemetry(const String& body) {
  if (WiFi.status() != WL_CONNECTED) {
    showLine(3, "WiFi offline");
    return false;
  }

  if (time(nullptr) < 1700000000) {
    showLine(3, "Waiting for clock");
    return false;
  }
  secureClient.setCACert(DEFAULT_API_CA_CERT);
  HTTPClient http;
  if (!http.begin(secureClient, API_URL)) {
    showLine(3, "Server URL error");
    return false;
  }
  http.setConnectTimeout(15000);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", SENSOR_API_KEY);

  showLine(3, "Server: Sending...");
  int statusCode = http.POST(body);
  String response = statusCode > 0 ? http.getString() : "";
  Serial.printf("Sensor upload HTTP status: %d (%s)\n", statusCode, http.errorToString(statusCode).c_str());
  if (statusCode > 0 && statusCode != 201) Serial.println(response);
  JsonDocument confirmation;
  bool validResponse = deserializeJson(confirmation, response) == DeserializationError::Ok;

  if (statusCode == 201 && validResponse && confirmation["saved"] == true &&
      confirmation["assigned"] == true && confirmation["telemetryId"].as<int>() > 0) {
    Serial.printf("Server accepted device #%d, telemetry #%d\n",
      confirmation["deviceId"].as<int>(), confirmation["telemetryId"].as<int>());
    showLine(3, "Updated device #" + String(confirmation["deviceId"].as<int>()));
  } else if (statusCode == 401) {
    showLine(3, "Server: Key invalid");
  } else if (statusCode == 409) {
    showLine(3, "Server: Not assigned");
  } else if (statusCode == HTTPC_ERROR_READ_TIMEOUT) {
    showLine(3, "Server: Timed out");
  } else {
    showLine(3, "Server: Error " + String(statusCode));
  }
  http.end();
  return statusCode == 201 && validResponse && confirmation["saved"] == true &&
    confirmation["assigned"] == true && confirmation["telemetryId"].as<int>() > 0;
}

void setup() {
  Serial.begin(115200);
  // Dry-contact float switch at probe height: closed to GND only when submerged.
  if (USE_WATER_SWITCH) pinMode(WATER_SWITCH_PIN, INPUT_PULLUP);
  Serial.println("Automatic monitoring starts at power-on. Keep probes submerged; this mode cannot detect air. Optional D pauses, W resumes.");
  analogReadResolution(12);
  analogSetPinAttenuation(TURBIDITY_PIN, ADC_11db);
  analogSetPinAttenuation(PH_PIN, ADC_11db);
  temperatureSensor.begin();
  temperatureSensor.setResolution(12);
  Serial.printf("DS18B20 devices found: %d\n", temperatureSensor.getDeviceCount());
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  showLine(0, "PondSense of Us");
  connectWifi();
  configTime(0, 0, "pool.ntp.org");
}

void loop() {
  connectWifi();
  static unsigned long wetSince = 0;
  checkWaterConfirmation();
  if (!hasWaterSample()) {
    wetSince = 0;
    showLine(1, USE_WATER_SWITCH ? "Waiting for water" : "Submerge probes");
    showLine(2, USE_WATER_SWITCH ? "Check water switch" : "Serial: W=start");
    showLine(3, "Upload paused");
    delay(200);
    return;
  }
  if (!wetSince) wetSince = millis();
  if (millis() - wetSince < 2000) { delay(100); return; }
  // One sample per upload cycle: LCD and payload use the same snapshot until the next cycle.
  if (lastSentAt != 0 && millis() - lastSentAt < SEND_INTERVAL_MS) { delay(50); return; }
  lastSentAt = millis();
  int rawValue = readTurbidityRaw();
  float voltage = rawValue * (3.3f / 4095.0f);
  float temperatureC = roundf(readTemperatureC() * 10.0f) / 10.0f;
  float phVoltage = readPhVoltage();
  float ph = roundf(phFromCalibratedVoltage(phVoltage) * 100.0f) / 100.0f;
  time_t sampledAt = time(nullptr);
  checkWaterConfirmation();
  if (!hasWaterSample()) { wetSince = 0; return; }

  if (sampledAt >= 1700000000) {
    time_t philippineTime = sampledAt + 8 * 60 * 60;
    struct tm sampleTime;
    gmtime_r(&philippineTime, &sampleTime);
    char sampleLabel[21];
    strftime(sampleLabel, sizeof(sampleLabel), "Sample %H:%M:%S PHT", &sampleTime);
    showLine(0, sampleLabel);
  } else showLine(0, "Clock not synced");
  String phText = isnan(ph) ? "pH: --" : "pH: " + String(ph, 2);
  String tempText = isnan(temperatureC)
    ? (temperatureSensor.getDeviceCount() == 0 ? "T:No probe" : "T:Check probe")
    : "T:" + String(temperatureC, 1) + "C";
  showLine(1, phText + " " + tempText);
  // Display the same provisional conversion as the dashboard; calibration is still required.
  int estimatedNtu = roundf(constrain((1.0f - rawValue / 4095.0f) * 250.0f, 0.0f, 250.0f));
  showLine(2, "Turb: ~" + String(estimatedNtu) + " NTU est");

  String body = makeSample(rawValue, voltage, temperatureC, phVoltage, ph, sampledAt);
  Serial.println("Sample displayed on LCD and queued for upload: " + body);
  if (WiFi.status() == WL_CONNECTED) {
    sendTelemetry(body);
  } else {
    showLine(3, "WiFi offline");
  }
  delay(500);
}
