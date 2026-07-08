import { createFileRoute } from "@tanstack/react-router";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ingest-key",
};

// GET /api/public/state — returns relay states for a device (ESP32 polls this)
export const Route = createFileRoute("/api/public/state")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request }) => {
        const key = request.headers.get("x-ingest-key");
        if (!key) return new Response("Missing x-ingest-key", { status: 401, headers: cors });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: device } = await supabaseAdmin
          .from("devices")
          .select("id")
          .eq("ingest_key", key)
          .maybeSingle();
        if (!device) return new Response("Invalid key", { status: 401, headers: cors });

        const { data: relays } = await supabaseAdmin
          .from("sensors")
          .select("id, pin, state")
          .eq("device_id", device.id)
          .eq("kind", "relay");

        return new Response(
          JSON.stringify({
            relays: (relays ?? []).map((r) => ({
              id: r.id,
              pin: r.pin,
              on: (r.state as { on?: boolean } | null)?.on ?? false,
            })),
          }),
          { headers: { "content-type": "application/json", ...cors } },
        );
      },
    },
  },
});
