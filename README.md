# Voltwatch

A web dashboard for ESP32-based sensor nodes. Flash the firmware once, pair the
device with a 6-digit code, then add / edit / toggle sensors from the app —
the ESP polls for its config every ~15 s, so you never re-flash to change
pins, add a DHT22, or flip a relay.

Stack: **TanStack Start (React 19 + Vite 7)** on Cloudflare Workers, **Lovable
Cloud (Supabase)** for auth, database, and storage, and an **Arduino/ESP32**
sketch for the device side.

---

## 1. Frontend setup

Requirements: [Bun](https://bun.sh) (recommended) or Node 20+.

```bash
bun install
bun run dev      # http://localhost:8080
bun run build    # production build
bun run lint
```

Environment variables live in `.env` and are auto-managed by Lovable Cloud:

| Var | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Backend URL (browser + server) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon key used by the browser client |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | Same values for server functions |

Do **not** edit files under `src/integrations/supabase/` — they are
auto-generated.

Routes are file-based under `src/routes/`. Authenticated pages sit under
`src/routes/_authenticated/`; public HTTP endpoints for the ESP live in
`src/routes/api/public/`.

---

## 2. ESP32 firmware setup

Firmware source: `firmware/voltwatch/voltwatch.ino`. A pre-built binary is
served from `public/firmware/voltwatch-esp32.bin`.

**One-time flash (Arduino IDE):**

1. Install the [Arduino IDE](https://www.arduino.cc/en/software).
2. Add the ESP32 board URL in *Preferences → Additional board manager URLs*:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`,
   then install **esp32** from *Boards Manager*.
3. Install libraries: **WiFiManager** (tzapu), **ArduinoJson** (Blanchon),
   **DHT sensor library** (Adafruit).
4. Open `firmware/voltwatch/voltwatch.ino`, pick *ESP32 Dev Module* and the
   right port, and click Upload.

**First boot — captive portal:**

1. On your phone, join WiFi `Voltwatch-Setup` (password `voltwatch`).
2. The portal opens automatically (or browse to `http://192.168.4.1`).
3. Choose your home WiFi + password.
4. Paste the **Ingest URL** and **Device ingest key** from the dashboard
   (Dashboard → *Show ingest details*, or use the 6-digit pair code flow).
5. Hold the **BOOT** button for ~3 s any time to reopen the portal.

---

## 3. Data flow

```text
                +---------------------+
                |    Web dashboard    |
                | (TanStack + React)  |
                +----------+----------+
                           |
                    Supabase Auth
                           |
                           v
        +------------------+------------------+
        |         Lovable Cloud (DB)          |
        |  devices  sensors  sensor_readings  |
        |  device_pair_codes  ingest_log      |
        +------------------+------------------+
                           ^
                           |  supabaseAdmin (service role, server-only)
                           |
                +----------+-----------+
                |  /api/public/* routes|
                |  (TanStack server)   |
                +----------+-----------+
                           ^
             HTTPS + x-ingest-key header
                           |
                +----------+-----------+
                |        ESP32         |
                |  voltwatch.ino       |
                +----------------------+
```

### Public endpoints the ESP calls

All live under `src/routes/api/public/` and authenticate the device with the
`X-Ingest-Key` header (issued at pair time).

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/public/claim` | POST | Exchange a 6-digit pair code for a `device_id` + `ingest_key` + endpoint URLs |
| `/api/public/config` | GET | Fetch the current sensor list (kind, pin, desired relay state). Polled ~every 15 s |
| `/api/public/ingest` | POST | Push a batch of readings; response includes current relay states |
| `/api/public/state` | GET | Lightweight poll for just the relay states (~5 s cadence) |
| `/api/public/firmware-manifest` | GET | Size + SHA-256 of the served `.bin` for verify-before-flash |
| `/api/public/pair-status` | GET | Used by the pair dialog to detect when the device claims a code |

### Typical lifecycle

1. **Pair** — user opens the pair dialog → app inserts a row in
   `device_pair_codes` with a 6-digit code + expiry. The ESP posts the code to
   `/api/public/claim`, which creates a `devices` row and returns its
   `ingest_key` + the three service URLs. The ESP stores them in flash.
2. **Configure** — user adds a sensor from the dashboard (writes to `sensors`).
   Nothing is pushed to the device.
3. **Sync** — the ESP hits `/api/public/config` on its poll interval, reads
   the sensor list, and starts sampling / driving pins accordingly.
4. **Report** — every cycle the ESP POSTs one batch of readings to
   `/api/public/ingest`. The server inserts them into `sensor_readings`
   (scoped by `user_id` via RLS) and returns the current relay state so the
   ESP can flip outputs on the next tick.
5. **View** — the dashboard subscribes/queries `sensor_readings` and renders
   the live tiles + history charts.

---

## 4. Project layout

```text
src/
  routes/                  file-based routes
    __root.tsx             app shell (head, providers)
    _authenticated/        gated pages (dashboard, setup, sensors…)
    api/public/            HTTP endpoints the ESP32 calls (no auth wall)
  components/              UI + feature components
  integrations/supabase/   auto-generated clients (do not edit)
  lib/                     server helpers, hooks, utilities
firmware/voltwatch/        Arduino sketch flashed to the ESP32
public/firmware/           pre-built .bin + manifest served to browsers
supabase/                  migrations + local config
```

---

## 5. Deploying

Use **Publish** in Lovable to push the current preview to the live URL.
Backend changes (schema, edge functions) deploy immediately; frontend changes
require a Publish/Update. The ESP's stored endpoint URLs keep working across
deploys because `/api/public/*` paths are stable.
