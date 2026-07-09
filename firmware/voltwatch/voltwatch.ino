// Voltwatch ESP32 firmware — dynamic, config-driven
// -------------------------------------------------------------
// First boot:
//   - The ESP32 has no saved WiFi, so it starts its own access
//     point "Voltwatch-Setup" (password: voltwatch).
//   - Connect your phone to it. A captive portal opens.
//   - Enter your home WiFi, the ingest endpoint (e.g.
//     https://your-app.lovable.app/api/public/ingest), and the
//     device ingest key from the dashboard. Save. It reboots.
//
// After that:
//   - The firmware pulls the current sensor list from the app
//     (GET /api/public/config with the same ingest key) every
//     ~15 s. When you add, remove, edit a sensor, or change a
//     pin in the dashboard, the ESP picks it up automatically.
//     No re-flashing.
//   - Relay states from the dashboard are applied to output
//     pins on every ingest response.
//
// To change WiFi / endpoint / key later:
//   - Hold BOOT (GPIO 0) for ~3 s. Portal reopens.
//
// Required libraries (Arduino IDE > Library Manager):
//   - WiFiManager   by tzapu
//   - ArduinoJson   by Benoit Blanchon
//   - DHT sensor library  by Adafruit  (+ Adafruit Unified Sensor)
// -------------------------------------------------------------

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <DHT.h>

// ---------- Firmware identity ----------
// Bump FW_VERSION whenever behavior changes (LED logic, protocol, sensors).
// FW_BUILD is baked in at compile time so the dashboard can tell two builds
// of the same version apart.
#define FW_VERSION "1.1.0"
#define FW_BUILD   (__DATE__ " " __TIME__)

// ---------- Compile-time defaults ----------
// These are auto-substituted by the dashboard when you download the .ino
// for a specific device: the ingest URL becomes your app's origin and the
// key becomes that device's ingest key. When both are baked in, the WiFi
// setup portal only asks for WiFi credentials — no URL or key to type.
// Leave the placeholders (__INGEST_URL__ / __INGEST_KEY__) if you're
// building manually; the portal will ask for them at first boot.
#define DEFAULT_INGEST_URL "__INGEST_URL__"
#define DEFAULT_INGEST_KEY "__INGEST_KEY__"
// Pairing endpoint (POST { code, fw_version, fw_build }) — used when the
// firmware wasn't personalized for a specific device. Returns ingest_url +
// ingest_key which are then persisted.
#define DEFAULT_CLAIM_URL  "__CLAIM_URL__"


static bool isPlaceholder(const String& s) {
  return s.length() == 0 || s.startsWith("__") ;
}

// ---------- Persistent config ----------
Preferences prefs;
String cfgIngest;     // .../api/public/ingest
String cfgKey;        // device ingest key
String cfgConfigUrl;  // derived: .../api/public/config
String cfgClaimUrl;   // .../api/public/claim  (pairing endpoint)
String cfgHostname;   // WiFi hostname (shown in router device list)

// Build a sensible default hostname like "voltwatch-a1b2" from the MAC.
String defaultHostname() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[24];
  snprintf(buf, sizeof(buf), "voltwatch-%04x", (uint16_t)(mac & 0xFFFF));
  return String(buf);
}

// Sanitise a user-typed hostname to RFC-952/1123-safe chars.
String sanitiseHostname(const String& in) {
  String out;
  for (size_t i = 0; i < in.length() && out.length() < 31; i++) {
    char c = in[i];
    if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') out += c;
    else if (c == ' ' || c == '_' || c == '.') out += '-';
  }
  while (out.length() && out[0] == '-') out.remove(0, 1);
  while (out.length() && out[out.length() - 1] == '-') out.remove(out.length() - 1);
  if (out.length() == 0) out = defaultHostname();
  return out;
}


const char* AP_NAME = "Voltwatch-Setup";
const char* AP_PASS = "voltwatch";
const int   PORTAL_BUTTON_PIN = 0;
const int   STATUS_LED_PIN    = 2;   // onboard LED on most ESP32 dev boards

const unsigned long POST_INTERVAL_MS   = 5000;   // send readings every 5 s
const unsigned long CONFIG_INTERVAL_MS = 15000;  // refresh sensor list every 15 s
const int MAX_SENSORS = 12;

unsigned long lastPost = 0;
unsigned long lastConfig = 0;

// ---------- Status LED ----------
// States:
//   PORTAL     -> fast blink   (150 ms) : captive portal is up, waiting for you
//   CONNECTING -> slow blink   (600 ms) : trying to join saved WiFi
//   ONLINE     -> solid on               : connected and posting
//   ERROR      -> double-blink pattern  : lost WiFi mid-run
enum LedState { LED_PORTAL, LED_CONNECTING, LED_ONLINE, LED_ERROR };
LedState ledState = LED_CONNECTING;

void setLed(LedState s) { ledState = s; }

void updateLed() {
  static unsigned long lastToggle = 0;
  static bool on = false;
  static int pulseIdx = 0;
  unsigned long now = millis();

  auto blink = [&](unsigned long period) {
    if (now - lastToggle >= period) {
      lastToggle = now;
      on = !on;
      digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
    }
  };

  switch (ledState) {
    case LED_PORTAL:     blink(150); break;
    case LED_CONNECTING: blink(600); break;
    case LED_ONLINE:     digitalWrite(STATUS_LED_PIN, HIGH); break;
    case LED_ERROR: {
      // pattern: on 100, off 100, on 100, off 700
      const unsigned long steps[] = {100, 100, 100, 700};
      if (now - lastToggle >= steps[pulseIdx]) {
        lastToggle = now;
        pulseIdx = (pulseIdx + 1) % 4;
        digitalWrite(STATUS_LED_PIN, (pulseIdx % 2 == 0) ? HIGH : LOW);
      }
      break;
    }
  }
}

// ---------- Dynamic sensor table ----------
// NOTE: keep the Sensor struct + any function that takes a Sensor& in this
// single-file .ino OUT of function signatures. The Arduino preprocessor
// auto-inserts function prototypes at the top of the file (above every
// declaration), so a `void applySensor(Sensor&)` signature would generate
// a prototype that references `Sensor` before the struct is declared and
// the build fails. Using an index (`int i`) keeps the auto-prototype valid
// with no header file required.
struct Sensor {
  String id;
  String kind;   // "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | ...
  int    pin;    // primary pin (data / signal / out)
  int    pinB;   // secondary pin (e.g. ultrasonic ECHO), -1 if unused
  bool   desiredOn; // for relays
  DHT*   dht;    // lazily allocated for DHT22
};
Sensor sensors[MAX_SENSORS];
int sensorCount = 0;

int parsePin(const char* s) {
  if (!s || !*s) return -1;
  return atoi(s);
}

// Reset previously configured pins (mainly relays) before reconfig
void tearDownSensors() {
  for (int i = 0; i < sensorCount; i++) {
    if (sensors[i].dht) { delete sensors[i].dht; sensors[i].dht = nullptr; }
    if (sensors[i].kind == "relay" && sensors[i].pin >= 0) {
      digitalWrite(sensors[i].pin, LOW);
    }
  }
  sensorCount = 0;
}

// Takes an index into `sensors[]` (not a Sensor&) on purpose — see note above.
void applySensor(int i) {
  Sensor& s = sensors[i];
  if (s.kind == "dht22" && s.pin >= 0) {
    s.dht = new DHT(s.pin, DHT22);
    s.dht->begin();
  } else if (s.kind == "relay" && s.pin >= 0) {
    pinMode(s.pin, OUTPUT);
    digitalWrite(s.pin, s.desiredOn ? HIGH : LOW);
  } else if (s.kind == "digital" && s.pin >= 0) {
    pinMode(s.pin, INPUT_PULLUP);
  } else if (s.kind == "ultrasonic") {
    if (s.pin  >= 0) pinMode(s.pin,  OUTPUT);
    if (s.pinB >= 0) pinMode(s.pinB, INPUT);
  }
  // analog pins on ESP32 don't need pinMode
}

// ---------- WiFi + captive portal ----------
// Forward decl: attempts to redeem a 6-digit pairing code against the
// server, returning true when it successfully learned an ingest URL + key.
bool claimWithCode(const String& code);

void startConfigPortal(bool onDemand) {
  WiFiManager wm;

  // Only expose endpoint/key fields when they aren't already baked into
  // this firmware build. When the dashboard personalized the .ino, the
  // portal is WiFi-only.
  bool haveEndpoint = !isPlaceholder(String(DEFAULT_INGEST_URL));
  bool haveKey      = !isPlaceholder(String(DEFAULT_INGEST_KEY));
  bool haveClaim    = !isPlaceholder(String(DEFAULT_CLAIM_URL));
  bool needEndpoint = !haveEndpoint;
  bool needKey      = !haveKey;

  WiFiManagerParameter pEndpoint("endpoint", "Ingest URL (https://.../api/public/ingest)",
                                 cfgIngest.c_str(), 200);
  WiFiManagerParameter pKey("key", "Device ingest key",
                            cfgKey.c_str(), 80);
  // Pairing code (6 digits from the dashboard). Always offered when the
  // firmware knows how to reach a claim endpoint — either baked in, or
  // once the user has typed an ingest URL (from which we derive it).
  WiFiManagerParameter pCode("paircode", "Pairing code (6 digits, optional)", "", 8);
  // Hostname the router will display for this ESP in its device list.
  WiFiManagerParameter pHost("hostname", "Device name (shown in your router)",
                             cfgHostname.c_str(), 32);
  bool offerCode = haveClaim || needEndpoint; // if no ingest baked in, user can pair after entering URL
  if (needEndpoint) wm.addParameter(&pEndpoint);
  if (needKey)      wm.addParameter(&pKey);
  if (offerCode)    wm.addParameter(&pCode);
  wm.addParameter(&pHost);
  wm.setConfigPortalTimeout(300);

  // Blink LED fast while the portal is up so the user knows to connect
  setLed(LED_PORTAL);
  wm.setAPCallback([](WiFiManager*) { setLed(LED_PORTAL); });
  wm.setSaveConfigCallback([]() { setLed(LED_CONNECTING); });

  // Apply the hostname BEFORE WiFi connects so the router sees the right name.
  WiFi.setHostname(cfgHostname.c_str());

  bool ok = onDemand ? wm.startConfigPortal(AP_NAME, AP_PASS)
                     : wm.autoConnect(AP_NAME, AP_PASS);
  if (!ok) { Serial.println("[cfg] portal timed out"); ESP.restart(); }

  if (needEndpoint) cfgIngest = pEndpoint.getValue();
  if (needKey)      cfgKey    = pKey.getValue();
  String newHost = sanitiseHostname(String(pHost.getValue()));
  if (newHost != cfgHostname) {
    cfgHostname = newHost;
    WiFi.setHostname(cfgHostname.c_str());
  }
  prefs.begin("voltwatch", false);
  prefs.putString("ingest",   cfgIngest);
  prefs.putString("key",      cfgKey);
  prefs.putString("hostname", cfgHostname);
  prefs.end();
  Serial.printf("[cfg] saved (hostname=%s)\n", cfgHostname.c_str());

  // If a pairing code was entered (and we still lack an ingest key), redeem
  // it now that WiFi is up. On success this also persists ingest URL/key.
  String code = String(pCode.getValue());
  code.trim();
  if (offerCode && code.length() == 6 && cfgKey.length() == 0) {
    Serial.println("[cfg] attempting pairing claim");
    if (claimWithCode(code)) {
      Serial.println("[cfg] paired ok");
    } else {
      Serial.println("[cfg] pairing failed");
    }
  }
  setLed(LED_ONLINE);
}


void loadConfig() {
  prefs.begin("voltwatch", true);
  cfgIngest = prefs.getString("ingest", "");
  cfgKey    = prefs.getString("key", "");
  prefs.end();

  // Fall back to compile-time defaults when nothing is saved yet or when
  // the .ino was personalized for a specific device by the dashboard.
  String defUrl = String(DEFAULT_INGEST_URL);
  String defKey = String(DEFAULT_INGEST_KEY);
  String defClaim = String(DEFAULT_CLAIM_URL);
  if (cfgIngest.length() == 0 && !isPlaceholder(defUrl)) cfgIngest = defUrl;
  if (cfgKey.length()    == 0 && !isPlaceholder(defKey)) cfgKey    = defKey;

  // derive config URL from ingest URL by swapping the last path segment
  cfgConfigUrl = cfgIngest;
  int slash = cfgConfigUrl.lastIndexOf('/');
  if (slash > 0) cfgConfigUrl = cfgConfigUrl.substring(0, slash) + "/config";

  // Prefer a baked-in claim URL; otherwise derive one from the ingest URL.
  if (!isPlaceholder(defClaim)) {
    cfgClaimUrl = defClaim;
  } else if (cfgIngest.length() > 0 && slash > 0) {
    cfgClaimUrl = cfgIngest.substring(0, slash) + "/claim";
  }
}

// ---------- Pairing (claim) ----------
// POSTs {"code":"123456","fw_version":..,"fw_build":..} to the claim URL,
// and on 200 saves the returned ingest_url + ingest_key so the ESP starts
// posting readings without any further setup.
bool claimWithCode(const String& code) {
  if (cfgClaimUrl.length() == 0) {
    Serial.println("[claim] no claim URL known");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) return false;

  DynamicJsonDocument body(256);
  body["code"] = code;
  body["fw_version"] = FW_VERSION;
  body["fw_build"] = FW_BUILD;
  String out;
  serializeJson(body, out);

  HTTPClient http;
  http.begin(cfgClaimUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  int status = http.POST(out);
  Serial.printf("[claim] status %d\n", status);
  if (status != 200) { http.end(); return false; }

  String resp = http.getString();
  http.end();

  DynamicJsonDocument r(1024);
  if (deserializeJson(r, resp)) {
    Serial.println("[claim] bad JSON");
    return false;
  }
  const char* ingestUrl = r["ingest_url"] | "";
  const char* ingestKey = r["ingest_key"] | "";
  if (!*ingestUrl || !*ingestKey) return false;

  cfgIngest = String(ingestUrl);
  cfgKey    = String(ingestKey);
  cfgConfigUrl = cfgIngest;
  int s2 = cfgConfigUrl.lastIndexOf('/');
  if (s2 > 0) cfgConfigUrl = cfgConfigUrl.substring(0, s2) + "/config";

  prefs.begin("voltwatch", false);
  prefs.putString("ingest", cfgIngest);
  prefs.putString("key",    cfgKey);
  prefs.end();
  return true;
}


// ---------- Config fetch: rebuild sensor table ----------
void refreshConfig() {
  if (WiFi.status() != WL_CONNECTED || cfgConfigUrl.length() == 0) return;

  HTTPClient http;
  http.begin(cfgConfigUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("x-ingest-key", cfgKey);
  http.addHeader("x-fw-version", FW_VERSION);
  http.addHeader("x-fw-build", FW_BUILD);
  int code = http.GET();
  if (code != 200) { Serial.printf("[config] %d\n", code); http.end(); return; }

  String body = http.getString();
  http.end();

  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, body);
  if (err) { Serial.printf("[config] parse err: %s\n", err.c_str()); return; }

  tearDownSensors();
  JsonArray arr = doc["sensors"].as<JsonArray>();
  for (JsonObject s : arr) {
    if (sensorCount >= MAX_SENSORS) break;
    Sensor& out = sensors[sensorCount];
    out.id   = String((const char*)s["id"]);
    out.kind = String((const char*)s["kind"]);
    out.pin  = parsePin(s["pin"] | "");
    out.pinB = -1;
    out.desiredOn = s["on"] | false;
    out.dht = nullptr;

    // Multi-pin sensors: pick out named roles from state.pins
    JsonObject pins = s["pins"].as<JsonObject>();
    if (out.kind == "ultrasonic") {
      out.pin  = parsePin(pins["trig"] | "");
      out.pinB = parsePin(pins["echo"] | "");
    } else if (out.kind == "dht22") {
      const char* p = pins["data"] | "";
      if (*p) out.pin = parsePin(p);
    } else if (out.kind == "relay") {
      const char* p = pins["out"] | "";
      if (*p) out.pin = parsePin(p);
    } else if (out.kind == "digital" || out.kind == "analog") {
      const char* p = pins["signal"] | "";
      if (*p) out.pin = parsePin(p);
    }

    applySensor(sensorCount);
    sensorCount++;
  }
  Serial.printf("[config] %d sensor(s) loaded\n", sensorCount);
}

// ---------- Reading loop ----------
long readUltrasonicCm(int trig, int echo) {
  digitalWrite(trig, LOW);  delayMicroseconds(2);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long dur = pulseIn(echo, HIGH, 30000);
  if (dur == 0) return -1;
  return dur / 58;
}

void collectAndPost() {
  if (WiFi.status() != WL_CONNECTED || cfgIngest.length() == 0) return;
  if (sensorCount == 0) return;

  DynamicJsonDocument doc(2048);
  JsonArray readings = doc.createNestedArray("readings");

  for (int i = 0; i < sensorCount; i++) {
    Sensor& s = sensors[i];
    if (s.kind == "relay") continue; // outputs only, no reading
    JsonObject r = readings.createNestedObject();
    r["sensor_id"] = s.id;
    JsonObject p = r.createNestedObject("payload");

    if (s.kind == "dht22" && s.dht) {
      float t = s.dht->readTemperature();
      float h = s.dht->readHumidity();
      if (!isnan(t)) p["temperature"] = t;
      if (!isnan(h)) p["humidity"] = h;
    } else if (s.kind == "analog" && s.pin >= 0) {
      p["value"] = analogRead(s.pin);
    } else if (s.kind == "digital" && s.pin >= 0) {
      p["value"] = digitalRead(s.pin);
    } else if (s.kind == "ultrasonic" && s.pin >= 0 && s.pinB >= 0) {
      long cm = readUltrasonicCm(s.pin, s.pinB);
      if (cm >= 0) p["distance"] = (int)cm;
    }
    // Add more sensor kinds here as they're added to the dashboard.
  }

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(cfgIngest);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ingest-key", cfgKey);
  http.addHeader("x-fw-version", FW_VERSION);
  http.addHeader("x-fw-build", FW_BUILD);
  int code = http.POST(body);
  Serial.printf("[post] %d\n", code);

  // Apply relay states from the response
  if (code == 200) {
    String resp = http.getString();
    DynamicJsonDocument r(2048);
    if (!deserializeJson(r, resp)) {
      for (JsonObject rel : r["relays"].as<JsonArray>()) {
        const char* pinStr = rel["pin"] | "";
        bool on = rel["on"] | false;
        int pin = parsePin(pinStr);
        if (pin >= 0) {
          // ensure it's an output (config refresh normally handles this)
          pinMode(pin, OUTPUT);
          digitalWrite(pin, on ? HIGH : LOW);
        }
      }
    }
  }
  http.end();
}

// ---------- Arduino entry points ----------
void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(PORTAL_BUTTON_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED_PIN, OUTPUT);
  setLed(LED_CONNECTING);

  loadConfig();

  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    Serial.println("[cfg] BOOT held — opening portal");
    startConfigPortal(true);
    loadConfig();
  } else {
    startConfigPortal(false); // autoConnect
  }

  refreshConfig();
  setLed(WiFi.status() == WL_CONNECTED ? LED_ONLINE : LED_ERROR);
}

void loop() {
  updateLed();

  // Long-press BOOT (~3 s) -> reopen portal at runtime
  static unsigned long pressStart = 0;
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    else if (millis() - pressStart > 3000) {
      startConfigPortal(true);
      loadConfig();
      refreshConfig();
      pressStart = 0;
    }
  } else {
    pressStart = 0;
  }

  // Track WiFi state for the LED
  if (WiFi.status() != WL_CONNECTED && ledState == LED_ONLINE) setLed(LED_ERROR);
  if (WiFi.status() == WL_CONNECTED && ledState == LED_ERROR)  setLed(LED_ONLINE);

  if (millis() - lastConfig >= CONFIG_INTERVAL_MS) {
    lastConfig = millis();
    refreshConfig();
  }
  if (millis() - lastPost >= POST_INTERVAL_MS) {
    lastPost = millis();
    collectAndPost();
  }
}
