import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function generate6DigitCode(): string {
  // 100000..999999 — no leading zeros so we always show 6 digits.
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Mint a fresh pairing code for the current user. The ESP32 captive portal
 * asks for this code; the /api/public/claim endpoint redeems it and creates
 * a device row wired to the user's account.
 */
export const createPairCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // Try a few times to avoid a collision with an active code.
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generate6DigitCode();
      const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("device_pair_codes")
        .insert({ user_id: userId, code, expires_at })
        .select("id, code, expires_at")
        .single();

      if (!error && data) return data;
      // If it's a unique-index collision on the partial index, retry.
      if (error && !String(error.message).includes("device_pair_codes_active_code_idx")) {
        throw new Error(error.message);
      }
    }
    throw new Error("Could not allocate a pairing code — try again");
  });

/**
 * Poll the status of a pairing code. Returns whether it's been claimed and,
 * if so, the resulting device id + name.
 */
export const getPairCodeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("device_pair_codes")
      .select("id, code, expires_at, claimed_at, claimed_device_id")
      .eq("id", data.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) return { found: false as const };

    let deviceName: string | null = null;
    if (row.claimed_device_id) {
      const { data: dev } = await supabase
        .from("devices")
        .select("name")
        .eq("id", row.claimed_device_id)
        .maybeSingle();
      deviceName = dev?.name ?? null;
    }

    return {
      found: true as const,
      code: row.code,
      expires_at: row.expires_at,
      claimed: !!row.claimed_at,
      device_id: row.claimed_device_id,
      device_name: deviceName,
    };
  });
