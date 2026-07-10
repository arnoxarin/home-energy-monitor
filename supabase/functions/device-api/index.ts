// Public device API for ESP32 firmware. TLS on *.supabase.co is reliable for
// embedded stacks (unlike lovable.app), so all device-facing endpoints live
// here. JWT verification is disabled — devices authenticate with a
// per-device bearer token stored in the `devices.device_token` column.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function randomToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normaliseMac(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return t.length === 0 ? null : t;
}

async function authDevice(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: json({ error: "missing bearer token" }, 401) };
  const token = m[1].trim();
  const { data: device, error } = await supabase
    .from("devices")
    .select("*")
    .eq("device_token", token)
    .maybeSingle();
  if (error || !device) return { error: json({ error: "invalid token" }, 401) };
  return { device };
}

async function handleRegister(req: Request) {
  let body: { mac?: string; fw_version?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const mac = normaliseMac(body?.mac);
  if (!mac) return json({ error: "mac required" }, 400);
  const fw_version = typeof body.fw_version === "string" ? body.fw_version : null;

  const { data: existing } = await supabase
    .from("devices")
    .select("status")
    .eq("mac", mac)
    .maybeSingle();

  if (existing) {
    // Never re-emit the token — prevents MAC spoofing from claiming another
    // device's credentials.
    return json({ status: existing.status });
  }

  const device_token = randomToken();
  const { error } = await supabase
    .from("devices")
    .insert({ mac, device_token, status: "pending", fw_version, name: mac });
  if (error) return json({ error: error.message }, 500);

  return json({ device_token, status: "pending" });
}

async function handleIngest(req: Request) {
  const auth = await authDevice(req);
  if ("error" in auth) return auth.error;
  const device = auth.device;
  if (device.status !== "approved") return json({ error: "pending approval" }, 403);

  let body: { readings?: Array<{ sensor_id?: string; pin?: string; payload?: Record<string, number> }>; fw_version?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const readings = Array.isArray(body.readings) ? body.readings : [];

  // Look up sensors on this device so ESP32 firmware can post by `pin`
  // instead of hard-coding sensor UUIDs.
  const { data: sensors } = await supabase
    .from("sensors")
    .select("id, pin, user_id")
    .eq("device_id", device.id);
  const byId = new Map((sensors ?? []).map((s) => [s.id, s]));
  const byPin = new Map((sensors ?? []).filter((s) => s.pin).map((s) => [s.pin!, s]));

  const rows: Array<{ sensor_id: string; user_id: string; payload: Record<string, unknown> }> = [];
  for (const r of readings) {
    if (!r || typeof r.payload !== "object" || r.payload === null) continue;
    const match = r.sensor_id ? byId.get(r.sensor_id) : (r.pin ? byPin.get(String(r.pin)) : undefined);
    if (!match) continue;
    rows.push({ sensor_id: match.id, user_id: match.user_id, payload: r.payload });
  }
  if (rows.length > 0) {
    const { error } = await supabase.from("sensor_readings").insert(rows);
    if (error) return json({ error: error.message }, 500);
  }

  await supabase
    .from("devices")
    .update({
      last_seen: new Date().toISOString(),
      ...(typeof body.fw_version === "string" ? { fw_version: body.fw_version } : {}),
    })
    .eq("id", device.id);

  const { data: relays } = await supabase
    .from("sensors")
    .select("id, pin, state")
    .eq("device_id", device.id)
    .eq("kind", "relay");
  return json({
    relays: (relays ?? []).map((r) => ({
      id: r.id,
      pin: r.pin,
      on: (r.state as { on?: boolean } | null)?.on ?? false,
    })),
  });
}

async function handleConfig(req: Request) {
  const auth = await authDevice(req);
  if ("error" in auth) return auth.error;
  const device = auth.device;
  if (device.status !== "approved") return json({ error: "pending approval" }, 403);

  await supabase.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", device.id);

  const { data: sensors } = await supabase
    .from("sensors")
    .select("id, name, kind, pin, view, unit, state")
    .eq("device_id", device.id)
    .order("created_at");

  return json({ sensors: sensors ?? [] });
}

async function handleState(req: Request) {
  const auth = await authDevice(req);
  if ("error" in auth) return auth.error;
  const device = auth.device;
  if (device.status !== "approved") return json({ error: "pending approval" }, 403);

  const { data: relays } = await supabase
    .from("sensors")
    .select("id, pin, state")
    .eq("device_id", device.id)
    .eq("kind", "relay");

  return json({
    relays: (relays ?? []).map((r) => ({
      id: r.id,
      pin: r.pin,
      on: (r.state as { on?: boolean } | null)?.on ?? false,
    })),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // The function is mounted at /functions/v1/device-api and the extra path
  // after that is what we route on.
  const url = new URL(req.url);
  const sub = url.pathname.replace(/^.*\/device-api/, "") || "/";

  try {
    if (sub === "/register" && req.method === "POST") return await handleRegister(req);
    if (sub === "/ingest"   && req.method === "POST") return await handleIngest(req);
    if (sub === "/config"   && req.method === "GET")  return await handleConfig(req);
    if (sub === "/state"    && req.method === "GET")  return await handleState(req);
    return json({ error: "not found", path: sub }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
