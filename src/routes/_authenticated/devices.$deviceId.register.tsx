import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Activity,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/devices/$deviceId/register")({
  component: RegisterDevicePage,
});

interface Device {
  id: string;
  name: string;
  ingest_key: string;
  last_seen_at: string | null;
}
interface Sensor {
  id: string;
  device_id: string;
  name: string;
  kind: string;
  pin: string | null;
  unit: string | null;
  state: Record<string, unknown> & { registered?: boolean };
}

function randomHex(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function RegisterDevicePage() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const [showKey, setShowKey] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialised, setInitialised] = useState(false);

  const deviceQ = useQuery({
    queryKey: ["device", deviceId],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("*").eq("id", deviceId).single();
      if (error) throw error;
      return data as Device;
    },
  });

  const sensorsQ = useQuery({
    queryKey: ["sensors", deviceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sensors")
        .select("*")
        .eq("device_id", deviceId)
        .order("created_at");
      if (error) throw error;
      return data as Sensor[];
    },
  });

  // Seed selection from stored `state.registered` once data loads
  useEffect(() => {
    if (!initialised && sensorsQ.data) {
      setSelected(new Set(sensorsQ.data.filter((s) => s.state?.registered).map((s) => s.id)));
      setInitialised(true);
    }
  }, [sensorsQ.data, initialised]);

  const rotate = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("devices")
        .update({ ingest_key: randomHex(24) })
        .eq("id", deviceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device", deviceId] });
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Ingest key regenerated");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const save = useMutation({
    mutationFn: async () => {
      const sensors = sensorsQ.data ?? [];
      const updates = sensors.map((s) => {
        const shouldBe = selected.has(s.id);
        const is = !!s.state?.registered;
        if (shouldBe === is) return null;
        const nextState = { ...(s.state ?? {}), registered: shouldBe };
        return supabase.from("sensors").update({ state: nextState }).eq("id", s.id);
      });
      const results = await Promise.all(updates.filter(Boolean));
      const failed = results.find((r) => r && (r as { error: unknown }).error);
      if (failed) throw (failed as { error: Error }).error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sensors", deviceId] });
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensors linked to device");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const copy = (v: string) => {
    navigator.clipboard.writeText(v);
    toast.success("Copied");
  };

  const sensors = sensorsQ.data ?? [];
  const device = deviceQ.data;

  const toggleAll = (on: boolean) => {
    setSelected(on ? new Set(sensors.map((s) => s.id)) : new Set());
  };

  const linkedSensors = useMemo(
    () => sensors.filter((s) => selected.has(s.id)),
    [sensors, selected],
  );

  const snippet = useMemo(() => {
    if (!device) return "";
    const host = origin.replace(/^https?:\/\//, "");
    const lines = linkedSensors
      .map((s) => `//   ${s.name} (${s.kind})${s.pin ? ` on pin ${s.pin}` : ""}`)
      .join("\n") || "//   (no sensors linked yet)";
    return `// Voltwatch device credentials
const char* INGEST_URL = "https://${host || "YOUR_APP_HOST"}/api/public/ingest";
const char* STATE_URL  = "https://${host || "YOUR_APP_HOST"}/api/public/state";
const char* CONFIG_URL = "https://${host || "YOUR_APP_HOST"}/api/public/config";
const char* INGEST_KEY = "${device.ingest_key}";

// Linked sensors:
${lines}
`;
  }, [device, linkedSensors, origin]);

  const dirty = useMemo(() => {
    if (!sensorsQ.data) return false;
    return sensorsQ.data.some((s) => !!s.state?.registered !== selected.has(s.id));
  }, [sensorsQ.data, selected]);

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/devices" })}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-none">Register device</div>
              <div className="text-xs text-muted-foreground">
                {device?.name ?? "…"}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8 space-y-6">
        {deviceQ.isLoading || !device ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Step 1 — key */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">1. Ingest key</CardTitle>
                <CardDescription>
                  Your ESP32 sends this key with every reading so Voltwatch knows who it is.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 text-xs font-mono flex-1 min-w-0 truncate">
                    {showKey ? device.ingest_key : "•".repeat(Math.min(device.ingest_key.length, 40))}
                  </code>
                  <Button variant="ghost" size="icon" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => copy(device.ingest_key)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm">
                        <KeyRound className="mr-1 h-3.5 w-3.5" /> Regenerate
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Regenerate ingest key?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The current key stops working immediately. You'll need to update firmware
                          or push the new key via the config endpoint.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => rotate.mutate()}>
                          Regenerate
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>

            {/* Step 2 — link sensors */}
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">2. Link sensors</CardTitle>
                  <CardDescription>
                    Pick the sensors this ESP32 is physically wired to. Only linked sensors will
                    accept readings from this key.
                  </CardDescription>
                </div>
                {sensors.length > 0 && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => toggleAll(true)}>All</Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleAll(false)}>None</Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {sensors.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No sensors on this device yet. Add sensors from the{" "}
                    <Link to="/dashboard" className="underline">dashboard</Link>, then come back.
                  </p>
                ) : (
                  sensors.map((s) => {
                    const on = selected.has(s.id);
                    return (
                      <label
                        key={s.id}
                        className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50 cursor-pointer"
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={(v) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (v) next.add(s.id);
                              else next.delete(s.id);
                              return next;
                            });
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{s.name}</span>
                            <Badge variant="secondary" className="text-xs">{s.kind}</Badge>
                            {s.state?.registered && (
                              <Badge variant="outline" className="text-xs gap-1">
                                <CheckCircle2 className="h-3 w-3" /> linked
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {s.pin ? `pin ${s.pin}` : "no pin set"}{s.unit ? ` · ${s.unit}` : ""}
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}

                {sensors.length > 0 && (
                  <div className="flex justify-end pt-2">
                    <Button
                      size="sm"
                      onClick={() => save.mutate()}
                      disabled={!dirty || save.isPending}
                    >
                      {save.isPending ? "Saving…" : "Save links"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Step 3 — snippet */}
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">3. Firmware credentials</CardTitle>
                  <CardDescription>
                    Paste this into your ESP32 sketch (or push it via the captive portal).
                  </CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => copy(snippet)}>
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                </Button>
              </CardHeader>
              <CardContent>
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
                  <code>{snippet}</code>
                </pre>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
