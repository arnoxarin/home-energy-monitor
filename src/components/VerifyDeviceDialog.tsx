import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CheckCircle2, XCircle, Loader2, ShieldCheck, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type StepStatus = "pending" | "running" | "ok" | "fail";
interface Step {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

interface Props {
  deviceId: string;
  ingestKey: string;
  origin: string;
}

/**
 * One-click post-flash health check.
 *
 * Runs three checks against the same URLs the ESP32 uses, using the
 * device's ingest key from the browser:
 *   1. GET  /api/public/config  — auth + sensor list reachable
 *   2. POST /api/public/ingest  — writes an empty ping (no readings)
 *      to prove the ingest endpoint accepts this key
 *   3. Reads the device row to confirm the firmware has actually
 *      checked in (fw_version populated by ingest/config handlers)
 *
 * This surfaces "cable is right, WiFi is right, firmware is running,
 * backend can see it" in one click — no serial monitor needed.
 */
export function VerifyDeviceDialog({ deviceId, ingestKey, origin }: Props) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [fw, setFw] = useState<{ version: string | null; reportedAt: string | null } | null>(null);

  const ingestUrl = `${origin}/api/public/ingest`;
  const configUrl = `${origin}/api/public/config`;

  const run = async () => {
    setRunning(true);
    setFw(null);
    const initial: Step[] = [
      { key: "config", label: "Config endpoint reachable", status: "running" },
      { key: "ingest", label: "Ingest endpoint accepts key", status: "pending" },
      { key: "checkin", label: "Firmware has checked in", status: "pending" },
    ];
    setSteps(initial);
    const patch = (key: string, s: Partial<Step>) =>
      setSteps((prev) => prev.map((st) => (st.key === key ? { ...st, ...s } : st)));

    // 1. GET /api/public/config
    try {
      const r = await fetch(configUrl, { headers: { "x-ingest-key": ingestKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { sensors?: unknown[] };
      const n = Array.isArray(body.sensors) ? body.sensors.length : 0;
      patch("config", { status: "ok", detail: `${n} sensor(s) configured` });
    } catch (e) {
      patch("config", { status: "fail", detail: (e as Error).message });
      patch("ingest", { status: "fail", detail: "skipped" });
      patch("checkin", { status: "fail", detail: "skipped" });
      setRunning(false);
      return;
    }

    // 2. POST /api/public/ingest with an empty readings array is invalid
    //    by design (min(1)) — so we probe with a harmless synthetic reading
    //    against a pin that likely isn't wired. The endpoint returns 200
    //    with `inserted: 0, hint: "no matching sensors"` when the key is
    //    valid, which is exactly what we want to prove.
    patch("ingest", { status: "running" });
    try {
      const r = await fetch(ingestUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": ingestKey },
        body: JSON.stringify({
          readings: [{ pin: "__verify__", payload: { verify: true } }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      patch("ingest", { status: "ok", detail: "accepted" });
    } catch (e) {
      patch("ingest", { status: "fail", detail: (e as Error).message });
    }

    // 3. Read the device row to see if firmware has reported yet
    patch("checkin", { status: "running" });
    try {
      const { data, error } = await supabase
        .from("devices")
        .select("fw_version, fw_reported_at, last_seen_at")
        .eq("id", deviceId)
        .maybeSingle();
      if (error) throw error;
      if (data?.fw_version) {
        setFw({ version: data.fw_version, reportedAt: data.fw_reported_at });
        patch("checkin", {
          status: "ok",
          detail: `fw ${data.fw_version}${
            data.fw_reported_at ? ` · ${new Date(data.fw_reported_at).toLocaleTimeString()}` : ""
          }`,
        });
      } else if (data?.last_seen_at) {
        patch("checkin", {
          status: "ok",
          detail: "device seen (older firmware, no version reported)",
        });
      } else {
        patch("checkin", {
          status: "fail",
          detail: "no check-in yet — power-cycle the ESP32 and re-run",
        });
      }
    } catch (e) {
      patch("checkin", { status: "fail", detail: (e as Error).message });
    }

    setRunning(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void run();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Verify
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Verify device</DialogTitle>
          <DialogDescription>
            Runs the same requests your ESP32 makes, using this device's ingest key. Green means
            the flash worked and the backend can hear it.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2">
          {steps.map((s) => (
            <li
              key={s.key}
              className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <StepIcon status={s.status} />
              <div className="flex-1">
                <div className="font-medium">{s.label}</div>
                {s.detail && (
                  <div className="text-xs text-muted-foreground break-all">{s.detail}</div>
                )}
              </div>
            </li>
          ))}
          {steps.length === 0 && (
            <li className="text-sm text-muted-foreground">Preparing checks…</li>
          )}
        </ul>

        {fw && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
            <div className="font-medium text-emerald-700 dark:text-emerald-400">
              Firmware {fw.version}
            </div>
            {fw.reportedAt && (
              <div className="text-xs text-muted-foreground">
                Last reported {new Date(fw.reportedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={run} disabled={running}>
            <RefreshCw className={"mr-1 h-3.5 w-3.5 " + (running ? "animate-spin" : "")} />
            Re-run
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "ok") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "fail") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (status === "running")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  return <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />;
}
