import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Public debug endpoint: given a 6-digit pairing code, report whether it's
// pending / expired / claimed and — if claimed — return the mapped device
// name and a MASKED ingest key (first 6 + last 4 chars). The code itself is
// the secret, so anyone who knows it could already claim it via /claim.
// We deliberately never return the full ingest_key or user_id here.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const BodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be exactly 6 digits"),
});

function mask(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/pair-status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),

      POST: async ({ request }) => {
        let parsed: z.infer<typeof BodySchema>;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch (e) {
          return json({ ok: false, error: (e as Error).message }, 400);
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        const { data: row, error } = await supabaseAdmin
          .from("device_pair_codes")
          .select(
            "id, code, expires_at, claimed_at, claimed_device_id, created_at",
          )
          .eq("code", parsed.code)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) return json({ ok: false, error: "Lookup failed" }, 500);
        if (!row) return json({ ok: true, status: "unknown", code: parsed.code });

        const now = Date.now();
        const exp = new Date(row.expires_at).getTime();
        const expiresInSec = Math.round((exp - now) / 1000);

        if (row.claimed_at && row.claimed_device_id) {
          const { data: device } = await supabaseAdmin
            .from("devices")
            .select("id, name, ingest_key, last_seen_at, fw_version, fw_build")
            .eq("id", row.claimed_device_id)
            .maybeSingle();

          return json({
            ok: true,
            status: "claimed",
            code: parsed.code,
            claimed_at: row.claimed_at,
            device: device
              ? {
                  id: device.id,
                  name: device.name,
                  ingest_key_masked: mask(device.ingest_key),
                  last_seen_at: device.last_seen_at,
                  fw_version: device.fw_version,
                  fw_build: device.fw_build,
                }
              : null,
            hint:
              "The code has already been redeemed. Generate a fresh 6-digit code from the dashboard to pair another ESP.",
          });
        }

        if (exp < now) {
          return json({
            ok: true,
            status: "expired",
            code: parsed.code,
            expired_at: row.expires_at,
            hint: "Pairing codes are valid for 10 minutes. Generate a new one.",
          });
        }

        return json({
          ok: true,
          status: "pending",
          code: parsed.code,
          expires_at: row.expires_at,
          expires_in_seconds: expiresInSec,
          hint: `Code is valid for ${expiresInSec}s. Enter it into the Voltwatch-Setup captive portal to claim.`,
        });
      },
    },
  },
});
