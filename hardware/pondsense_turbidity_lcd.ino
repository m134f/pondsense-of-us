#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// Replace these three values before uploading. Do not commit your real API key.
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* API_URL = "https://YOUR_RENDER_SERVICE.onrender.com/api/v1/sensors/turbidity";
const char* SENSOR_API_KEY = "YOUR_SENSOR_API_KEY";

constexpr int TURBIDITY_PIN = 34;
constexpr unsigned long SEND_INTERVAL_MS = 15000;

// Change 0x27 to 0x3F only if your LCD is blank.
LiquidCrystal_I2C lcd(0x27, 20, 4);
WiFiClientSecure secureClient;

unsigned long lastSentAt = 0;

void showLine(int row, const String& message) {
  lcd.setCursor(0, row);
  lcd.print(message);
  for (int index = message.length(); index < 20; index++) lcd.print(' ');
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  showLine(3, "WiFi connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (int attempt = 0; attempt < 20 && WiFi.status() != WL_CONNECTED; attempt++) {
    delay(500);
  }
}

void sendTelemetry(int rawValue, float voltage) {
  if (WiFi.status() != WL_CONNECTED) return;

  // For the first capstone prototype. Replace with a root CA certificate before production use.
  secureClient.setInsecure();

  HTTPClient http;
  if (!http.begin(secureClient, API_URL)) {
    showLine(3, "Server URL error");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", SENSOR_API_KEY);

  const String body = "{\"rawValue\":" + String(rawValue) + ",\"voltage\":" + String(voltage, 3) + "}";
  const int statusCode = http.POST(body);

  if (statusCode == 201) {
    showLine(3, "Website updated");
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

  const int rawValue = analogRead(TURBIDITY_PIN);
  const float voltage = rawValue * (3.3f / 4095.0f);

  showLine(0, "PondSense of Us");
  showLine(1, "Raw: " + String(rawValue));
  showLine(2, "Signal: " + String(voltage, 2) + " V");

  if (WiFi.status() != WL_CONNECTED) {
    showLine(3, "WiFi disconnected");
  } else if (millis() - lastSentAt >= SEND_INTERVAL_MS || lastSentAt == 0) {
    sendTelemetry(rawValue, voltage);
    lastSentAt = millis();
  }

  delay(500);
}
