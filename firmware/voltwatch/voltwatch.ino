// Voltwatch ESP32 firmware
// -------------------------------------------------------------
// First boot:
//   - The ESP32 has no saved WiFi, so it starts its own access
//     point called "Voltwatch-Setup" (password: voltwatch).
//   - Connect your phone/laptop to it. A captive portal opens.
//   - Pick your home WiFi, enter its password, and paste your
//     ingest endpoint + device key. Hit Save. The ESP reboots
//     and joins your network. Everything is stored in flash.
//
// To change WiFi / endpoint / key later:
//   - Hold the BOOT button (GPIO 0) for ~3 seconds.
//   - The portal reopens on "Voltwatch-Setup" and you can edit
//     any field. This is the "settings" the app UI can't do
//     while the device is offline.
//
// Required libraries (install from Arduino IDE > Library Manager):
//   - WiFiManager   by tzapu
//   - ArduinoJson   by Benoit Blanchon
//   - DHT sensor library  by Adafruit  (+ Adafruit Unified Sensor)
//
// Board: "ESP32 Dev Module" (or your specific ESP32 variant).
// -------------------------------------------------------------

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <DHT.h>

// ---------- Hardware wiring ----------
// Edit these to match your sensors. Match the pin numbers to
// what you set in the Voltwatch dashboard for each sensor.
#define DHT_PIN     4      // DHT22 data pin
#define DHT_TYPE    DHT22
#define RELAY_PIN   26     // Relay control pin
#define ANALOG_PIN  34     // ADC1 pin (input-only OK)

DHT dht(DHT_PIN, DHT_TYPE);

// ---------- Config (filled by captive portal) ----------
Preferences prefs;
String cfgEndpoint;   // e.g. https://your-app.lovable.app/api/public/ingest
String cfgKey;        // device ingest key from the dashboard
String cfgDeviceName; // shown as AP name suffix, optional

const char* AP_NAME = "Voltwatch-Setup";
const char* AP_PASS = "voltwatch";
const int   PORTAL_BUTTON_PIN = 0;   // BOOT button on most ESP32 dev boards
const unsigned long POST_INTERVAL_MS = 5000;

unsigned long lastPost = 0;

// ---------- WiFi + config portal ----------
void startConfigPortal(bool onDemand) {
  WiFiManager wm;

  WiFiManagerParameter pEndpoint("endpoint", "Ingest endpoint (https://.../api/public/ingest)",
                                 cfgEndpoint.c_str(), 200);
  WiFiManagerParameter pKey("key", "Device ingest key",
                            cfgKey.c_str(), 80);
  WiFiManagerParameter pName("name", "Device name (optional)",
                             cfgDeviceName.c_str(), 40);
  wm.addParameter(&pEndpoint);
  wm.addParameter(&pKey);
  wm.addParameter(&pName);

  wm.setConfigPortalTimeout(300); // 5 min then reboot

  bool ok = onDemand
    ? wm.startConfigPortal(AP_NAME, AP_PASS)
    : wm.autoConnect(AP_NAME, AP_PASS);

  if (ok) {
    cfgEndpoint   = pEndpoint.getValue();
    cfgKey        = pKey.getValue();
    cfgDeviceName = pName.getValue();
    prefs.begin("voltwatch", false);
    prefs.putString("endpoint",  cfgEndpoint);
    prefs.putString("key",       cfgKey);
    prefs.putString("name",      cfgDeviceName);
    prefs.end();
    Serial.println("[cfg] saved");
  } else {
    Serial.println("[cfg] portal timed out — rebooting");
    ESP.restart();
  }
}

void loadConfig() {
  prefs.begin("voltwatch", true);
  cfgEndpoint   = prefs.getString("endpoint", "");
  cfgKey        = prefs.getString("key", "");
  cfgDeviceName = prefs.getString("name", "");
  prefs.end();
}

// ---------- Sensor sampling ----------
void collectAndPost() {
  if (cfgEndpoint.length() == 0 || cfgKey.length() == 0) return;
  if (WiFi.status() != WL_CONNECTED) return;

  StaticJsonDocument<512> doc;
  JsonArray readings = doc.createNestedArray("readings");

  // DHT22
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    JsonObject r = readings.createNestedObject();
    r["pin"] = String(DHT_PIN);
    JsonObject p = r.createNestedObject("payload");
    p["temperature"] = t;
    p["humidity"] = h;
  }

  // Analog input
  int raw = analogRead(ANALOG_PIN);
  {
    JsonObject r = readings.createNestedObject();
    r["pin"] = String(ANALOG_PIN);
    JsonObject p = r.createNestedObject("payload");
    p["value"] = raw;
  }

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(cfgEndpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ingest-key", cfgKey);
  int code = http.POST(body);
  Serial.printf("[post] %d\n", code);
  http.end();
}

// ---------- Arduino entry points ----------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PORTAL_BUTTON_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  dht.begin();

  loadConfig();

  // If BOOT is held during power-on, force the portal.
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    Serial.println("[cfg] BOOT held — opening portal");
    startConfigPortal(true);
  } else {
    startConfigPortal(false); // autoConnect, portal only if no saved WiFi
  }
}

void loop() {
  // Long-press BOOT (~3s) at runtime -> reopen portal.
  static unsigned long pressStart = 0;
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    else if (millis() - pressStart > 3000) {
      Serial.println("[cfg] BOOT long-press — opening portal");
      startConfigPortal(true);
      pressStart = 0;
    }
  } else {
    pressStart = 0;
  }

  if (millis() - lastPost >= POST_INTERVAL_MS) {
    lastPost = millis();
    collectAndPost();
  }
}
