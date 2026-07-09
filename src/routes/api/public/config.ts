import { createFileRoute } from "@tanstack/react-router";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ingest-key",
};

// Public config endpoint used by the ESP32 to auto-configure itself.
// Firmware calls GET /api/public/config with its ingest key and receives the
// full sensor list (kind + pins + desired relay state). No secrets leak — only
// the caller who owns the ingest key can retrieve their own device config.
export const Route = createFileRoute("/api/public/config")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request }) => {
        const key = request.headers.get("x-ingest-key");
        if (!key) return new Response("Missing x-ingest-key", { status: 401, headers: cors });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: device, error: dErr } = await supabaseAdmin
          .from("devices")
          .select("id, name")
          .eq("ingest_key", key)
          .maybeSingle();
        if (dErr || !device) return new Response("Invalid key", { status: 401, headers: cors });

        const fwVersion = request.headers.get("x-fw-version");
        const fwBuild = request.headers.get("x-fw-build");
        if (fwVersion) {
          await supabaseAdmin
            .from("devices")
            .update({
              fw_version: fwVersion,
              fw_build: fwBuild,
              fw_reported_at: new Date().toISOString(),
            })
            .eq("id", device.id);
        }

        const { data: sensors } = await supabaseAdmin
          .from("sensors")
          .select("id, name, kind, pin, state")
          .eq("device_id", device.id);

        const body = {
          device: { id: device.id, name: device.name },
          sensors: (sensors ?? []).map((s) => {
            const st = (s.state as { on?: boolean; pins?: Record<string, string> } | null) ?? {};
            return {
              id: s.id,
              name: s.name,
              kind: s.kind,
              pin: s.pin,
              pins: st.pins ?? {},
              on: st.on ?? false,
            };
          }),
        };

        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", ...cors },
        });
      },
    },
  },
});
