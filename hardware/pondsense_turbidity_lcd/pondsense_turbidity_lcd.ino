#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>
#include <time.h>
#include "device_secrets.h"

const char* API_URL = "https://pondsense-of-us.onrender.com/api/v1/sensors/turbidity";

constexpr int TURBIDITY_PIN = 34;
// Average a few samples to reduce the normal flicker of an analog turbidity probe.
constexpr int SENSOR_SAMPLE_COUNT = 10;
constexpr unsigned long SEND_INTERVAL_MS = 5000;

// Change 0x27 to 0x3F only if your LCD is blank.
LiquidCrystal_I2C lcd(0x27, 20, 4);
WiFiClientSecure secureClient;

unsigned long lastSentAt = 0;

void showLine(int row, const String& message) {
  lcd.setCursor(0, row);
  lcd.print(message);
  for (int index = message.length(); index < 20; index++) lcd.print(' ');
}

int readStableTurbidityRaw() {
  uint32_t total = 0;
  for (int sample = 0; sample < SENSOR_SAMPLE_COUNT; sample++) {
    total += analogRead(TURBIDITY_PIN);
    delay(20);
  }
  return total / SENSOR_SAMPLE_COUNT;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  showLine(3, "WiFi connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (int attempt = 0; attempt < 20 && WiFi.status() != WL_CONNECTED; attempt++) {
    delay(500);
  }
  if (WiFi.status() == WL_CONNECTED) configTime(0, 0, "pool.ntp.org");
}

void sendTelemetry(int rawValue, float voltage) {
  if (WiFi.status() != WL_CONNECTED) return;

  if (strlen(SERVER_CA_CERT) == 0) {
    showLine(3, "TLS cert missing");
    return;
  }
  if (time(nullptr) < 1700000000) {
    showLine(3, "Waiting for clock");
    return;
  }
  secureClient.setCACert(SERVER_CA_CERT);

  HTTPClient http;
  if (!http.begin(secureClient, API_URL)) {
    showLine(3, "Server URL error");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", SENSOR_API_KEY);

  const String body = "{\"rawValue\":" + String(rawValue) + ",\"voltage\":" + String(voltage, 3) + "}";
  const int statusCode = http.POST(body);
  JsonDocument confirmation;
  const bool validResponse = deserializeJson(confirmation, http.getString()) == DeserializationError::Ok;

  if (statusCode == 201 && validResponse && confirmation["saved"] == true &&
      confirmation["assigned"] == true && confirmation["telemetryId"].as<int>() > 0) {
    showLine(3, "Website updated");
  } else if (statusCode == 401) {
    showLine(3, "Key invalid (401)");
  } else if (statusCode == 409) {
    showLine(3, "Not assigned (409)");
  } else {
    showLine(3, "Send error: " + String(statusCode));
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(TURBIDITY_PIN, ADC_11db);

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  showLine(0, "PondSense of Us");
  showLine(1, "Turbidity Sensor");

  connectWifi();
}

void loop() {
  connectWifi();

  const int rawValue = readStableTurbidityRaw();
  const float voltage = rawValue * (3.3f / 4095.0f);
  // Prototype estimate only; calibrate the probe before treating this as measured NTU.
  const int turbidityNtu = constrain((int)roundf((3.3f - voltage) * (250.0f / 3.3f)), 0, 250);
  const char* waterClarity = turbidityNtu > 200 ? "Very cloudy" :
                             turbidityNtu > 100 ? "Cloudy" : "Clear range";

  showLine(0, "PondSense of Us");
  showLine(1, "Turbidity: " + String(turbidityNtu) + " NTU");
  showLine(2, String(waterClarity) + " (est.)");

  if (WiFi.status() != WL_CONNECTED) {
    showLine(3, "WiFi disconnected");
  } else if (millis() - lastSentAt >= SEND_INTERVAL_MS || lastSentAt == 0) {
    sendTelemetry(rawValue, voltage);
    lastSentAt = millis();
  }

  delay(500);
}
