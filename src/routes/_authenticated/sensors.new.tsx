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

// ESP32 (classic / DevKit v1) pin capability lists.
// Notes:
//   - GPIO 6-11 are wired to the SPI flash and must never be exposed.
//   - GPIO 34-39 are input-only (no output, no internal pull-up/down).
//   - ADC2 pins conflict with Wi-Fi, so only ADC1 pins are offered for analog input.
//   - Strapping pins (0, 2, 5, 12, 15) are usable but flagged in the label.
type PinInfo = { pin: string; label: string };

const ANY_OUTPUT: PinInfo[] = [
  { pin: "2",  label: "GPIO 2 (strapping, onboard LED)" },
  { pin: "4",  label: "GPIO 4" },
  { pin: "5",  label: "GPIO 5 (strapping)" },
  { pin: "12", label: "GPIO 12 (strapping)" },
  { pin: "13", label: "GPIO 13" },
  { pin: "14", label: "GPIO 14" },
  { pin: "15", label: "GPIO 15 (strapping)" },
  { pin: "16", label: "GPIO 16" },
  { pin: "17", label: "GPIO 17" },
  { pin: "18", label: "GPIO 18" },
  { pin: "19", label: "GPIO 19" },
  { pin: "21", label: "GPIO 21 (default SDA)" },
  { pin: "22", label: "GPIO 22 (default SCL)" },
  { pin: "23", label: "GPIO 23" },
  { pin: "25", label: "GPIO 25 (DAC)" },
  { pin: "26", label: "GPIO 26 (DAC)" },
  { pin: "27", label: "GPIO 27" },
  { pin: "32", label: "GPIO 32" },
  { pin: "33", label: "GPIO 33" },
];

const ANY_DIGITAL_IO: PinInfo[] = [
  ...ANY_OUTPUT,
  { pin: "34", label: "GPIO 34 (input only)" },
  { pin: "35", label: "GPIO 35 (input only)" },
  { pin: "36", label: "GPIO 36 / VP (input only)" },
  { pin: "39", label: "GPIO 39 / VN (input only)" },
];

const ADC1_PINS: PinInfo[] = [
  { pin: "32", label: "GPIO 32 (ADC1_4)" },
  { pin: "33", label: "GPIO 33 (ADC1_5)" },
  { pin: "34", label: "GPIO 34 (ADC1_6, input only)" },
  { pin: "35", label: "GPIO 35 (ADC1_7, input only)" },
  { pin: "36", label: "GPIO 36 / VP (ADC1_0, input only)" },
  { pin: "39", label: "GPIO 39 / VN (ADC1_3, input only)" },
];

// UART on ESP32: the GPIO matrix can route TX to almost any output-capable
// pin and RX to almost any input-capable pin. UART0 (1/3) is used by USB
// serial, so we exclude those.
const UART_TX_PINS: PinInfo[] = ANY_OUTPUT; // TX must drive the line
const UART_RX_PINS: PinInfo[] = ANY_DIGITAL_IO; // RX just reads

type PinRoleKey = "rx" | "tx" | "data" | "trig" | "echo" | "signal" | "out";
interface PinRole {
  key: PinRoleKey;
  label: string;
  hint: string;
  options: PinInfo[];
}

const PIN_ROLES: Record<SensorKind, PinRole[]> = {
  pzem04: [
    { key: "rx", label: "ESP32 RX pin", hint: "Wire to PZEM TX. Any UART-capable input pin.", options: UART_RX_PINS },
    { key: "tx", label: "ESP32 TX pin", hint: "Wire to PZEM RX. Must be output-capable.",     options: UART_TX_PINS },
  ],
  radar: [
    { key: "rx", label: "ESP32 RX pin", hint: "Wire to radar TX.", options: UART_RX_PINS },
    { key: "tx", label: "ESP32 TX pin", hint: "Wire to radar RX.", options: UART_TX_PINS },
  ],
  dht22: [
    { key: "data", label: "Data pin", hint: "Single-wire data. Needs a 4.7kΩ pull-up. Avoid input-only pins.", options: ANY_OUTPUT },
  ],
  relay: [
    { key: "out", label: "Relay control pin", hint: "Drives the relay coil. Output-capable pin required.", options: ANY_OUTPUT },
  ],
  digital: [
    { key: "signal", label: "Input pin", hint: "Reads HIGH / LOW.", options: ANY_DIGITAL_IO },
  ],
  analog: [
    { key: "signal", label: "ADC pin", hint: "Analog input. ADC2 pins are excluded (they conflict with Wi-Fi).", options: ADC1_PINS },
  ],
  ultrasonic: [
    { key: "trig", label: "TRIG pin", hint: "Output pulse to the sensor.", options: ANY_OUTPUT },
    { key: "echo", label: "ECHO pin", hint: "Reads pulse back. Use a level shifter (5V → 3.3V).", options: ANY_DIGITAL_IO },
  ],
};

const KIND_META: Record<SensorKind, { label: string; description: string; icon: React.ComponentType<{ className?: string }>; defaultView: SensorView; unit?: string; allowedViews: SensorView[] }> = {
  pzem04:     { label: "PZEM-004T (Power)",     description: "UART. Voltage, current, power, energy.",         icon: Zap,         defaultView: "graph",   unit: "W",  allowedViews: ["graph", "numeric"] },
  dht22:      { label: "DHT22 (Temp/Humidity)", description: "1-wire data pin with pull-up.",                  icon: Thermometer, defaultView: "graph",   unit: "°C", allowedViews: ["graph", "numeric"] },
  relay:      { label: "Relay / Switch",        description: "One output pin to drive the coil.",              icon: Power,       defaultView: "button",              allowedViews: ["button"] },
  analog:     { label: "Analog input",          description: "ADC1 pin. Raw 0-4095 reading.",                  icon: Activity,    defaultView: "graph",               allowedViews: ["graph", "numeric"] },
  digital:    { label: "Digital input",         description: "HIGH/LOW state of a GPIO.",                      icon: Cpu,         defaultView: "numeric",             allowedViews: ["numeric", "graph"] },
  ultrasonic: { label: "Ultrasonic HC-SR04",    description: "Two pins: TRIG (output) + ECHO (input).",        icon: Waves,       defaultView: "graph",   unit: "cm", allowedViews: ["graph", "numeric"] },
  radar:      { label: "Radar (LD2410 etc.)",   description: "UART. Presence + distance.",                     icon: Radar,       defaultView: "graph",               allowedViews: ["graph", "numeric"] },
};

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
  const [pins, setPins] = useState<Partial<Record<PinRoleKey, string>>>({});
  const [view, setView] = useState<SensorView>("graph");
  const [unit, setUnit] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const meta = KIND_META[kind];
  const roles = PIN_ROLES[kind];

  useEffect(() => {
    setView(meta.defaultView);
    setUnit(meta.unit ?? "");
    setPins({}); // reset pin assignments when kind changes
  }, [kind, meta.defaultView, meta.unit]);

  useEffect(() => {
    if (!deviceId && devicesQ.data && devicesQ.data.length > 0) setDeviceId(devicesQ.data[0].id);
  }, [devicesQ.data, deviceId]);

  const save = useMutation({
    mutationFn: async () => {
      const errs: Record<string, string> = {};
      if (!deviceId) errs.device_id = "Pick a device";
      const trimmedName = name.trim();
      const nameParse = z.string().trim().min(1).max(60).safeParse(trimmedName);
      if (!nameParse.success) errs.name = "Name is required (max 60 chars)";
      const chosen: string[] = [];
      for (const role of roles) {
        const v = pins[role.key];
        if (!v) errs[`pin.${role.key}`] = `${role.label} required`;
        else if (chosen.includes(v)) errs[`pin.${role.key}`] = "Pin already used above";
        else chosen.push(v);
      }
      if (Object.keys(errs).length > 0) { setErrors(errs); throw new Error("Fix the highlighted fields"); }
      setErrors({});

      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");

      const primaryPin = pins[roles[0].key]!;
      const { error } = await supabase.from("sensors").insert({
        user_id: userData.user.id,
        device_id: deviceId,
        name: trimmedName,
        kind,
        pin: primaryPin, // used to match incoming readings by identifier
        view,
        unit: unit.trim() ? unit.trim() : null,
        state: kind === "relay"
          ? { on: false, pins }
          : { pins },
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
            <CardDescription>
              Assign the sensor to a device. Only pins the ESP32 can use for each role are listed.
            </CardDescription>
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

            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.label} maxLength={60} />
              {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
            </div>

            <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">Pin assignment</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {roles.map((role) => (
                  <div key={role.key} className="space-y-1.5">
                    <Label>{role.label}</Label>
                    <Select
                      value={pins[role.key] ?? ""}
                      onValueChange={(v) => setPins((p) => ({ ...p, [role.key]: v }))}
                    >
                      <SelectTrigger><SelectValue placeholder="Select GPIO" /></SelectTrigger>
                      <SelectContent>
                        {role.options.map((o) => (
                          <SelectItem key={o.pin} value={o.pin}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{role.hint}</p>
                    {errors[`pin.${role.key}`] && <p className="text-xs text-destructive">{errors[`pin.${role.key}`]}</p>}
                  </div>
                ))}
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
