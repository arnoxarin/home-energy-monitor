// Voltwatch ESP32 firmware v2.1.0 — Supabase device API
// =============================================================================
//
// No more ingest keys or pairing codes. The device now talks straight to a
// Supabase Edge Function (the lovable.app host rejects the ESP32's TLS
// handshake; *.supabase.co works reliably with embedded TLS).
//
// First boot:
//   - The ESP32 has no saved WiFi, so it starts its own access point
//     "Voltwatch-Setup" (password: voltwatch).
//   - Connect your phone to it, enter your home WiFi, save. It reboots.
//   - The device then registers itself with the server using its MAC
//     address and silently stores the device token it receives.
//   - Open the dashboard's Devices page and press "Approve" on the new
//     device. Done — data starts flowing.
//
// After that:
//   - The firmware pulls the current sensor list (GET {base}/config)
//     every ~15s. When you add, remove, edit a sensor, or change a pin
//     in the dashboard, the ESP picks it up automatically. No re-flashing.
//   - Relay states from the dashboard are polled via {base}/state and
//     also returned in every ingest response.
//
// To change WiFi later:
//   - Hold BOOT (GPIO 0) for ~3s. Portal reopens.
//
// Required libraries (Arduino IDE > Library Manager):
//   - WiFiManager       by tzapu
//   - ArduinoJson  v7+  by Benoit Blanchon
//   - DHT sensor library by Adafruit (+ Adafruit Unified Sensor)
// =============================================================================

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// Helper: begin an HTTP/HTTPS request. For https:// URLs we use a
// WiFiClientSecure in "insecure" mode (skip cert verification) — the
// ESP32 HTTPClient otherwise returns -1 "connection refused" during the
// TLS handshake because no root CA bundle is loaded.
static bool beginHttp(HTTPClient& http, WiFiClientSecure& tls, const String& url) {
  if (url.startsWith("https://")) {
    tls.setInsecure();
    return http.begin(tls, url);
  }
  return http.begin(url);
}

#include <ArduinoJson.h>
#include <Preferences.h>
#include <DHT.h>
#include <esp_task_wdt.h>
#include <esp_sntp.h>
#include <time.h>
#include <mbedtls/md.h>

// =============================================================================
// Compile-time constants
// =============================================================================

#define FW_VERSION "2.1.0"
#define FW_BUILD   __DATE__ " " __TIME__

// Supabase Edge Function base URL — every device endpoint lives under it:
//   POST {base}/register  {mac, fw_version}              -> {device_token, status}
//   GET  {base}/config    Authorization: Bearer <token>  -> {sensors:[...]}
//   GET  {base}/state     Authorization: Bearer <token>  -> {relays:[...]}
//   POST {base}/ingest    Authorization: Bearer <token>  -> {relays:[...]}
#define API_BASE_URL "https://ggprcbatjelodqmgvxgs.supabase.co/functions/v1/device-api"

// ---------- Pin assignments ----------
static constexpr int PORTAL_BUTTON_PIN = 0;   // BOOT button on most devkits
static constexpr int STATUS_LED_PIN    = 2;   // onboard LED

// ---------- Timing ----------
static constexpr unsigned long POST_INTERVAL_MS        = 5000;    // send readings every 5s
static constexpr unsigned long CONFIG_INTERVAL_MS       = 15000;   // refresh sensor list every 15s
static constexpr unsigned long STATE_POLL_INTERVAL_MS   = 3000;    // lightweight relay state poll
static constexpr unsigned long WIFI_RECONNECT_BASE_MS   = 2000;    // initial WiFi reconnect backoff
static constexpr unsigned long WIFI_RECONNECT_MAX_MS    = 60000;   // max WiFi reconnect backoff
static constexpr unsigned long PORTAL_TIMEOUT_S         = 300;     // captive portal timeout
static constexpr unsigned long BOOT_HOLD_MS             = 3000;    // hold BOOT for 3s to open portal
static constexpr unsigned long WDT_TIMEOUT_S            = 30;      // watchdog timeout in seconds
static constexpr unsigned long NTP_RETRY_INTERVAL_MS    = 300000;  // retry NTP every 5 min until synced

// ---------- Limits ----------
static constexpr int MAX_SENSORS        = 12;
static constexpr int MAX_RETRY_ATTEMPTS = 7;
static constexpr unsigned long RETRY_BASE_MS  = 1000;
static constexpr unsigned long RETRY_MAX_MS   = 30000;
static constexpr size_t LOW_HEAP_THRESHOLD    = 20480;  // 20KB — reboot if below
static constexpr size_t CONFIG_HASH_LEN       = 32;     // SHA-256 digest length

// ---------- WiFi credentials ----------
static const char* AP_NAME = "Voltwatch-Setup";
static const char* AP_PASS = "voltwatch";

// ---------- NTP ----------
static const char* NTP_SERVER  = "pool.ntp.org";
static constexpr long NTP_GMT_OFFSET   = 0;       // UTC
static constexpr int  NTP_DAYLIGHT_OFF = 0;

// =============================================================================
// Forward declarations
// =============================================================================

// Config & persistence
static bool isPlaceholder(const String& s);
static String sanitizeHostname(const String& in);
static void loadConfig();

// Device registration
static bool registerDevice();

// Sensors
static int  parsePin(const char* s);
static void tearDownSensors();
static void applySensor(int i);

// Config fetch
static void saveConfigDiag(const String& url, int status, const String& body, const String& note);
static bool refreshConfig();
static bool refreshConfigWithBackoff(int maxAttempts, const char* reason);

// Relay state polling
static void applyRelayStates(const JsonDocument& doc);
static void pollRelayState();

// Data posting
static long readUltrasonicCm(int trig, int echo);
static void collectAndPost();

// WiFi
static void startConfigPortal(bool onDemand);
static void handleWiFiReconnect();

// Watchdog
static void setupWatchdog();
static void pauseLoopWatchdog();
static void resumeLoopWatchdog();
static void feedWatchdog();

// LED
static void setLed(int s);
static void updateLed();

// Utilities
static bool checkPortalButtonHold();
static bool interruptibleDelay(unsigned long ms);
static void computeSHA256(const String& input, uint8_t* output);
static String getTimestamp();
static void checkHeap();

// =============================================================================
// Logging macros — structured output with severity and timestamp
// =============================================================================

#define LOG_INFO(tag, fmt, ...)  Serial.printf("[%s][INFO ][%s] " fmt "\n", getTimestamp().c_str(), tag, ##__VA_ARGS__)
#define LOG_WARN(tag, fmt, ...)  Serial.printf("[%s][WARN ][%s] " fmt "\n", getTimestamp().c_str(), tag, ##__VA_ARGS__)
#define LOG_ERR(tag, fmt, ...)   Serial.printf("[%s][ERROR][%s] " fmt "\n", getTimestamp().c_str(), tag, ##__VA_ARGS__)

// =============================================================================
// Global state
// =============================================================================

// Persistent preferences
static Preferences prefs;

// Config strings
static String cfgToken;       // per-device bearer token, issued by /register
static String cfgHostname;    // WiFi hostname shown in router

// Endpoint URLs, derived from API_BASE_URL in loadConfig()
static String cfgRegisterUrl;
static String cfgIngest;
static String cfgConfigUrl;
static String cfgStateUrl;

// True once the server has accepted our token (device approved on dashboard)
static bool deviceApproved = false;

// Timing trackers — initialized in setup() to prevent double-fire
static unsigned long lastPost     = 0;
static unsigned long lastConfig   = 0;
static unsigned long lastState    = 0;
static unsigned long lastNtpRetry = 0;

// WiFi reconnect state
static unsigned long wifiReconnectDelay   = WIFI_RECONNECT_BASE_MS;
static unsigned long lastWifiReconnectAt  = 0;
static bool          wifiWasConnected     = false;

// Config diffing — SHA-256 hash of last applied sensor config JSON
static uint8_t lastConfigHash[CONFIG_HASH_LEN] = {0};
static bool    hasConfigHash = false;

// NTP sync flag
static bool ntpSynced = false;

// Task watchdog state. Newer ESP32 Arduino cores often initialize the TWDT
// before setup(), so we must not assume esp_task_wdt_init() succeeds.
static bool loopWatchdogAttached = false;

// =============================================================================
// Status LED — visual feedback for device state
// =============================================================================

enum LedState : uint8_t {
  LED_PORTAL     = 0,   // fast blink: captive portal active
  LED_CONNECTING = 1,   // slow blink: connecting to WiFi
  LED_ONLINE     = 2,   // solid: connected and working
  LED_ERROR      = 3    // triple-flash pattern: something's wrong
};

static LedState ledState = LED_CONNECTING;

static void setLed(int s) {
  ledState = static_cast<LedState>(s);
}

static void updateLed() {
  static unsigned long lastToggle = 0;
  static bool on = false;
  static int pulseIdx = 0;
  const unsigned long now = millis();

  auto blink = [&](unsigned long period) {
    if (now - lastToggle >= period) {
      lastToggle = now;
      on = !on;
      digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
    }
  };

  switch (ledState) {
    case LED_PORTAL:
      blink(150);
      break;
    case LED_CONNECTING:
      blink(600);
      break;
    case LED_ONLINE:
      digitalWrite(STATUS_LED_PIN, HIGH);
      break;
    case LED_ERROR: {
      // Triple-flash pattern: on-off-on-off-on-off then long pause
      static constexpr unsigned long steps[] = {100, 100, 100, 100, 100, 700};
      if (now - lastToggle >= steps[pulseIdx]) {
        lastToggle = now;
        pulseIdx = (pulseIdx + 1) % 6;
        digitalWrite(STATUS_LED_PIN, (pulseIdx % 2 == 0) ? HIGH : LOW);
      }
      break;
    }
  }
}

// =============================================================================
// Dynamic sensor table
// =============================================================================

struct Sensor {
  String id;
  String kind;   // "analog", "digital", "dht22", "dht11", "ultrasonic", "relay"
  int    pin;    // primary pin (signal/data/trig/out)
  int    pinB;   // secondary pin (echo for ultrasonic)
  bool   desiredOn;  // for relays: desired output state
  DHT*   dht;
};

static Sensor sensors[MAX_SENSORS];
static int sensorCount = 0;

static int parsePin(const char* s) {
  if (!s || !*s) return -1;
  // Validate it's a reasonable GPIO number (0–39 for ESP32)
  int pin = atoi(s);
  if (pin < 0 || pin > 39) return -1;
  return pin;
}

static void tearDownSensors() {
  for (int i = 0; i < sensorCount; i++) {
    if (sensors[i].dht) {
      delete sensors[i].dht;
      sensors[i].dht = nullptr;
    }
    if (sensors[i].kind == "relay" && sensors[i].pin >= 0) {
      digitalWrite(sensors[i].pin, LOW);
    }
  }
  sensorCount = 0;
}

static void applySensor(int i) {
  Sensor& s = sensors[i];
  if ((s.kind == "dht22" || s.kind == "dht11") && s.pin >= 0) {
    uint8_t dhtType = (s.kind == "dht11") ? DHT11 : DHT22;
    s.dht = new DHT(s.pin, dhtType);
    s.dht->begin();
  } else if (s.kind == "relay" && s.pin >= 0) {
    pinMode(s.pin, OUTPUT);
    digitalWrite(s.pin, s.desiredOn ? HIGH : LOW);
  } else if (s.kind == "digital" && s.pin >= 0) {
    pinMode(s.pin, INPUT_PULLUP);
  } else if (s.kind == "analog" && s.pin >= 0) {
    // analogRead doesn't need explicit pinMode on ESP32, but set INPUT
    // to be explicit and avoid conflicts with prior OUTPUT mode
    pinMode(s.pin, INPUT);
  } else if (s.kind == "ultrasonic") {
    if (s.pin  >= 0) pinMode(s.pin,  OUTPUT);  // trig
    if (s.pinB >= 0) pinMode(s.pinB, INPUT);    // echo
  }
}

// =============================================================================
// Utility functions
// =============================================================================

static bool isPlaceholder(const String& s) {
  return s.length() == 0 || s.startsWith("__");
}

// Sanitize a user-entered hostname to RFC 952/1123: lowercase letters,
// digits, and '-'; max 32 chars; no leading/trailing '-'.
static String sanitizeHostname(const String& in) {
  String out;
  out.reserve(32);
  for (size_t i = 0; i < in.length() && out.length() < 32; i++) {
    char c = in[i];
    if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
      out += c;
    } else if (c == ' ' || c == '_') {
      out += '-';
    }
  }
  while (out.length() && out[0] == '-') out.remove(0, 1);
  while (out.length() && out[out.length() - 1] == '-') out.remove(out.length() - 1, 1);
  return out;
}

// Compute SHA-256 hash of a string using mbedtls (built into ESP32)
static void computeSHA256(const String& input, uint8_t* output) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&ctx);
  mbedtls_md_update(&ctx, (const unsigned char*)input.c_str(), input.length());
  mbedtls_md_finish(&ctx, output);
  mbedtls_md_free(&ctx);
}

// Return a human-readable timestamp — uses NTP if synced, else uptime
static String getTimestamp() {
  if (ntpSynced) {
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 0)) {
      char buf[20];
      strftime(buf, sizeof(buf), "%H:%M:%S", &timeinfo);
      return String(buf);
    }
  }
  // Fallback: uptime in seconds
  unsigned long s = millis() / 1000;
  char buf[12];
  snprintf(buf, sizeof(buf), "%lus", s);
  return String(buf);
}

// Check free heap and reboot if critically low
static void checkHeap() {
  size_t freeHeap = ESP.getFreeHeap();
  if (freeHeap < LOW_HEAP_THRESHOLD) {
    LOG_ERR("heap", "CRITICAL: only %u bytes free — rebooting!", freeHeap);
    delay(100);
    ESP.restart();
  }
}

// Returns true if the BOOT button has been held LOW continuously for >= 3s
static bool checkPortalButtonHold() {
  static unsigned long pressStart = 0;
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    if (pressStart == 0) pressStart = millis();
    if (millis() - pressStart > BOOT_HOLD_MS) {
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
static bool interruptibleDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    updateLed();
    if (checkPortalButtonHold()) return true;
    feedWatchdog();  // feed watchdog during long waits
    delay(20);
  }
  return false;
}

static void setupWatchdog() {
  esp_task_wdt_config_t twdt_config = {
    .timeout_ms = WDT_TIMEOUT_S * 1000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
    .trigger_panic = true,
  };
  esp_err_t initResult = esp_task_wdt_init(&twdt_config);
  if (initResult == ESP_ERR_INVALID_STATE) {
    // The Arduino core already started the TWDT before setup() with its own
    // short default timeout (~5s). Blocking HTTPS calls (TLS handshake +
    // 10s HTTP timeout) can easily exceed that, which panics and reboots
    // the board mid-request. Reconfigure the existing watchdog to our 30s
    // timeout instead of silently keeping the 5s default.
    initResult = esp_task_wdt_reconfigure(&twdt_config);
  }
  if (initResult != ESP_OK) {
    LOG_WARN("wdt", "init/reconfigure failed: %d", initResult);
  }
  resumeLoopWatchdog();
}

static void pauseLoopWatchdog() {
  if (!loopWatchdogAttached) return;
  esp_err_t result = esp_task_wdt_delete(NULL);
  if (result == ESP_OK || result == ESP_ERR_NOT_FOUND) {
    loopWatchdogAttached = false;
  }
}

static void resumeLoopWatchdog() {
  if (loopWatchdogAttached) return;
  esp_err_t result = esp_task_wdt_add(NULL);
  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    loopWatchdogAttached = true;
  }
}

static void feedWatchdog() {
  if (loopWatchdogAttached) {
    esp_task_wdt_reset();
  }
}

// =============================================================================
// Persistent config — load from NVS, apply defaults
// =============================================================================

static void loadConfig() {
  prefs.begin("voltwatch", true);
  cfgToken    = prefs.getString("token",    "");
  cfgHostname = prefs.getString("hostname", "");
  prefs.end();

  // All endpoints are fixed, derived from the compiled-in Supabase base URL.
  const String base = String(API_BASE_URL);
  cfgRegisterUrl = base + "/register";
  cfgIngest      = base + "/ingest";
  cfgConfigUrl   = base + "/config";
  cfgStateUrl    = base + "/state";
}

// =============================================================================
// NTP time sync
// =============================================================================

static void syncNTP() {
  configTime(NTP_GMT_OFFSET, NTP_DAYLIGHT_OFF, NTP_SERVER);
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 5000)) {
    ntpSynced = true;
    LOG_INFO("ntp", "time synced: %04d-%02d-%02d %02d:%02d:%02d UTC",
             timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
             timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  } else {
    LOG_WARN("ntp", "time sync failed — using uptime timestamps");
    // CRITICAL: stop SNTP after a failed sync. If it keeps retrying in the
    // background, its DNS retry timers race the HTTP client's DNS lookups
    // from the loop task and trip an lwIP assert on core 3.x
    // ("sys_untimeout ... Required to lock TCPIP core functionality!"),
    // which panics and reboots the board. We retry NTP from loop() instead.
    esp_sntp_stop();
  }
}

// =============================================================================
// WiFi + captive portal
// =============================================================================

static void startConfigPortal(bool onDemand) {
  WiFiManager wm;

  // WiFi + hostname only. No pairing codes and no keys — the device
  // registers itself with the server using its MAC address, and you
  // approve it once on the dashboard's Devices page.
  WiFiManagerParameter pHost("hostname", "Device hostname (e.g. voltwatch-kitchen)",
                             cfgHostname.c_str(), 32);
  wm.addParameter(&pHost);

  // ESP32 WiFi scans can briefly drop the SoftAP on some boards/cores.
  // That is exactly what happens when the normal "Configure WiFi" button
  // opens /wifi: the phone loses Voltwatch-Setup and the captive browser
  // closes. Use WiFiManager's no-scan WiFi page instead; it keeps the AP
  // alive and lets the user type the SSID/password manually.
  const char* portalMenu[] = {"wifinoscan", "info", "custom"};
  wm.setMenu(portalMenu, 3);

  // ---- Diagnostics block shown in the captive portal ----
  prefs.begin("voltwatch", true);
  String dUrl    = prefs.getString("diag_url",    "(none yet)");
  int    dStatus = prefs.getInt   ("diag_status", 0);
  String dSnip   = prefs.getString("diag_snip",   "");
  int    dLen    = prefs.getInt   ("diag_len",    0);
  String dNote   = prefs.getString("diag_note",   "(no config fetch attempted yet)");
  unsigned long dTs = prefs.getULong("diag_ts", 0);
  prefs.end();

  // HTML-escape the response snippet
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

  // Build diagnostics HTML — use a local String, not static, so it's freed
  // after the portal closes.
  String diagHtml;
  diagHtml.reserve(512);
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
              "Free heap: " + String(ESP.getFreeHeap()) + " bytes · "
              "FW " FW_VERSION " · " FW_BUILD "</p>";
  wm.setCustomMenuHTML(diagHtml.c_str());

  // On-demand portal (BOOT held): never time out — stay in config mode
  // until the user saves credentials or presses RESET. Auto-connect at
  // boot still uses the normal timeout so the device eventually reboots
  // if no one is around to configure it.
  if (onDemand) {
    // BOOT held: wipe saved WiFi credentials so the ESP cannot silently
    // rejoin the previous network — user MUST configure via portal.
    LOG_INFO("cfg", "on-demand portal — erasing stored WiFi credentials");
    wm.resetSettings();
    WiFi.disconnect(true, true);           // erase NVS WiFi config too
    delay(200);
    wm.setConfigPortalTimeout(0);          // 0 = no timeout, wait forever
    wm.setBreakAfterConfig(true);          // exit as soon as creds are saved
    // Force AP+STA mode BEFORE the portal starts. This keeps the setup
    // hotspot active while the station side later connects to home WiFi.
    WiFi.mode(WIFI_AP_STA);
    delay(100);
  } else {
    wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  }

  setLed(LED_PORTAL);
  wm.setAPCallback([](WiFiManager*) { setLed(LED_PORTAL); });
  wm.setSaveConfigCallback([]() { setLed(LED_CONNECTING); });

  // Apply hostname before WiFi connect so the router registers the right name
  if (cfgHostname.length() > 0) {
    WiFi.setHostname(cfgHostname.c_str());
  }

  // WiFiManager's captive portal is blocking. If loopTask stays subscribed
  // to the task watchdog while a phone is sitting on the portal page, the
  // ESP32 reboots before the user can press Configure WiFi. Pause it only
  // for the portal, then re-enable it for normal operation.
  pauseLoopWatchdog();
  bool ok = onDemand ? wm.startConfigPortal(AP_NAME, AP_PASS)
                     : wm.autoConnect(AP_NAME, AP_PASS);
  resumeLoopWatchdog();
  if (!ok) {
    if (onDemand) {
      // With timeout=0 this shouldn't happen, but guard anyway.
      LOG_WARN("cfg", "on-demand portal exited unexpectedly — rebooting");
    } else {
      LOG_WARN("cfg", "portal timed out — rebooting");
    }
    ESP.restart();
  }

  // Shut down the setup hotspot completely before doing anything else.
  // On-demand mode forces WIFI_AP_STA, and WiFiManager leaves the SoftAP
  // running after the portal exits. A live AP holds 15KB+ of heap and the
  // TLS handshake needs ~40KB free — without this, every HTTPS call after
  // the portal (claim, config) fails with a bogus "connection refused".
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  delay(100);

  // Retrieve portal values
  String newHost = sanitizeHostname(String(pHost.getValue()));
  if (newHost.length() > 0 && newHost != cfgHostname) {
    cfgHostname = newHost;
    WiFi.setHostname(cfgHostname.c_str());
    LOG_INFO("cfg", "hostname set to '%s'", cfgHostname.c_str());
  }

  // Persist config
  prefs.begin("voltwatch", false);
  prefs.putString("hostname", cfgHostname);
  prefs.end();
  LOG_INFO("cfg", "config saved to NVS");

  setLed(LED_ONLINE);
}

// Active WiFi reconnection with exponential backoff
static void handleWiFiReconnect() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      LOG_INFO("wifi", "connected! IP: %s, RSSI: %d dBm",
               WiFi.localIP().toString().c_str(), WiFi.RSSI());
      wifiReconnectDelay = WIFI_RECONNECT_BASE_MS;
      wifiWasConnected = true;
      setLed(LED_ONLINE);
      // Sync time on reconnect if not yet synced
      if (!ntpSynced) syncNTP();
    }
    return;
  }

  // WiFi is disconnected
  if (wifiWasConnected) {
    LOG_WARN("wifi", "connection lost");
    wifiWasConnected = false;
    setLed(LED_ERROR);
  }

  unsigned long now = millis();
  if (now - lastWifiReconnectAt >= wifiReconnectDelay) {
    lastWifiReconnectAt = now;
    LOG_INFO("wifi", "attempting reconnect (backoff %lu ms)...", wifiReconnectDelay);
    WiFi.reconnect();
    // Increase backoff, capped at max
    wifiReconnectDelay = min(wifiReconnectDelay * 2, WIFI_RECONNECT_MAX_MS);
  }
}

// =============================================================================
// Device registration — announce our MAC, receive a device token (first boot)
// =============================================================================

static bool registerDevice() {
  if (WiFi.status() != WL_CONNECTED) {
    LOG_ERR("register", "WiFi not connected");
    return false;
  }

  JsonDocument body;
  body["mac"]        = WiFi.macAddress();
  body["fw_version"] = FW_VERSION;
  String payload;
  serializeJson(body, payload);

  HTTPClient http;
  WiFiClientSecure tls;
  LOG_INFO("register", "POST %s (mac %s)", cfgRegisterUrl.c_str(), WiFi.macAddress().c_str());
  beginHttp(http, tls, cfgRegisterUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);
  int status = http.POST(payload);
  String resp = http.getString();
  http.end();

  LOG_INFO("register", "status %d, %d bytes", status, resp.length());

  if (status != 200) {
    LOG_ERR("register", "server returned %d: %s", status, resp.substring(0, 200).c_str());
    return false;
  }

  JsonDocument doc;
  DeserializationError jerr = deserializeJson(doc, resp);
  if (jerr) {
    LOG_ERR("register", "bad JSON response: %s", jerr.c_str());
    return false;
  }

  // The device token is only returned the FIRST time this MAC registers.
  // On later calls the server just reports our current status.
  const char* token  = doc["device_token"] | "";
  const char* dstate = doc["status"] | "";

  if (*token) {
    cfgToken = String(token);
    prefs.begin("voltwatch", false);
    prefs.putString("token", cfgToken);
    prefs.end();
    LOG_INFO("register", "device token received and saved");
  }

  if (String(dstate) == "approved") {
    deviceApproved = true;
  } else {
    LOG_WARN("register", "device status '%s' — open the dashboard's Devices page and press Approve", dstate);
  }

  return cfgToken.length() > 0;
}

// =============================================================================
// Config fetch — rebuild sensor table only when config changes
// =============================================================================

// Persist diagnostic info so the captive portal can show what happened
static void saveConfigDiag(const String& url, int status, const String& body, const String& note) {
  prefs.begin("voltwatch", false);
  prefs.putString("diag_url",    url);
  prefs.putInt   ("diag_status", status);
  prefs.putString("diag_snip",   body.substring(0, 200));
  prefs.putInt   ("diag_len",    (int)body.length());
  prefs.putString("diag_note",   note);
  prefs.putULong ("diag_ts",     millis() / 1000);
  prefs.end();
}

// Returns true when a JSON config was fetched and parsed successfully.
static bool refreshConfig() {
  if (WiFi.status() != WL_CONNECTED) {
    saveConfigDiag(cfgConfigUrl, 0, "", "wifi down");
    return false;
  }

  // First boot: no device token yet — register with the server first.
  if (cfgToken.length() == 0 && !registerDevice()) {
    saveConfigDiag(cfgRegisterUrl, 0, "", "registration failed — no token yet");
    return false;
  }

  HTTPClient http;
  WiFiClientSecure tls;
  LOG_INFO("config", "GET %s", cfgConfigUrl.c_str());
  beginHttp(http, tls, cfgConfigUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Authorization", "Bearer " + cfgToken);
  http.addHeader("x-fw-version", FW_VERSION);
  http.setTimeout(10000);
  int code = http.GET();

  if (code <= 0) {
    LOG_ERR("config", "HTTP error: %s", http.errorToString(code).c_str());
    http.end();
    saveConfigDiag(cfgConfigUrl, code, "", http.errorToString(code).c_str());
    return false;
  }

  String body = http.getString();
  http.end();

  LOG_INFO("config", "status %d, %d bytes", code, body.length());

  if (code == 401 || code == 403) {
    deviceApproved = false;
    LOG_WARN("config", "device not approved yet — open the dashboard's Devices page and press Approve");
    saveConfigDiag(cfgConfigUrl, code, body, "awaiting approval");
    return false;
  }

  if (code != 200) {
    LOG_ERR("config", "non-200 response: %s", body.substring(0, 200).c_str());
    saveConfigDiag(cfgConfigUrl, code, body, "non-200");
    return false;
  }

  // A 200 from /config means the token is valid and the device is approved.
  deviceApproved = true;

  // Detect HTML served instead of JSON (wrong URL)
  String head = body.substring(0, 32);
  head.trim();
  head.toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) {
    LOG_ERR("config", "server returned HTML, not JSON — wrong URL?");
    saveConfigDiag(cfgConfigUrl, code, body, "HTML - wrong URL");
    return false;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    LOG_ERR("config", "JSON parse error: %s", err.c_str());
    LOG_ERR("config", "first 300 chars: %s", body.substring(0, 300).c_str());
    saveConfigDiag(cfgConfigUrl, code, body, String("JSON parse: ") + err.c_str());
    return false;
  }

  // ---- Config diffing: only rebuild sensors if the config actually changed ----
  // Hash the sensors array portion. If identical to last apply, skip teardown.
  String sensorsJson;
  JsonArray arr = doc["sensors"].as<JsonArray>();
  serializeJson(arr, sensorsJson);

  uint8_t newHash[CONFIG_HASH_LEN];
  computeSHA256(sensorsJson, newHash);

  if (hasConfigHash && memcmp(lastConfigHash, newHash, CONFIG_HASH_LEN) == 0) {
    // Config hasn't changed — skip sensor rebuild
    LOG_INFO("config", "config unchanged (%d sensor(s)), skipping rebuild", sensorCount);
    saveConfigDiag(cfgConfigUrl, code, body,
                   String("OK, unchanged, ") + sensorCount + " sensor(s)");
    return true;
  }

  // Config changed — rebuild sensor table
  LOG_INFO("config", "config changed — rebuilding sensor table");
  tearDownSensors();

  for (JsonObject s : arr) {
    if (sensorCount >= MAX_SENSORS) {
      LOG_WARN("config", "MAX_SENSORS (%d) reached, ignoring remaining", MAX_SENSORS);
      break;
    }

    Sensor& out = sensors[sensorCount];
    out.id        = String((const char*)(s["id"] | ""));
    out.kind      = String((const char*)(s["kind"] | ""));
    out.pin       = parsePin(s["pin"] | "");
    out.pinB      = -1;
    out.desiredOn = s["on"] | false;
    out.dht       = nullptr;

    // Parse per-kind pin mappings from the "pins" sub-object
    JsonObject pins = s["pins"].as<JsonObject>();
    if (out.kind == "ultrasonic") {
      out.pin  = parsePin(pins["trig"] | "");
      out.pinB = parsePin(pins["echo"] | "");
    } else if (out.kind == "dht22" || out.kind == "dht11") {
      const char* p = pins["data"] | "";
      if (*p) out.pin = parsePin(p);
    } else if (out.kind == "relay") {
      const char* p = pins["out"] | "";
      if (*p) out.pin = parsePin(p);
    } else if (out.kind == "digital" || out.kind == "analog") {
      const char* p = pins["signal"] | "";
      if (*p) out.pin = parsePin(p);
    }

    // Validate that we got a usable pin
    if (out.pin < 0 && out.kind != "relay") {
      LOG_WARN("config", "sensor '%s' (kind=%s) has no valid pin — skipping",
               out.id.c_str(), out.kind.c_str());
      continue;
    }

    applySensor(sensorCount);
    sensorCount++;
  }

  // Save the hash so we can diff next time
  memcpy(lastConfigHash, newHash, CONFIG_HASH_LEN);
  hasConfigHash = true;

  LOG_INFO("config", "%d sensor(s) loaded and applied", sensorCount);
  LOG_INFO("heap", "free: %u bytes", ESP.getFreeHeap());
  saveConfigDiag(cfgConfigUrl, code, body, String("OK, ") + sensorCount + " sensor(s)");
  return true;
}

// Retry refreshConfig() with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s, 30s...)
static bool refreshConfigWithBackoff(int maxAttempts, const char* reason) {
  LOG_INFO("config", "retry loop start (%s), up to %d attempts", reason, maxAttempts);
  unsigned long delayMs = RETRY_BASE_MS;

  for (int attempt = 1; attempt <= maxAttempts; attempt++) {
    LOG_INFO("config", "attempt %d/%d", attempt, maxAttempts);

    if (refreshConfig()) {
      LOG_INFO("config", "succeeded on attempt %d", attempt);
      setLed(LED_ONLINE);
      return true;
    }

    if (checkPortalButtonHold()) {
      LOG_INFO("config", "BOOT held during retry — opening portal");
      startConfigPortal(true);
      loadConfig();
      return false;
    }

    if (attempt == maxAttempts) break;

    LOG_INFO("config", "retry in %lu ms", delayMs);
    setLed(LED_ERROR);
    if (interruptibleDelay(delayMs)) {
      LOG_INFO("config", "BOOT held during backoff — opening portal");
      startConfigPortal(true);
      loadConfig();
      return false;
    }
    delayMs = min(delayMs * 2, RETRY_MAX_MS);
  }

  LOG_ERR("config", "FINAL FAILURE: could not load config after %d retries", maxAttempts);
  LOG_ERR("config", "check: WiFi, and that this device is approved on the dashboard's Devices page");
  LOG_ERR("config", "will keep retrying on the normal %lu ms schedule", CONFIG_INTERVAL_MS);
  setLed(LED_ERROR);
  return false;
}

// =============================================================================
// Relay state management
// =============================================================================

// Apply relay states from a JSON document containing a "relays" array.
// Cross-references against the known sensor table for safety.
static void applyRelayStates(const JsonDocument& doc) {
  int applied = 0;
  for (JsonObjectConst rel : doc["relays"].as<JsonArrayConst>()) {
    const char* relayId = rel["id"] | "";
    const char* pinStr  = rel["pin"] | "";
    bool on = rel["on"] | false;

    int pin = parsePin(pinStr);
    if (pin < 0) continue;

    // Safety: only apply to pins we know belong to relay sensors
    bool known = false;
    for (int i = 0; i < sensorCount; i++) {
      if (sensors[i].kind == "relay" && sensors[i].pin == pin) {
        sensors[i].desiredOn = on;
        known = true;
        break;
      }
    }

    if (!known) {
      // Also match by sensor ID if pin doesn't match (config may have changed)
      for (int i = 0; i < sensorCount; i++) {
        if (sensors[i].kind == "relay" && sensors[i].id == String(relayId)) {
          sensors[i].desiredOn = on;
          pin = sensors[i].pin;
          known = true;
          break;
        }
      }
    }

    if (!known || pin < 0) continue;

    pinMode(pin, OUTPUT);
    digitalWrite(pin, on ? HIGH : LOW);
    applied++;
  }

  if (applied > 0) {
    LOG_INFO("relay", "applied %d relay state(s)", applied);
  }
}

// Lightweight relay state polling between ingest cycles
static void pollRelayState() {
  if (WiFi.status() != WL_CONNECTED || cfgStateUrl.length() == 0) return;
  if (sensorCount == 0) return;

  // Only poll if we have at least one relay sensor
  bool hasRelay = false;
  for (int i = 0; i < sensorCount; i++) {
    if (sensors[i].kind == "relay") { hasRelay = true; break; }
  }
  if (!hasRelay) return;

  HTTPClient http;
  WiFiClientSecure tls;
  beginHttp(http, tls, cfgStateUrl);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Authorization", "Bearer " + cfgToken);
  http.setTimeout(5000);
  int code = http.GET();

  if (code != 200) {
    http.end();
    return;
  }

  String resp = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, resp)) return;

  applyRelayStates(doc);
}

// =============================================================================
// Sensor reading & data posting
// =============================================================================

static long readUltrasonicCm(int trig, int echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long dur = pulseIn(echo, HIGH, 30000);  // 30ms timeout (~5m max range)
  if (dur == 0) return -1;
  return dur / 58;  // speed of sound conversion to cm
}

static void collectAndPost() {
  if (WiFi.status() != WL_CONNECTED || cfgIngest.length() == 0) return;
  if (sensorCount == 0) return;

  JsonDocument doc;
  JsonArray readings = doc["readings"].to<JsonArray>();

  for (int i = 0; i < sensorCount; i++) {
    Sensor& s = sensors[i];
    if (s.kind == "relay") continue;  // relays don't produce readings

    JsonObject r = readings.add<JsonObject>();
    r["sensor_id"] = s.id;
    JsonObject p = r["payload"].to<JsonObject>();

    if ((s.kind == "dht22" || s.kind == "dht11") && s.dht) {
      float t = s.dht->readTemperature();
      float h = s.dht->readHumidity();
      if (!isnan(t)) p["temperature"] = serialized(String(t, 1));
      if (!isnan(h)) p["humidity"]    = serialized(String(h, 1));
      if (isnan(t) && isnan(h)) {
        LOG_WARN("dht", "sensor '%s' returned NaN for both temp and humidity", s.id.c_str());
      }
    } else if (s.kind == "analog" && s.pin >= 0) {
      p["value"] = analogRead(s.pin);
    } else if (s.kind == "digital" && s.pin >= 0) {
      p["value"] = digitalRead(s.pin);
    } else if (s.kind == "ultrasonic" && s.pin >= 0 && s.pinB >= 0) {
      long cm = readUltrasonicCm(s.pin, s.pinB);
      if (cm >= 0) {
        p["distance"] = (int)cm;
      } else {
        LOG_WARN("ultra", "sensor '%s' timed out (no echo)", s.id.c_str());
      }
    }
  }

  // Don't post if no readings were actually collected
  if (readings.size() == 0) return;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  WiFiClientSecure tls;
  LOG_INFO("post", "POST %s (%d readings, %d bytes)",
           cfgIngest.c_str(), (int)readings.size(), body.length());
  beginHttp(http, tls, cfgIngest);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + cfgToken);
  http.addHeader("x-fw-version", FW_VERSION);
  http.setTimeout(10000);
  int code = http.POST(body);

  if (code <= 0) {
    LOG_ERR("post", "HTTP error: %s", http.errorToString(code).c_str());
    http.end();
    return;
  }

  String resp = http.getString();
  http.end();
  LOG_INFO("post", "status %d, %d bytes resp", code, resp.length());

  if (code == 200) {
    JsonDocument rdoc;
    DeserializationError perr = deserializeJson(rdoc, resp);
    if (perr) {
      LOG_ERR("post", "response parse error: %s", perr.c_str());
    } else {
      // Apply relay states from ingest response
      applyRelayStates(rdoc);
    }
  } else {
    LOG_ERR("post", "server returned %d: %s", code, resp.substring(0, 200).c_str());
  }
}

// =============================================================================
// Arduino entry points
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("=== Voltwatch ESP32 ===");
  Serial.printf("FW %s  built %s\n", FW_VERSION, FW_BUILD);
  Serial.printf("ESP-IDF: %s  chip: %s  cores: %d  freq: %d MHz\n",
                esp_get_idf_version(), ESP.getChipModel(),
                ESP.getChipCores(), ESP.getCpuFreqMHz());
  Serial.printf("Flash: %d KB  free heap: %u bytes\n",
                ESP.getFlashChipSize() / 1024, ESP.getFreeHeap());
  Serial.println();

  // Hardware setup
  pinMode(PORTAL_BUTTON_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED_PIN, OUTPUT);
  setLed(LED_CONNECTING);

  // Enable hardware watchdog timer. The Arduino core may already have
  // initialized it, so setupWatchdog() handles that case quietly.
  setupWatchdog();

  // Load persistent config
  loadConfig();

  // Set hostname before any WiFi connect
  WiFi.mode(WIFI_STA);
  if (cfgHostname.length() > 0) {
    WiFi.setHostname(cfgHostname.c_str());
    LOG_INFO("cfg", "hostname: '%s'", cfgHostname.c_str());
  }

  // WiFi connect — portal if BOOT held, else auto-connect
  if (digitalRead(PORTAL_BUTTON_PIN) == LOW) {
    LOG_INFO("cfg", "BOOT held at startup — opening portal");
    startConfigPortal(true);
    loadConfig();
  } else {
    startConfigPortal(false);
  }

  // After WiFi connects: fetch config FIRST, then start NTP. If SNTP is
  // started first and its sync fails (common on laptop hotspots that block
  // NTP's UDP port), its background DNS retries race the HTTPS request's
  // DNS lookup and crash the board (lwIP sys_untimeout assert).
  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    // Initial config fetch with retry
    refreshConfigWithBackoff(MAX_RETRY_ATTEMPTS, "boot");
    syncNTP();
  } else {
    setLed(LED_ERROR);
  }

  // Initialize timing to current millis() to prevent immediate double-fire.
  // setup() already fetched config and hasn't posted yet, so these prevent
  // the first loop() iteration from re-fetching immediately.
  lastPost     = millis();
  lastConfig   = millis();
  lastState    = millis();
  lastNtpRetry = millis();

  LOG_INFO("setup", "initialization complete — entering main loop");
  LOG_INFO("heap", "free: %u bytes", ESP.getFreeHeap());
}

void loop() {
  // Feed the hardware watchdog
  feedWatchdog();

  // Update status LED
  updateLed();

  // Check if user wants to open the config portal
  if (checkPortalButtonHold()) {
    LOG_INFO("cfg", "BOOT held — opening portal");
    startConfigPortal(true);
    loadConfig();
    refreshConfigWithBackoff(MAX_RETRY_ATTEMPTS, "portal-reopen");
    // Reset timers after portal
    lastPost   = millis();
    lastConfig = millis();
    lastState  = millis();
  }

  // Active WiFi reconnection
  handleWiFiReconnect();

  // Retry NTP occasionally until it syncs (SNTP is stopped after each
  // failed attempt, so it never races the HTTP client's DNS lookups)
  if (!ntpSynced && millis() - lastNtpRetry >= NTP_RETRY_INTERVAL_MS) {
    lastNtpRetry = millis();
    if (WiFi.status() == WL_CONNECTED) syncNTP();
  }

  // Periodic config refresh
  if (millis() - lastConfig >= CONFIG_INTERVAL_MS) {
    lastConfig = millis();
    if (WiFi.status() == WL_CONNECTED) {
      refreshConfig();
      checkHeap();  // monitor heap on config cycles
    }
  }

  // Periodic relay state polling (lightweight, between ingest cycles)
  if (millis() - lastState >= STATE_POLL_INTERVAL_MS) {
    lastState = millis();
    if (WiFi.status() == WL_CONNECTED) {
      pollRelayState();
    }
  }

  // Periodic data posting
  if (millis() - lastPost >= POST_INTERVAL_MS) {
    lastPost = millis();
    if (WiFi.status() == WL_CONNECTED) {
      collectAndPost();
    }
  }
}
