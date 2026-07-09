// Shared helper: log every ingest/config attempt (matched + unmatched) so
// the pair-debug page can show what the ESP is actually sending.
// Keeps a masked prefix/suffix of the key so it's identifiable but not leakable
// to anyone who happens to read a log row.
import type { SupabaseClient } from "@supabase/supabase-js";

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export async function logIngestAttempt(
  admin: SupabaseClient,
  params: {
    endpoint: "ingest" | "config";
    request: Request;
    rawKey: string | null;
    device: { id: string; user_id: string } | null;
    status: number;
  },
): Promise<void> {
  const { endpoint, request, rawKey, device, status } = params;
  try {
    await admin.from("ingest_attempts").insert({
      endpoint,
      key_masked: maskKey(rawKey ?? ""),
      key_len: (rawKey ?? "").length,
      matched: !!device,
      device_id: device?.id ?? null,
      user_id: device?.user_id ?? null,
      fw_version: request.headers.get("x-fw-version"),
      fw_build: request.headers.get("x-fw-build"),
      ip:
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for") ??
        null,
      status,
    });
  } catch {
    // never let logging break the actual request
  }
}
