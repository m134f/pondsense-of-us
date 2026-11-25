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

#if defined(PONDSENSE_BENCH) && (!defined(PONDSENSE_HARDWARE_API) || !defined(PONDSENSE_HARDWARE_CA))
#error "Bench testing requires a separate HTTPS API URL and trusted bench CA in device_secrets.h."
#endif
#ifndef PONDSENSE_HARDWARE_API
#define PONDSENSE_HARDWARE_API "https://pondsense-of-us.onrender.com/api/v2/hardware"
#endif
#ifndef PONDSENSE_HARDWARE_CA
#define PONDSENSE_HARDWARE_CA DEFAULT_API_CA_CERT
#endif
String hardwareChipId;

constexpr int TURBIDITY_PIN = 34;
constexpr int TEMPERATURE_PIN = 4;
constexpr int PH_PIN = 35;
constexpr float TURBIDITY_LOW_VOLTAGE = 2.90f;
constexpr float TURBIDITY_LOW_NTU = 5.0f;
constexpr float TURBIDITY_HIGH_VOLTAGE = 2.10f;
constexpr float TURBIDITY_HIGH_NTU = 40.0f;
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

float readTurbidityVoltage(int &rawValue) {
  uint32_t totalRaw = 0;
  uint32_t totalMillivolts = 0;
  for (int sample = 0; sample < SENSOR_SAMPLE_COUNT; sample++) {
    totalRaw += analogRead(TURBIDITY_PIN);
    totalMillivolts += analogReadMilliVolts(TURBIDITY_PIN);
    delay(20);
  }
  rawValue = totalRaw / SENSOR_SAMPLE_COUNT;
  return totalMillivolts / (1000.0f * SENSOR_SAMPLE_COUNT);
}

float turbidityFromCalibratedVoltage(float voltage) {
  if (!isfinite(voltage) || voltage < TURBIDITY_HIGH_VOLTAGE || voltage > TURBIDITY_LOW_VOLTAGE) return NAN;
  return TURBIDITY_LOW_NTU + (voltage - TURBIDITY_LOW_VOLTAGE) *
    (TURBIDITY_HIGH_NTU - TURBIDITY_LOW_NTU) / (TURBIDITY_HIGH_VOLTAGE - TURBIDITY_LOW_VOLTAGE);
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

String makeSample(int rawValue, float voltage, float turbidityNtu, float temperatureC, float phVoltage, float ph, time_t sampledAt, const String& assignment) {
  JsonDocument payload;
  payload["chipId"] = hardwareChipId;
  payload["assignmentId"] = assignment;
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
  if (!isnan(turbidityNtu)) verified.add("turbidity");
  payload["rawValue"] = rawValue;
  payload["voltage"] = voltage;
  if (!isnan(turbidityNtu)) payload["turbidityNtu"] = turbidityNtu;
  if (isnan(temperatureC)) payload["temperatureC"] = nullptr;
  else payload["temperatureC"] = temperatureC;
  if (isnan(ph)) payload["ph"] = nullptr;
  else payload["ph"] = ph;
  payload["phVoltage"] = phVoltage;
  String body;
  serializeJson(payload, body);
  return body;
}

String syncAssignment() {
  if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) return "";
  secureClient.setCACert(PONDSENSE_HARDWARE_CA);
  HTTPClient http;
  if (!http.begin(secureClient, String(PONDSENSE_HARDWARE_API) + "/assignment")) return "";
  http.setConnectTimeout(15000);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", SENSOR_API_KEY);
  JsonDocument request;
  request["chipId"] = hardwareChipId;
  String body;
  serializeJson(request, body);
  const int status = http.POST(body);
  JsonDocument response;
  String id = "";
  if (status == 200 && !deserializeJson(response, http.getString())) {
    const char* value = response["assignmentId"] | "";
    if (strlen(value) == 36) id = value;
  }
  http.end();
  if (id.isEmpty()) showLine(3, status == 409 ? "Not assigned" : status == 401 ? "Key or ID invalid" : "Assignment unavail.");
  return id;
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
  secureClient.setCACert(PONDSENSE_HARDWARE_CA);
  HTTPClient http;
  if (!http.begin(secureClient, String(PONDSENSE_HARDWARE_API) + "/readings")) {
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
  JsonDocument confirmation;
  bool validResponse = deserializeJson(confirmation, response) == DeserializationError::Ok;

  if (statusCode == 201 && validResponse && confirmation["saved"] == true &&
      confirmation["assigned"] == true && confirmation["telemetryId"].as<int>() > 0) {
    Serial.printf("Server accepted device #%d, telemetry #%d\n",
      confirmation["deviceId"].as<int>(), confirmation["telemetryId"].as<int>());
    JsonDocument sample;
    if (!deserializeJson(sample, body)) {
      const auto numberOrMissing = [](JsonVariantConst value) {
        return value.isNull() ? String("--") : String(value.as<float>(), 2);
      };
      Serial.printf("Saved sample %s | pH %s | temperature %s C | turbidity %s NTU\n",
        sample["sampledAt"] | "--", numberOrMissing(sample["ph"]).c_str(),
        numberOrMissing(sample["temperatureC"]).c_str(), numberOrMissing(sample["turbidityNtu"]).c_str());
    }
    showLine(3, "Updated device #" + String(confirmation["deviceId"].as<int>()));
  } else if (statusCode == 401) {
    showLine(3, "Server: Key invalid");
  } else if (statusCode == 409) {
    showLine(3, "Assignment changed");
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
  char chip[13];
  snprintf(chip, sizeof(chip), "%012llX", ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL);
  hardwareChipId = chip;
  Serial.printf("ESP32 Hardware ID: %s\n", chip);
#ifdef PONDSENSE_BENCH
  Serial.println("Local bench firmware. Do not use with production credentials.");
#endif
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
  // Never label an already-collected sample with an assignment fetched afterward.
  const String assignment = syncAssignment();
  int rawValue = 0;
  float voltage = readTurbidityVoltage(rawValue);
  float turbidityNtu = turbidityFromCalibratedVoltage(voltage);
  if (!isnan(turbidityNtu)) turbidityNtu = roundf(turbidityNtu * 100.0f) / 100.0f;
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
  int estimatedNtu = roundf(constrain((1.0f - rawValue / 4095.0f) * 250.0f, 0.0f, 250.0f));
  const String turbidityText = isnan(turbidityNtu) ? "~" + String(estimatedNtu) : String(turbidityNtu, 2);
  showLine(2, "Turb: " + turbidityText + (isnan(turbidityNtu) ? " NTU est" : " NTU"));

  if (!assignment.isEmpty()) {
    // This sketch has no persistent queue. A failed or rejected sample is not retried with a different assignment.
    sendTelemetry(makeSample(rawValue, voltage, turbidityNtu, temperatureC, phVoltage, ph, sampledAt, assignment));
  } else if (WiFi.status() != WL_CONNECTED) showLine(3, "WiFi offline");
  else if (sampledAt < 1700000000) showLine(3, "Waiting for clock");
  delay(500);
}
