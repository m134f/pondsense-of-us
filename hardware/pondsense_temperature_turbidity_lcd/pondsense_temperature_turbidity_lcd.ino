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
  temperatureSensor.requestTemperatures();
  float value = temperatureSensor.getTempCByIndex(0);
  return value == DEVICE_DISCONNECTED_C || value == 85.0f || value < -10.0f || value > 60.0f ? NAN : value;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiAttemptAt && millis() - lastWifiAttemptAt < WIFI_RETRY_MS) return;
  lastWifiAttemptAt = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

String makeSample(int rawValue, float voltage, float temperatureC) {
  JsonDocument payload;
  char readingId[40];
  snprintf(readingId, sizeof(readingId), "%llX-%08lX-%08lX", ESP.getEfuseMac(), millis(), esp_random());
  payload["clientReadingId"] = readingId;
  if (time(nullptr) >= 1700000000) {
    time_t sampledAt = time(nullptr);
    struct tm utcTime;
    gmtime_r(&sampledAt, &utcTime);
    char timestamp[25];
    strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utcTime);
    payload["sampledAt"] = timestamp;
  }
  JsonArray verified = payload["verifiedParameters"].to<JsonArray>();
  if (!isnan(temperatureC)) verified.add("temperature");
  payload["rawValue"] = rawValue;
  payload["voltage"] = voltage;
  if (isnan(temperatureC)) payload["temperatureC"] = nullptr;
  else payload["temperatureC"] = temperatureC;
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
    showLine(3, "Server: Updated");
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
  analogReadResolution(12);
  analogSetPinAttenuation(TURBIDITY_PIN, ADC_11db);
  temperatureSensor.begin();
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  showLine(0, "PondSense of Us");
  connectWifi();
  configTime(0, 0, "pool.ntp.org");
}

void loop() {
  connectWifi();
  int rawValue = readTurbidityRaw();
  float voltage = rawValue * (3.3f / 4095.0f);
  float temperatureC = readTemperatureC();

  showLine(0, "PondSense of Us");
  if (isnan(temperatureC)) {
    showLine(1, temperatureSensor.getDeviceCount() == 0 ? "Temp: sensor missing" : "Temp: check GPIO 4");
  } else {
    showLine(1, "Temp: " + String(temperatureC, 1) + " C");
  }
  // Display the same provisional conversion as the dashboard; calibration is still required.
  int estimatedNtu = roundf(constrain((1.0f - rawValue / 4095.0f) * 250.0f, 0.0f, 250.0f));
  showLine(2, "Turb: ~" + String(estimatedNtu) + " NTU est");

  if (lastSentAt == 0 || millis() - lastSentAt >= SEND_INTERVAL_MS) {
    lastSentAt = millis();
    String body = makeSample(rawValue, voltage, temperatureC);
    if (WiFi.status() == WL_CONNECTED) {
      sendTelemetry(body);
    } else {
      showLine(3, "WiFi offline");
    }
  }
  delay(500);
}
