import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/pair-debug")({
  component: PairDebugPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-destructive">Error: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

type StatusResp = {
  ok: boolean;
  status?: "unknown" | "pending" | "expired" | "claimed";
  code?: string;
  expires_at?: string;
  expires_in_seconds?: number;
  claimed_at?: string;
  expired_at?: string;
  hint?: string;
  error?: string;
  device?: {
    id: string;
    name: string;
    ingest_key_masked: string;
    last_seen_at: string | null;
    fw_version: string | null;
    fw_build: string | null;
  } | null;
};

function statusColor(s?: string) {
  if (s === "pending") return "default" as const;
  if (s === "claimed") return "secondary" as const;
  if (s === "expired" || s === "unknown") return "destructive" as const;
  return "outline" as const;
}

function PairDebugPage() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(false);

  // Show the signed-in user's own recent codes (full detail — RLS gates by user_id).
  const { data: myCodes } = useQuery({
    queryKey: ["my-pair-codes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("device_pair_codes")
        .select("code, expires_at, claimed_at, claimed_device_id, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: myDevices } = useQuery({
    queryKey: ["my-devices-debug"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("devices")
        .select("id, name, ingest_key, last_seen_at, fw_version, fw_build, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: attempts, refetch: refetchAttempts } = useQuery({
    queryKey: ["my-ingest-attempts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ingest_attempts")
        .select("id, ts, endpoint, key_masked, key_len, matched, device_id, fw_version, fw_build, ip, status")
        .order("ts", { ascending: false })
        .limit(30);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 5000,
  });


  async function check() {
    if (!/^\d{6}$/.test(code)) {
      setResult({ ok: false, error: "Enter exactly 6 digits" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/public/pair-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = (await res.json()) as StatusResp;
      setResult(json);
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Pairing debug</h1>
          <p className="text-sm text-muted-foreground">
            Look up any 6-digit code and see which device it maps to.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/devices">Back to devices</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Check a pairing code</CardTitle>
          <CardDescription>
            Public endpoint <code>POST /api/public/pair-status</code>. Ingest
            keys returned here are masked; the section below shows full keys
            for devices you own.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="code">6-digit code</Label>
              <Input
                id="code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
              />
            </div>
            <Button onClick={check} disabled={loading || code.length !== 6}>
              {loading ? "Checking…" : "Check"}
            </Button>
          </div>

          {result && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              {result.status && (
                <div className="mb-2">
                  <Badge variant={statusColor(result.status)}>
                    {result.status.toUpperCase()}
                  </Badge>
                </div>
              )}
              {result.hint && (
                <p className="mb-2 text-muted-foreground">{result.hint}</p>
              )}
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your recent pairing codes</CardTitle>
          <CardDescription>Last 10 codes you generated.</CardDescription>
        </CardHeader>
        <CardContent>
          {!myCodes?.length ? (
            <p className="text-sm text-muted-foreground">
              No codes yet — generate one from the devices page.
            </p>
          ) : (
            <div className="space-y-2">
              {myCodes.map((c) => {
                const now = Date.now();
                const exp = new Date(c.expires_at).getTime();
                const label = c.claimed_at
                  ? "claimed"
                  : exp < now
                    ? "expired"
                    : "pending";
                return (
                  <div
                    key={c.code + c.created_at}
                    className="flex items-center justify-between rounded-md border p-2 text-sm"
                  >
                    <div className="flex items-center gap-3">
                      <code className="rounded bg-muted px-2 py-1 font-mono text-base">
                        {c.code}
                      </code>
                      <Badge variant={statusColor(label)}>{label}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.claimed_at
                        ? `claimed ${new Date(c.claimed_at).toLocaleString()}`
                        : `expires ${new Date(c.expires_at).toLocaleString()}`}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your devices &amp; full ingest keys</CardTitle>
          <CardDescription>
            The exact <code>ingest_key</code> the ESP32 sends in the{" "}
            <code>x-ingest-key</code> header.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!myDevices?.length ? (
            <p className="text-sm text-muted-foreground">No devices yet.</p>
          ) : (
            <div className="space-y-3">
              {myDevices.map((d) => (
                <div key={d.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex items-center justify-between">
                    <div className="font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">
                      last seen{" "}
                      {d.last_seen_at
                        ? new Date(d.last_seen_at).toLocaleString()
                        : "never"}
                    </div>
                  </div>
                  <div className="mt-1 break-all font-mono text-xs">
                    <span className="text-muted-foreground">key:</span>{" "}
                    {d.ingest_key}
                  </div>
                  {d.fw_version && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      fw {d.fw_version} · {d.fw_build}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
