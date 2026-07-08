import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

const ReadingSchema = z.object({
  pin: z.string().optional(),
  sensor_id: z.string().uuid().optional(),
  payload: z.record(z.any()),
});

const BodySchema = z.object({
  readings: z.array(ReadingSchema).min(1).max(50),
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-ingest-key",
};

export const Route = createFileRoute("/api/public/ingest")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      POST: async ({ request }) => {
        const key = request.headers.get("x-ingest-key");
        if (!key) return new Response("Missing x-ingest-key", { status: 401, headers: cors });

        let parsed;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch (e) {
          return new Response(`Bad body: ${(e as Error).message}`, { status: 400, headers: cors });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: device, error: dErr } = await supabaseAdmin
          .from("devices")
          .select("id, user_id")
          .eq("ingest_key", key)
          .maybeSingle();
        if (dErr || !device) return new Response("Invalid key", { status: 401, headers: cors });

        await supabaseAdmin
          .from("devices")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", device.id);

        const { data: sensors } = await supabaseAdmin
          .from("sensors")
          .select("id, pin")
          .eq("device_id", device.id);

        const byPin = new Map((sensors ?? []).map((s) => [s.pin, s.id]));
        const validIds = new Set((sensors ?? []).map((s) => s.id));

        const rows: Array<{ sensor_id: string; user_id: string; payload: unknown }> = [];
        for (const r of parsed.readings) {
          let sid = r.sensor_id;
          if (!sid && r.pin) sid = byPin.get(r.pin);
          if (!sid || !validIds.has(sid)) continue;
          rows.push({ sensor_id: sid, user_id: device.user_id, payload: r.payload });
        }

        if (rows.length === 0) {
          return new Response(JSON.stringify({ inserted: 0, hint: "no matching sensors" }), {
            headers: { "content-type": "application/json", ...cors },
          });
        }

        const { error: iErr } = await supabaseAdmin.from("sensor_readings").insert(rows);
        if (iErr) return new Response(iErr.message, { status: 500, headers: cors });

        // Return current relay states so ESP32 can apply outputs
        const { data: relays } = await supabaseAdmin
          .from("sensors")
          .select("id, pin, state")
          .eq("device_id", device.id)
          .eq("kind", "relay");

        return new Response(
          JSON.stringify({
            inserted: rows.length,
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
