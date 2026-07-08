import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Activity, ArrowLeft, Cpu, Power, Radar, Thermometer, Waves, Zap } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/sensors/new")({
  component: NewSensorPage,
});

type SensorKind = "pzem04" | "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | "radar";
type SensorView = "graph" | "numeric" | "button";

const KIND_META: Record<SensorKind, { label: string; description: string; icon: React.ComponentType<{ className?: string }>; defaultView: SensorView; unit?: string; allowedViews: SensorView[] }> = {
  pzem04:     { label: "PZEM-004T (Power)",   description: "Voltage, current, power, energy",       icon: Zap,         defaultView: "graph",   unit: "W",  allowedViews: ["graph", "numeric"] },
  dht22:      { label: "DHT22 (Temp/Humidity)", description: "Temperature and humidity",             icon: Thermometer, defaultView: "graph",   unit: "°C", allowedViews: ["graph", "numeric"] },
  relay:      { label: "Relay / Switch",       description: "Toggle a GPIO output from the app",     icon: Power,       defaultView: "button",              allowedViews: ["button"] },
  analog:     { label: "Analog input",         description: "Raw ADC value from a GPIO",             icon: Activity,    defaultView: "graph",               allowedViews: ["graph", "numeric"] },
  digital:    { label: "Digital input",        description: "HIGH / LOW state of a GPIO",            icon: Cpu,         defaultView: "numeric",             allowedViews: ["numeric", "graph"] },
  ultrasonic: { label: "Ultrasonic (Distance)", description: "HC-SR04 distance in cm",               icon: Waves,       defaultView: "graph",   unit: "cm", allowedViews: ["graph", "numeric"] },
  radar:      { label: "Radar",                description: "Presence + distance (e.g. LD2410)",     icon: Radar,       defaultView: "graph",               allowedViews: ["graph", "numeric"] },
};

const schema = z.object({
  device_id: z.string().uuid({ message: "Pick a device" }),
  kind: z.enum(["pzem04", "dht22", "relay", "analog", "digital", "ultrasonic", "radar"]),
  name: z.string().trim().min(1, "Name is required").max(60, "Max 60 characters"),
  pin: z.string().trim().min(1, "Pin is required").max(16, "Max 16 characters").regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only"),
  view: z.enum(["graph", "numeric", "button"]),
  unit: z.string().trim().max(16, "Max 16 characters").optional().or(z.literal("")),
});

interface Device { id: string; name: string; }

function NewSensorPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("id,name").order("created_at");
      if (error) throw error;
      return data as Device[];
    },
  });

  const [deviceId, setDeviceId] = useState<string>("");
  const [kind, setKind] = useState<SensorKind>("pzem04");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [view, setView] = useState<SensorView>("graph");
  const [unit, setUnit] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const meta = KIND_META[kind];

  useEffect(() => {
    setView(meta.defaultView);
    setUnit(meta.unit ?? "");
  }, [kind, meta.defaultView, meta.unit]);

  useEffect(() => {
    if (!deviceId && devicesQ.data && devicesQ.data.length > 0) setDeviceId(devicesQ.data[0].id);
  }, [devicesQ.data, deviceId]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = schema.safeParse({ device_id: deviceId, kind, name, pin, view, unit });
      if (!parsed.success) {
        const map: Record<string, string> = {};
        for (const issue of parsed.error.issues) map[issue.path.join(".")] = issue.message;
        setErrors(map);
        throw new Error("Fix the highlighted fields");
      }
      setErrors({});
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const { error } = await supabase.from("sensors").insert({
        user_id: userData.user.id,
        device_id: parsed.data.device_id,
        name: parsed.data.name,
        kind: parsed.data.kind,
        pin: parsed.data.pin,
        view: parsed.data.view,
        unit: parsed.data.unit ? parsed.data.unit : null,
        state: parsed.data.kind === "relay" ? { on: false } : {},
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor saved");
      navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const kinds = useMemo(() => Object.keys(KIND_META) as SensorKind[], []);

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/dashboard" })}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Add sensor</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1. Sensor type</CardTitle>
            <CardDescription>Pick what's wired to your ESP32.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={kind} onValueChange={(v) => setKind(v as SensorKind)} className="grid gap-3 sm:grid-cols-2">
              {kinds.map((k) => {
                const m = KIND_META[k];
                const Icon = m.icon;
                const selected = kind === k;
                return (
                  <label
                    key={k}
                    htmlFor={`kind-${k}`}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${selected ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}
                  >
                    <RadioGroupItem id={`kind-${k}`} value={k} className="mt-1" />
                    <Icon className="mt-0.5 h-5 w-5 text-primary" />
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium leading-none">{m.label}</p>
                      <p className="text-xs text-muted-foreground">{m.description}</p>
                    </div>
                  </label>
                );
              })}
            </RadioGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Configuration</CardTitle>
            <CardDescription>Assign it to a device and the ESP32 pin it's wired to.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Device</Label>
              {devicesQ.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (devicesQ.data ?? []).length === 0 ? (
                <p className="text-sm">
                  No devices yet.{" "}
                  <Link to="/devices" className="underline">Create one first</Link>.
                </p>
              ) : (
                <Select value={deviceId} onValueChange={setDeviceId}>
                  <SelectTrigger><SelectValue placeholder="Select device" /></SelectTrigger>
                  <SelectContent>
                    {(devicesQ.data ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.device_id && <p className="text-xs text-destructive">{errors.device_id}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.label} maxLength={60} />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>ESP32 pin</Label>
                <Input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="e.g. 26" maxLength={16} />
                <p className="text-xs text-muted-foreground">Use this string as "pin" in the ESP32 payload.</p>
                {errors.pin && <p className="text-xs text-destructive">{errors.pin}</p>}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Display as</Label>
                <Select value={view} onValueChange={(v) => setView(v as SensorView)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {meta.allowedViews.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v === "graph" ? "Graph" : v === "numeric" ? "Numeric" : "Button (output)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Unit (optional)</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={meta.unit ?? "e.g. W"} maxLength={16} />
                {errors.unit && <p className="text-xs text-destructive">{errors.unit}</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate({ to: "/dashboard" })}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || (devicesQ.data ?? []).length === 0}>
            {save.isPending ? "Saving…" : "Save sensor"}
          </Button>
        </div>
      </main>
    </div>
  );
}
