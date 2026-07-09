import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const BodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().min(1).max(60).optional(),
  fw_version: z.string().max(40).optional(),
  fw_build: z.string().max(80).optional(),
});

export const Route = createFileRoute("/api/public/claim")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, { status: 204, headers: cors }),

      POST: async ({ request }) => {
        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch (e) {
          return new Response(
            JSON.stringify({ error: `Bad body: ${(e as Error).message}` }),
            { status: 400, headers: { ...cors, "content-type": "application/json" } },
          );
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        // Look up the pending code (unclaimed + not expired).
        const { data: pending, error: findErr } = await supabaseAdmin
          .from("device_pair_codes")
          .select("id, user_id, expires_at, claimed_at")
          .eq("code", body.code)
          .is("claimed_at", null)
          .maybeSingle();

        if (findErr) {
          return new Response(
            JSON.stringify({ error: "Lookup failed" }),
            { status: 500, headers: { ...cors, "content-type": "application/json" } },
          );
        }
        if (!pending) {
          return new Response(
            JSON.stringify({ error: "Invalid or already claimed code" }),
            { status: 404, headers: { ...cors, "content-type": "application/json" } },
          );
        }
        if (new Date(pending.expires_at).getTime() < Date.now()) {
          return new Response(
            JSON.stringify({ error: "Code expired" }),
            { status: 410, headers: { ...cors, "content-type": "application/json" } },
          );
        }

        // Create a device row for this user.
        const name = body.name?.trim() || `ESP32 ${body.code}`;
        const { data: device, error: devErr } = await supabaseAdmin
          .from("devices")
          .insert({
            user_id: pending.user_id,
            name,
            fw_version: body.fw_version ?? null,
            fw_build: body.fw_build ?? null,
            fw_reported_at: body.fw_version ? new Date().toISOString() : null,
          })
          .select("id, ingest_key, name")
          .single();

        if (devErr || !device) {
          return new Response(
            JSON.stringify({ error: "Could not create device" }),
            { status: 500, headers: { ...cors, "content-type": "application/json" } },
          );
        }

        // Mark the code claimed.
        await supabaseAdmin
          .from("device_pair_codes")
          .update({
            claimed_at: new Date().toISOString(),
            claimed_device_id: device.id,
          })
          .eq("id", pending.id);

        // Derive URLs from the request origin so the ESP knows exactly where
        // to post readings and fetch its sensor config from.
        const url = new URL(request.url);
        const origin = `${url.protocol}//${url.host}`;

        return new Response(
          JSON.stringify({
            ok: true,
            device_id: device.id,
            device_name: device.name,
            ingest_key: device.ingest_key,
            ingest_url: `${origin}/api/public/ingest`,
            config_url: `${origin}/api/public/config`,
            state_url: `${origin}/api/public/state`,
          }),
          { status: 200, headers: { ...cors, "content-type": "application/json" } },
        );
      },
    },
  },
});
