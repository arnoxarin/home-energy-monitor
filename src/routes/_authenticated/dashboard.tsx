import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import {
  Activity,
  Copy,
  LogOut,
  Plus,
  Trash2,
  Pencil,
  Zap,
  Thermometer,
  Power,
  Radar,
  Waves,
  Cpu,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type SensorKind = "pzem04" | "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | "radar";
type SensorView = "graph" | "numeric" | "button";

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
  kind: SensorKind;
  pin: string | null;
  view: SensorView;
  unit: string | null;
  state: Record<string, unknown>;
}
interface Reading {
  id: number;
  sensor_id: string;
  ts: string;
  payload: Record<string, number>;
}

const KIND_META: Record<SensorKind, { label: string; icon: React.ComponentType<{ className?: string }>; defaultView: SensorView; unit?: string; fields: string[] }> = {
  pzem04: { label: "PZEM-04 (Power)", icon: Zap, defaultView: "graph", unit: "W", fields: ["voltage", "current", "power", "energy", "frequency", "pf"] },
  dht22: { label: "DHT22 (Temp/Humidity)", icon: Thermometer, defaultView: "graph", unit: "°C", fields: ["temperature", "humidity"] },
  relay: { label: "Relay / Switch", icon: Power, defaultView: "button", fields: [] },
  analog: { label: "Analog input", icon: Activity, defaultView: "graph", fields: ["value"] },
  digital: { label: "Digital input", icon: Cpu, defaultView: "numeric", fields: ["value"] },
  ultrasonic: { label: "Ultrasonic (Distance)", icon: Waves, defaultView: "graph", unit: "cm", fields: ["distance"] },
  radar: { label: "Radar", icon: Radar, defaultView: "graph", unit: "", fields: ["presence", "distance"] },
};

function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("*").order("created_at");
      if (error) throw error;
      return data as Device[];
    },
  });

  const sensorsQ = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sensors").select("*").order("created_at");
      if (error) throw error;
      return data as Sensor[];
    },
  });

  // Realtime — refetch readings when new ones land
  useEffect(() => {
    const ch = supabase
      .channel("readings")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "sensor_readings" }, () => {
        qc.invalidateQueries({ queryKey: ["readings"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">Voltwatch</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/devices">
              <Button variant="outline" size="sm">Devices</Button>
            </Link>
            <AddDeviceDialog />
            <Button variant="ghost" size="icon" onClick={signOut} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {devicesQ.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (devicesQ.data ?? []).length === 0 ? (
          <EmptyState />
        ) : (
          (devicesQ.data ?? []).map((d) => (
            <DeviceSection
              key={d.id}
              device={d}
              sensors={(sensorsQ.data ?? []).filter((s) => s.device_id === d.id)}
            />
          ))
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add your first device</CardTitle>
        <CardDescription>
          Register your ESP32, then wire up sensors. Voltwatch will show live readings as soon as
          the ESP32 starts posting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AddDeviceDialog />
      </CardContent>
    </Card>
  );
}

function AddDeviceDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("not signed in");
      const { error } = await supabase
        .from("devices")
        .insert({ name: name.trim() || "ESP32", user_id: userData.user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Device added");
      setOpen(false);
      setName("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> Add device
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New device</DialogTitle>
          <DialogDescription>Give your ESP32 a name. A unique ingest key is generated.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main panel" />
        </div>
        <DialogFooter>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceSection({ device, sensors }: { device: Device; sensors: Sensor[] }) {
  const qc = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const deleteDevice = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("devices").delete().eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Device removed");
    },
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">{device.name}</h2>
          <p className="text-xs text-muted-foreground">
            {device.last_seen_at ? `Last seen ${new Date(device.last_seen_at).toLocaleString()}` : "Never seen"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "Hide" : "Show"} ingest details
          </Button>
          <Link to="/sensors/new">
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> Add sensor
            </Button>
          </Link>
          <Button variant="ghost" size="icon" onClick={() => deleteDevice.mutate()} title="Delete device">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {showKey && (
        <Card>
          <CardContent className="space-y-2 py-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Endpoint:</span>
              <code className="rounded bg-muted px-2 py-0.5">{origin}/api/public/ingest</code>
              <CopyBtn value={`${origin}/api/public/ingest`} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Header x-ingest-key:</span>
              <code className="rounded bg-muted px-2 py-0.5">{device.ingest_key}</code>
              <CopyBtn value={device.ingest_key} />
            </div>
            <p className="text-xs text-muted-foreground">
              POST JSON: {`{"readings":[{"pin":"26","payload":{"voltage":230,"current":1.2,"power":276}}]}`}
            </p>
          </CardContent>
        </Card>
      )}

      {sensors.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sensors yet. Add one to get started.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sensors.map((s) => (
            <SensorCard key={s.id} sensor={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function CopyBtn({ value }: { value: string }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-6 w-6"
      onClick={() => {
        navigator.clipboard.writeText(value);
        toast.success("Copied");
      }}
    >
      <Copy className="h-3 w-3" />
    </Button>
  );
}

function AddSensorDialog({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SensorKind>("pzem04");
  const [pin, setPin] = useState("");
  const [view, setView] = useState<SensorView>("graph");

  useEffect(() => {
    setView(KIND_META[kind].defaultView);
  }, [kind]);

  const mut = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("not signed in");
      const { error } = await supabase.from("sensors").insert({
        user_id: userData.user.id,
        device_id: deviceId,
        name: name.trim() || KIND_META[kind].label,
        kind,
        pin: pin.trim() || null,
        view,
        unit: KIND_META[kind].unit ?? null,
        state: kind === "relay" ? { on: false } : {},
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor added");
      setOpen(false);
      setName("");
      setPin("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" /> Add sensor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New sensor</DialogTitle>
          <DialogDescription>Pick a type, assign a pin, choose how it displays.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Sensor type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as SensorKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_META) as SensorKind[]).map((k) => (
                  <SelectItem key={k} value={k}>{KIND_META[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_META[kind].label} />
          </div>
          <div className="space-y-1.5">
            <Label>Pin / identifier</Label>
            <Input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="e.g. 26" />
            <p className="text-xs text-muted-foreground">Use this as "pin" in the ESP32 payload.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Display as</Label>
            <Select value={view} onValueChange={(v) => setView(v as SensorView)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="graph">Graph</SelectItem>
                <SelectItem value="numeric">Numeric</SelectItem>
                <SelectItem value="button">Button (output)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>Create sensor</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SensorCard({ sensor }: { sensor: Sensor }) {
  const qc = useQueryClient();
  const Icon = KIND_META[sensor.kind].icon;

  const readingsQ = useQuery({
    queryKey: ["readings", sensor.id],
    enabled: sensor.view !== "button",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, sensor_id, ts, payload")
        .eq("sensor_id", sensor.id)
        .order("ts", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data as Reading[]).reverse();
    },
    refetchInterval: 5000,
  });

  const deleteSensor = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("sensors").delete().eq("id", sensor.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.setQueryData<Sensor[]>(["sensors"], (prev) => (prev ?? []).filter((s) => s.id !== sensor.id));
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor removed");
    },
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <div>
            <CardTitle className="text-base">{sensor.name}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {KIND_META[sensor.kind].label}
              {sensor.pin ? ` · pin ${sensor.pin}` : ""}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <Link to="/sensors/$sensorId/edit" params={{ sensorId: sensor.id }}>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit sensor">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </Link>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteSensor.mutate()} title="Delete sensor">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {sensor.view === "button" ? (
          <RelayControl sensor={sensor} />
        ) : sensor.view === "numeric" ? (
          <NumericView sensor={sensor} readings={readingsQ.data ?? []} />
        ) : (
          <GraphView sensor={sensor} readings={readingsQ.data ?? []} />
        )}
      </CardContent>
    </Card>
  );
}

function RelayControl({ sensor }: { sensor: Sensor }) {
  const qc = useQueryClient();
  const on = Boolean((sensor.state as { on?: boolean }).on);
  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("sensors")
        .update({ state: { ...sensor.state, on: next } })
        .eq("id", sensor.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sensors"] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{on ? "ON" : "OFF"}</p>
        
      </div>
      <Switch checked={on} onCheckedChange={(v) => toggle.mutate(v)} />
    </div>
  );
}

function pickPrimaryField(kind: SensorKind, payload: Record<string, number>): string {
  const preferred = KIND_META[kind].fields[0];
  if (preferred && preferred in payload) return preferred;
  const first = Object.keys(payload)[0];
  return first ?? "value";
}

function NumericView({ sensor, readings }: { sensor: Sensor; readings: Reading[] }) {
  const latest = readings[readings.length - 1];
  if (!latest) return <p className="text-sm text-muted-foreground">Waiting for data…</p>;
  const entries = Object.entries(latest.payload);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded-lg border p-3">
            <p className="text-xs uppercase text-muted-foreground">{k}</p>
            <p className="text-lg font-semibold">
              {typeof v === "number" ? v.toFixed(2) : String(v)}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Updated {new Date(latest.ts).toLocaleTimeString()}</p>
    </div>
  );
}

function GraphView({ sensor, readings }: { sensor: Sensor; readings: Reading[] }) {
  const latest = readings[readings.length - 1];
  const field = useMemo(() => (latest ? pickPrimaryField(sensor.kind, latest.payload) : "value"), [latest, sensor.kind]);
  const [selected, setSelected] = useState<string | null>(null);
  const activeField = selected ?? field;
  const availableFields = latest ? Object.keys(latest.payload) : [];

  const data = readings.map((r) => ({
    t: new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    v: Number(r.payload?.[activeField] ?? 0),
  }));

  if (!latest) return <p className="text-sm text-muted-foreground">Waiting for data…</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-2xl font-bold">
            {typeof latest.payload[activeField] === "number"
              ? (latest.payload[activeField] as number).toFixed(2)
              : "—"}
            {sensor.unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{sensor.unit}</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">{activeField}</p>
        </div>
        {availableFields.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {availableFields.map((f) => (
              <Badge
                key={f}
                variant={f === activeField ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setSelected(f)}
              >
                {f}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.9 0 0)" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} hide />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="v" stroke="var(--color-primary)" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
