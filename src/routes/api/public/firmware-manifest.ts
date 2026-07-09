import { createFileRoute } from "@tanstack/react-router";

const BIN_PATH = "/firmware/voltwatch-esp32.bin";

// Server-computed manifest for the flashable .bin.
// The client downloads the same .bin, hashes it locally, and compares —
// if they match, what you're about to flash is exactly what the server serves.
export const Route = createFileRoute("/api/public/firmware-manifest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(BIN_PATH, request.url);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          return Response.json(
            { available: false, status: res.status },
            { headers: { "cache-control": "no-store" } },
          );
        }
        const buf = await res.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const sha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return Response.json(
          {
            available: true,
            size: buf.byteLength,
            sha256,
            last_modified: res.headers.get("last-modified"),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
