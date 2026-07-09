// Voltwatch ESP32 firmware — dynamic, config-driven
// -------------------------------------------------------------
// First boot:
//   - The ESP32 has no saved WiFi, so it starts its own access
//     point "Voltwatch-Setup" (password: voltwatch).
//   - Connect your phone to it. A captive portal opens.
//   - Enter your home WiFi. Then EITHER:
//       (a) type a 6-digit pairing code from the dashboard
//           ("Pair new device"), OR
//       (b) type the ingest URL and device key manually.
//     Save. It reboots.
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
#define FW_VERSION "1.2.0"
#define FW_BUILD   (__DATE__ " " __TIME__)

// ---------- Compile-time defaults ----------
// The dashboard auto-substitutes DEFAULT_INGEST_URL / DEFAULT_INGEST_KEY
// when you download the .ino for a specific device. When placeholders
// remain (values starting with "__"), the captive portal prompts for
// them, and a pairing code can be used instead of typing them by hand.
#define DEFAULT_INGEST_URL "https://project--c8ab56ed-ab9f-4b4a-b700-c695543bf1e4-dev.lovable.app/api/public/ingest"
#define DEFAULT_INGEST_KEY "__INGEST_KEY__"
#define DEFAULT_CLAIM_URL  "https://project--c8ab56ed-ab9f-4b4a-b700-c695543bf1e4-dev.lovable.app/api/public/claim"

static bool isPlaceholder(const String& s) {
  return s.length() == 0 || s.startsWith("__");
}

// ---------- Persistent config ----------
Preferences prefs;
String cfgIngest;     // .../api/public/ingest
String cfgKey;        // device ingest key
String cfgConfigUrl;  // derived: .../api/public/config
String cfgClaimUrl;   // .../api/public/claim  (pairing endpoint)
String cfgHostname;   // WiFi hostname shown in router (e.g. "voltwatch-kitchen")

// Sanitize a user-entered hostname to RFC 952/1123-ish: lowercase letters,
// digits, and '-'; max 32 chars; no leading/trailing '-'.
String sanitizeHostname(const String& in) {
  String out;
  for (size_t i = 0; i < in.length() && out.length() < 32; i++) {
    char c = in[i];
    if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') out += c;
    else if (c == ' ' || c == '_') out += '-';
  }
  while (out.length() && out[0] == '-') out.remove(0, 1);
  while (out.length() && out[out.length() - 1] == '-') out.remove(out.length() - 1, 1);
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
enum LedState { LED_PORTAL, LED_CONNECTING, LED_ONLINE, LED_ERROR };
LedState ledState = LED_CONNECTING;

void setLed(int s) { ledState = (LedState)s; }

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
struct Sensor {
  String id;
  String kind;
  int    pin;
  int    pinB;
  bool   desiredOn;
  DHT*   dht;
};

Sensor sensors[MAX_SENSORS];
int sensorCount = 0;

int parsePin(const char* s) {
  if (!s || !*s) return -1;
  return atoi(s);
}

void tearDownSensors() {
  for (int i = 0; i < sensorCount; i++) {
    if (sensors[i].dht) { delete sensors[i].dht; sensors[i].dht = nullptr; }
    if (sensors[i].kind == "relay" && sensors[i].pin >= 0) {
      digitalWrite(sensors[i].pin, LOW);
    }
  }
  sensorCount = 0;
}

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
}

// ---------- WiFi + captive portal ----------
bool claimWithCode(const String& code);

void startConfigPortal(bool onDemand) {
  WiFiManager wm;

  bool haveEndpoint = !isPlaceholder(String(DEFAULT_INGEST_URL));
  bool haveKey      = !isPlaceholder(String(DEFAULT_INGEST_KEY));
  bool haveClaim    = !isPlaceholder(String(DEFAULT_CLAIM_URL));
  bool needEndpoint = !haveEndpoint;
  bool needKey      = !haveKey;

  WiFiManagerParameter pEndpoint("endpoint", "Ingest URL (https://.../api/public/ingest)",
                                 cfgIngest.c_str(), 200);
  WiFiManagerParameter pKey("key", "Device ingest key",
                            cfgKey.c_str(), 80);
  // Pairing code (6 digits from the dashboard) — offered whenever we know
  // a claim endpoint (either baked in, or derivable from the ingest URL).
  WiFiManagerParameter pCode("paircode", "Pairing code (6 digits, optional)", "", 8);
  WiFiManagerParameter pHost("hostname", "Device hostname (shown in router, e.g. voltwatch-kitchen)",
                             cfgHostname.c_str(), 32);
  bool offerCode = haveClaim || needEndpoint;

  if (needEndpoint) wm.addParameter(&pEndpoint);
  if (needKey)      wm.addParameter(&pKey);
  if (offerCode)    wm.addParameter(&pCode);
  wm.addParameter(&pHost);

  // ---- Diagnostics block: injected as a "custom" menu item in the portal.
  // Reads whatever the last refreshConfig() saved into Preferences so the
  // user can see what URL was hit, the HTTP status, response length, and
  // the first 200 bytes of the body — right in the captive portal, no
  // Serial Monitor needed.
  prefs.begin("voltwatch", true);
  String dUrl    = prefs.getString("diag_url",  "(none yet)");
  int    dStatus = prefs.getInt   ("diag_status", 0);
  String dSnip   = prefs.getString("diag_snip", "");
  int    dLen    = prefs.getInt   ("diag_len",   0);
  String dNote   = prefs.getString("diag_note", "(no config fetch attempted yet)");
  unsigned long dTs = prefs.getULong("diag_ts", 0);
  prefs.end();

  // HTML-escape the response snippet so tags in the body render as text.
  String snipEsc;
  snipEsc.reserve(dSnip.length() + 32);
  for (size_t i = 0; i < dSnip.length(); i++) {
    char c = dSnip[i];
    if      (c == '<')  snipEsc += "&lt;";
    else if (c == '>')  snipEsc += "&gt;";
    else if (c == '&')  snipEsc += "&amp;";
    else if (c == '"')  snipEsc += "&quot;";
    else if ((uint8_t)c < 0x20 && c != '\n' && c != '\r' && c != '\t') snipEsc += '.';
    else snipEsc += c;
  }

  static String diagHtml;   // must outlive setCustomMenuHTML call
  diagHtml  = "<hr><h3>Last config fetch</h3>";
  diagHtml += "<p style='margin:4px 0'><b>URL:</b><br><code style='word-break:break-all'>";
  diagHtml += dUrl;
  diagHtml += "</code></p>";
  diagHtml += "<p style='margin:4px 0'><b>HTTP status:</b> ";
  diagHtml += String(dStatus);
  diagHtml += " &nbsp; <b>bytes:</b> ";
  diagHtml += String(dLen);
  diagHtml += " &nbsp; <b>note:</b> ";
  diagHtml += dNote;
  diagHtml += "</p>";
  diagHtml += "<p style='margin:4px 0'><b>First 200 bytes of response:</b></p>";
  diagHtml += "<pre style='background:#111;color:#0f0;padding:8px;overflow:auto;"
              "max-height:180px;font-size:11px;white-space:pre-wrap;word-break:break-all'>";
  diagHtml += snipEsc.length() ? snipEsc : String("(empty)");
  diagHtml += "</pre>";
  diagHtml += "<p style='margin:4px 0;font-size:11px;color:#666'>"
              "Recorded ~" + String((millis() / 1000) - dTs) + "s before portal opened. "
              "FW " FW_VERSION " · " FW_BUILD "</p>";
  wm.setCustomMenuHTML(diagHtml.c_str());

  wm.setConfigPortalTimeout(300);


  setLed(LED_PORTAL);
  wm.setAPCallback([](WiFiManager*) { setLed(LED_PORTAL); });
  wm.setSaveConfigCallback([]() { setLed(LED_CONNECTING); });

  // Apply hostname BEFORE connecting so the router registers the correct name.
  if (cfgHostname.length() > 0) {
    WiFi.setHostname(cfgHostname.c_str());
  }

  bool ok = onDemand ? wm.startConfigPortal(AP_NAME, AP_PASS)
                     : wm.autoConnect(AP_NAME, AP_PASS);
  if (!ok) { Serial.println("[cfg] portal timed out"); ESP.restart(); }

  if (needEndpoint) cfgIngest = pEndpoint.getValue();
  if (needKey)      cfgKey    = pKey.getValue();
  String newHost = sanitizeHostname(String(pHost.getValue()));
  if (newHost.length() > 0 && newHost != cfgHostname) {
    cfgHostname = newHost;
    WiFi.setHostname(cfgHostname.c_str());
    Serial.printf("[cfg] hostname set to '%s'\n", cfgHostname.c_str());
  }
  prefs.begin("voltwatch", false);
  prefs.putString("ingest",   cfgIngest);
  prefs.putString("key",      cfgKey);
  prefs.putString("hostname", cfgHostname);
  prefs.end();
  Serial.println("[cfg] saved");

  // If a pairing code was entered (and we still lack an ingest key), redeem
  // it now that WiFi is up. On success this also persists ingest URL/key.
  String code = String(pCode.getValue());
  code.trim();
  if (offerCode && code.length() == 6 && cfgKey.length() == 0) {
    Serial.println("[cfg] attempting pairing claim");
    if (claimWithCode(code)) {
      Serial.println("[cfg] paired ok, fetching config with backoff");
      refreshConfigWithBackoff(7, "post-claim");
    } else {
      Serial.println("[cfg] pairing failed");
    }
  }
  setLed(LED_ONLINE);
}

void loadConfig() {
  prefs.begin("voltwatch", true);
  cfgIngest   = prefs.getString("ingest", "");
  cfgKey      = prefs.getString("key", "");
  cfgHostname = prefs.getString("hostname", "");
  prefs.end();

  String defUrl   = String(DEFAULT_INGEST_URL);
  String defKey   = String(DEFAULT_INGEST_KEY);
  String defClaim = String(DEFAULT_CLAIM_URL);
  if (cfgIngest.length() == 0 && !isPlaceholder(defUrl)) cfgIngest = defUrl;
  if (cfgKey.length()    == 0 && !isPlaceholder(defKey)) cfgKey    = defKey;

  cfgConfigUrl = cfgIngest;
  int slash = cfgConfigUrl.lastIndexOf('/');
  if (slash > 0) cfgConfigUrl = cfgConfigUrl.substring(0, slash) + "/config";

  if (!isPlaceholder(defClaim)) {
    cfgClaimUrl = defClaim;
  } else if (cfgIngest.length() > 0 && slash > 0) {
    cfgClaimUrl = cfgIngest.substring(0, slash) + "/claim";
  }
}

// ---------- Pairing (claim) ----------
// POSTs {"code":"123456","fw_version":..,"fw_build":..} to the claim URL,
// receives {"ingest_url":..,"ingest_key":..} and persists it.
bool claimWithCode(const String& code) {
  if (cfgClaimUrl.length() == 0) { Serial.println("[claim] no claim URL"); return false; }
  if (WiFi.status() != WL_CONNECTED) return false;

  DynamicJsonDocument body(256);
  body["code"]       = code;
  body["fw_version"] = FW_VERSION;
  body["fw_build"]   = FW_BUILD;
  String out;
  serializeJson(body, out);

  HTTPClient http;
  Serial.printf("[claim] POST %s\n", cfgClaimUrl.c_str());
  Serial.printf("[claim] body: %s\n", out.c_str());
  http.begin(cfgClaimUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS); // follow http->https / canonical host
  http.addHeader("Content-Type", "application/json");
  int status = http.POST(out);
  String resp = http.getString();
  Serial.printf("[claim] status %d, %d bytes\n", status, resp.length());
  Serial.printf("[claim] resp: %s\n", resp.c_str());
  if (status != 200) { http.end(); return false; }
  http.end();

  DynamicJsonDocument doc(1024);
  DeserializationError jerr = deserializeJson(doc, resp);
  if (jerr) { Serial.printf("[claim] bad JSON: %s\n", jerr.c_str()); return false; }
  const char* url = doc["ingest_url"] | "";
  const char* key = doc["ingest_key"] | "";
  if (!*url || !*key) return false;

  cfgIngest = String(url);
  cfgKey    = String(key);
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
// Persist last diagnostic result so the captive portal can show what
// happened on the previous config fetch (URL, HTTP status, first 200 bytes).
static void saveConfigDiag(const String& url, int status, const String& body, const String& note) {
  prefs.begin("voltwatch", false);
  prefs.putString("diag_url",    url);
  prefs.putInt   ("diag_status", status);
  prefs.putString("diag_snip",   body.substring(0, 200));
  prefs.putInt   ("diag_len",    body.length());
  prefs.putString("diag_note",   note);
  prefs.putULong ("diag_ts",     millis() / 1000);
  prefs.end();
}

// Returns true when a JSON config was fetched and parsed (even if the sensor
// list is empty — a valid empty config still counts as "server reachable").
bool refreshConfig() {
  if (WiFi.status() != WL_CONNECTED || cfgConfigUrl.length() == 0) {
    saveConfigDiag(cfgConfigUrl, 0, "", "wifi down or no URL");
    return false;
  }

  HTTPClient http;
  Serial.printf("[config] GET %s\n", cfgConfigUrl.c_str());
  http.begin(cfgConfigUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS); // fixes [config] 302
  http.addHeader("x-ingest-key", cfgKey);
  http.addHeader("x-fw-version", FW_VERSION);
  http.addHeader("x-fw-build", FW_BUILD);
  int code = http.GET();
  String body = http.getString();
  Serial.printf("[config] status %d, %d bytes\n", code, body.length());
  if (code != 200) {
    Serial.printf("[config] err body: %s\n", body.c_str());
    http.end();
    saveConfigDiag(cfgConfigUrl, code, body, "non-200");
    return false;
  }
  http.end();

  // Detect the classic "SPA HTML instead of JSON" case: host is not routing
  // /api/public/config to the server endpoint (wrong host / preview wrapper).
  String head = body.substring(0, 32);
  head.trim();
  head.toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    Serial.println("[config] server returned HTML, not JSON.");
    Serial.println("[config] your ingest URL host isn't serving the API route.");
    Serial.println("[config] use https://project--<project-id>.lovable.app/api/public/config");
    Serial.println("[config] (or the -dev.lovable.app variant for preview).");
    saveConfigDiag(cfgConfigUrl, code, body, "SPA HTML - wrong host");
    return false;
  }

  DynamicJsonDocument doc(8192);
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("[config] parse err: %s\n", err.c_str());
    Serial.printf("[config] first 300 chars: %s\n", body.substring(0, 300).c_str());
    saveConfigDiag(cfgConfigUrl, code, body, String("JSON parse: ") + err.c_str());
    return false;
  }




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
  saveConfigDiag(cfgConfigUrl, code, body, String("OK, ") + sensorCount + " sensor(s)");
  return true;
}

// Retry refreshConfig() with exponential backoff. Delays double each attempt
// starting at 1s, capped at 30s (1, 2, 4, 8, 16, 30, 30, ...). Non-blocking
// updates to the status LED continue via updateLed() during the wait.
// Returns true if the BOOT button has been held LOW continuously for >= 3s.
// Safe to call from anywhere; keeps its own static press-start timestamp.
bool checkPortalButtonHold() {
  static unsigned long pressStart = 0;
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    if (millis() - pressStart > 3000) {
      pressStart = 0;
      return true;
    }
  } else {
    pressStart = 0;
  }
  return false;
}

// Interruptible delay that keeps polling the BOOT button and the LED.
// Returns true if the user held BOOT long enough to request the portal.
bool interruptibleDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    updateLed();
    if (checkPortalButtonHold()) return true;
    delay(20);
  }
  return false;
}

bool refreshConfigWithBackoff(int maxAttempts, const char* reason) {
  Serial.printf("[config] retry loop start (%s), up to %d attempts\n", reason, maxAttempts);
  unsigned long delayMs = 1000;
  for (int attempt = 1; attempt <= maxAttempts; attempt++) {
    Serial.printf("[config] attempt %d/%d\n", attempt, maxAttempts);
    if (refreshConfig()) {
      Serial.printf("[config] recovered on attempt %d\n", attempt);
      setLed(LED_ONLINE);
      return true;
    }
    if (checkPortalButtonHold()) {
      Serial.println("[config] BOOT held during retry — opening portal");
      startConfigPortal(true);
      loadConfig();
      return false;
    }
    if (attempt == maxAttempts) break;
    Serial.printf("[config] retry in %lu ms\n", delayMs);
    setLed(LED_ERROR);
    if (interruptibleDelay(delayMs)) {
      Serial.println("[config] BOOT held during backoff — opening portal");
      startConfigPortal(true);
      loadConfig();
      return false;
    }
    delayMs = min<unsigned long>(delayMs * 2, 30000);
  }
  Serial.println("[config] FINAL FAILURE: could not load config after retries.");
  Serial.println("[config] check: WiFi, ingest URL host, ingest key, and that the device is paired.");
  Serial.println("[config] the ESP will keep retrying on its normal 15s schedule.");
  setLed(LED_ERROR);
  return false;
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
    if (s.kind == "relay") continue;
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
  }

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  Serial.printf("[post] POST %s (%d readings, %d bytes)\n",
                cfgIngest.c_str(), (int)readings.size(), body.length());
  http.begin(cfgIngest);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ingest-key", cfgKey);
  http.addHeader("x-fw-version", FW_VERSION);
  http.addHeader("x-fw-build", FW_BUILD);
  int code = http.POST(body);
  String resp = http.getString();
  Serial.printf("[post] status %d, %d bytes resp\n", code, resp.length());

  if (code == 200) {
    DynamicJsonDocument r(2048);
    DeserializationError perr = deserializeJson(r, resp);
    if (perr) {
      Serial.printf("[post] resp parse err: %s\n", perr.c_str());
      Serial.printf("[post] raw: %s\n", resp.c_str());
    } else {
      int relayCount = 0;
      for (JsonObject rel : r["relays"].as<JsonArray>()) {
        const char* pinStr = rel["pin"] | "";
        bool on = rel["on"] | false;
        int pin = parsePin(pinStr);
        if (pin >= 0) {
          pinMode(pin, OUTPUT);
          digitalWrite(pin, on ? HIGH : LOW);
          relayCount++;
        }
      }
      if (relayCount > 0) Serial.printf("[post] applied %d relay state(s)\n", relayCount);
    }
  } else {
    Serial.printf("[post] err body: %s\n", resp.c_str());
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

  // Set hostname before any WiFi connect so the router registers the right name.
  WiFi.mode(WIFI_STA);
  if (cfgHostname.length() > 0) {
    WiFi.setHostname(cfgHostname.c_str());
    Serial.printf("[cfg] hostname '%s'\n", cfgHostname.c_str());
  }

  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    Serial.println("[cfg] BOOT held — opening portal");
    startConfigPortal(true);
    loadConfig();
  } else {
    startConfigPortal(false);
  }

  if (WiFi.status() == WL_CONNECTED) {
    refreshConfigWithBackoff(7, "boot");
  } else {
    setLed(LED_ERROR);
  }
}

void loop() {
  updateLed();

  static unsigned long pressStart = 0;
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    else if (millis() - pressStart > 3000) {
      startConfigPortal(true);
      loadConfig();
      refreshConfigWithBackoff(7, "portal-reopen");
      pressStart = 0;
    }
  } else {
    pressStart = 0;
  }

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
