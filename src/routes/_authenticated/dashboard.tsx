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
  AlertTriangle,
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
  Download,
  LayoutGrid,
  Rows3,
} from "lucide-react";
import { toast } from "sonner";
import { FirmwareDialog } from "@/components/FirmwareDialog";
import { DeviceStatusDot } from "@/components/DeviceStatusDot";
import { FirmwareBadge } from "@/components/FirmwareBadge";
import { LastSeenBadge } from "@/components/LastSeenBadge";
import { SensorHistoryDialog } from "@/components/SensorHistoryDialog";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ResponsiveGrid = WidthProvider(GridLayout);

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
  fw_version: string | null;
  fw_build: string | null;
  fw_reported_at: string | null;
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

type AlertConfig = { field?: string | null; min?: number | null; max?: number | null };
type AlertStatus = { level: "low" | "high"; field: string; value: number; min: number | null; max: number | null } | null;

function evaluateAlert(sensor: Sensor, payload: Record<string, number> | undefined): AlertStatus {
  const alerts = (sensor.state as { alerts?: AlertConfig } | null)?.alerts;
  if (!alerts || !payload) return null;
  const hasMin = typeof alerts.min === "number";
  const hasMax = typeof alerts.max === "number";
  if (!hasMin && !hasMax) return null;
  const field = alerts.field && alerts.field in payload ? alerts.field : pickPrimaryField(sensor.kind, payload);
  const raw = payload[field];
  if (typeof raw !== "number" || Number.isNaN(raw)) return null;
  if (hasMax && raw > (alerts.max as number)) {
    return { level: "high", field, value: raw, min: alerts.min ?? null, max: alerts.max ?? null };
  }
  if (hasMin && raw < (alerts.min as number)) {
    return { level: "low", field, value: raw, min: alerts.min ?? null, max: alerts.max ?? null };
  }
  return null;
}

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
    refetchInterval: 15_000,
  });

  const sensorsQ = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sensors").select("*").order("created_at");
      if (error) throw error;
      return data as Sensor[];
    },
  });

  // Realtime — append new readings straight into the cache for instant graph updates
  useEffect(() => {
    const ch = supabase
      .channel("readings")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sensor_readings" },
        (payload) => {
          const row = payload.new as Reading;
          if (!row?.sensor_id) return;
          qc.setQueryData<Reading[]>(["readings", row.sensor_id], (prev) => {
            const list = prev ?? [];
            if (list.some((r) => r.id === row.id)) return list;
            const next = [...list, row];
            return next.length > 100 ? next.slice(next.length - 100) : next;
          });
        },
      )
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
            <ExportReadingsDialog sensors={sensorsQ.data ?? []} />
            <FirmwareDialog />
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

function ExportReadingsDialog({ sensors }: { sensors: Sensor[] }) {
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const [sensorId, setSensorId] = useState<string>("__all__");
  const [start, setStart] = useState(weekAgo);
  const [end, setEnd] = useState(today);
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [busy, setBusy] = useState(false);

  const runExport = async () => {
    try {
      setBusy(true);
      const startIso = new Date(`${start}T00:00:00`).toISOString();
      const endIso = new Date(`${end}T23:59:59.999`).toISOString();

      let q = supabase
        .from("sensor_readings")
        .select("sensor_id, ts, payload")
        .gte("ts", startIso)
        .lte("ts", endIso)
        .order("ts", { ascending: true });
      if (sensorId !== "__all__") q = q.eq("sensor_id", sensorId);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as { sensor_id: string; ts: string; payload: Record<string, number> }[];
      if (rows.length === 0) {
        toast.info("No readings in that range");
        return;
      }

      const sensorById = new Map(sensors.map((s) => [s.id, s]));
      const fieldSet = new Set<string>();
      for (const r of rows) for (const k of Object.keys(r.payload ?? {})) fieldSet.add(k);
      const fields = Array.from(fieldSet).sort();

      // Best-effort unit hints per payload field
      const FIELD_UNITS: Record<string, string> = {
        voltage: "V", current: "A", power: "W", energy: "kWh",
        frequency: "Hz", pf: "",
        temperature: "°C", humidity: "%",
        distance: "cm", speed: "m/s",
        value: "", state: "",
      };
      const fieldHeader = (f: string) => {
        const u = FIELD_UNITS[f];
        return u ? `${f} (${u})` : f;
      };

      const header = [
        "timestamp", "sensor_id", "sensor_name", "sensor_kind", "sensor_unit",
        ...fields.map(fieldHeader),
      ];
      const dataRows = rows.map((r) => {
        const s = sensorById.get(r.sensor_id);
        return [
          r.ts,
          r.sensor_id,
          s?.name ?? "",
          s?.kind ?? "",
          s?.unit ?? (s ? (KIND_META[s.kind].unit ?? "") : ""),
          ...fields.map((f) => (r.payload?.[f] ?? "") as string | number),
        ];
      });

      const label = sensorId === "__all__" ? "all-sensors" : (sensorById.get(sensorId)?.name ?? "sensor").replace(/\s+/g, "_");
      const baseName = `readings_${label}_${start}_to_${end}`;

      let blob: Blob;
      let filename: string;
      if (format === "xlsx") {
        const XLSX = await import("xlsx");
        const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
        // Auto-size columns based on max content length
        ws["!cols"] = header.map((h, i) => {
          const maxLen = Math.max(
            String(h).length,
            ...dataRows.map((row) => String(row[i] ?? "").length),
          );
          return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Readings");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        filename = `${baseName}.xlsx`;
      } else {
        const escape = (v: unknown) => {
          const s = v == null ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [header, ...dataRows].map((row) => row.map(escape).join(",")).join("\n");
        blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        filename = `${baseName}.csv`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} reading${rows.length === 1 ? "" : "s"}`);
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="mr-1 h-4 w-4" /> Export
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export sensor readings</DialogTitle>
          <DialogDescription>Choose a sensor, date range, and file format.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Sensor</Label>
            <Select value={sensorId} onValueChange={setSensorId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All sensors</SelectItem>
                {sensors.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Start date</Label>
              <Input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>End date</Label>
              <Input type="date" value={end} min={start} max={today} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as "csv" | "xlsx")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV (.csv)</SelectItem>
                <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={runExport} disabled={busy || !start || !end}>
            {busy ? "Preparing…" : `Download ${format.toUpperCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dashboard-compact") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboard-compact", compact ? "1" : "0");
    }
  }, [compact]);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const [editing, setEditing] = useState(false);


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
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <DeviceStatusDot lastSeenAt={device.last_seen_at} />
            {device.name}
            <FirmwareBadge
              version={device.fw_version}
              build={device.fw_build}
              reportedAt={device.fw_reported_at}
            />
            <LastSeenBadge lastSeenAt={device.last_seen_at} />
          </h2>
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompact((v) => !v)}
            title={compact ? "Switch to comfortable layout" : "Switch to compact layout"}
          >
            {compact ? <LayoutGrid className="mr-1 h-4 w-4" /> : <Rows3 className="mr-1 h-4 w-4" />}
            {compact ? "Comfortable" : "Compact"}
          </Button>
          <Button
            variant={editing ? "default" : "outline"}
            size="sm"
            onClick={() => setEditing((v) => !v)}
            title="Toggle layout edit mode"
          >
            <Pencil className="mr-1 h-4 w-4" />
            {editing ? "Done" : "Edit layout"}
          </Button>
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
        <SortableSensorGrid
          storageKey={`sensor-layout:${device.id}`}
          sensors={sensors}
          compact={compact}
          editing={editing}
        />

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

function SortableSensorGrid({
  storageKey,
  sensors,
  compact,
  editing,
}: {
  storageKey: string;
  sensors: Sensor[];
  compact: boolean;
  editing: boolean;
}) {
  const cols = compact ? 12 : 7;
  const defaultSize = (view: SensorView) => {
    if (compact) {
      return view === "button" ? { w: 2, h: 2 } : view === "numeric" ? { w: 3, h: 3 } : { w: 4, h: 3 };
    }
    return view === "button" ? { w: 2, h: 2 } : view === "numeric" ? { w: 2, h: 2 } : { w: 3, h: 3 };
  };

  const [layout, setLayout] = useState<Layout[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as Layout[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(layout));
    }
  }, [layout, storageKey]);

  // Merge saved layout with sensors: keep saved positions, append new sensors
  const effectiveLayout: Layout[] = useMemo(() => {
    const byId = new Map(layout.map((l) => [l.i, l]));
    const rankBase: Record<SensorView, number> = { graph: 0, numeric: 1, button: 2 };
    const sorted = [...sensors].sort((a, b) => rankBase[a.view] - rankBase[b.view]);
    // find bottom row
    let nextY = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    let nextX = 0;
    const out: Layout[] = [];
    for (const s of sorted) {
      const existing = byId.get(s.id);
      if (existing) {
        out.push(existing);
      } else {
        const sz = defaultSize(s.view);
        if (nextX + sz.w > cols) {
          nextX = 0;
          nextY += sz.h;
        }
        out.push({ i: s.id, x: nextX, y: nextY, w: sz.w, h: sz.h });
        nextX += sz.w;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, sensors, cols, compact]);

  const sensorMap = useMemo(() => new Map(sensors.map((s) => [s.id, s])), [sensors]);

  return (
    <div
      className={`glass-frame mx-auto ${compact ? "max-w-3xl" : "max-w-4xl"} ${editing ? "ring-2 ring-primary/40" : ""}`}
    >
      <ResponsiveGrid
        className="layout"
        layout={effectiveLayout as Layout[]}
        cols={cols}
        rowHeight={compact ? 60 : 90}
        margin={[8, 8]}
        isDraggable={editing}
        isResizable={editing}
        compactType="vertical"
        onLayoutChange={(next: Layout[]) => {
          if (editing) setLayout(next);
        }}
      >
        {effectiveLayout.map((l) => {
          const s = sensorMap.get(l.i);
          if (!s) return <div key={l.i} />;
          return (
            <div key={l.i} className={editing ? "cursor-move" : ""}>
              <SensorCard sensor={s} />
            </div>
          );
        })}
      </ResponsiveGrid>
    </div>
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
    staleTime: 60_000,
  });

  const restoreSensor = useMutation({
    mutationFn: async (snapshot: Sensor) => {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) throw userErr ?? new Error("Not signed in");
      const { error } = await supabase.from("sensors").insert({
        id: snapshot.id,
        device_id: snapshot.device_id,
        user_id: userData.user.id,
        name: snapshot.name,
        kind: snapshot.kind,
        pin: snapshot.pin,
        view: snapshot.view,
        unit: snapshot.unit,
        state: snapshot.state as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor restored");
    },
    onError: (e) => toast.error(`Couldn't restore: ${(e as Error).message}`),
  });

  const deleteSensor = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("sensors").delete().eq("id", sensor.id);
      if (error) throw error;
    },
    onSuccess: () => {
      const snapshot: Sensor = { ...sensor };
      qc.setQueryData<Sensor[]>(["sensors"], (prev) => (prev ?? []).filter((s) => s.id !== sensor.id));
      qc.invalidateQueries({ queryKey: ["sensors"] });
      const freed = [
        sensor.pin,
        ...Object.values((sensor.state as { pins?: Record<string, string> })?.pins ?? {}),
      ].filter((p): p is string => Boolean(p));
      toast.success("Sensor removed", {
        description: freed.length
          ? `Freed pin${freed.length > 1 ? "s" : ""} ${freed.join(", ")} — dropdowns refreshed.`
          : "Dropdowns refreshed.",
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () => restoreSensor.mutate(snapshot),
        },
      });
    },
  });

  const isButton = sensor.view === "button";
  const on = isButton && Boolean((sensor.state as { on?: boolean }).on);
  const latestReading = readingsQ.data?.[readingsQ.data.length - 1];
  const alert = !isButton ? evaluateAlert(sensor, latestReading?.payload) : null;

  return (
    <div
      className={`glass-tile group h-full w-full flex flex-col p-2 text-xs ${on ? "glass-tile-on" : ""} ${
        alert ? "ring-2 ring-destructive/70 shadow-[0_0_0_1px_hsl(var(--destructive)/0.4)]" : ""
      }`}
    >
      {/* Header */}
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-background/40 backdrop-blur-md border border-white/30">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              {sensor.name}
              {sensor.pin ? (
                <span className={`ml-1 font-normal ${on ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                  [{sensor.pin}]
                </span>
              ) : null}
            </p>
            {!isButton && (
              <p className={`truncate text-[10px] uppercase tracking-wide ${on ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                {KIND_META[sensor.kind].label}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {alert && (
            <Badge
              variant="destructive"
              className="flex items-center gap-1 px-1.5 py-0 text-[9px] uppercase"
              title={
                alert.level === "high"
                  ? `${alert.field} ${alert.value.toFixed(2)} > max ${alert.max}`
                  : `${alert.field} ${alert.value.toFixed(2)} < min ${alert.min}`
              }
            >
              <AlertTriangle className="h-3 w-3" />
              {alert.level}
            </Badge>
          )}
          <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Link to="/sensors/$sensorId/edit" params={{ sensorId: sensor.id }}>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit sensor">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </Link>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteSensor.mutate()} title="Delete sensor">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="relative z-10 mt-3 flex-1 min-h-0">
        {isButton ? (
          <RelayControl sensor={sensor} />
        ) : sensor.view === "numeric" ? (
          <NumericView sensor={sensor} readings={readingsQ.data ?? []} />
        ) : (
          <GraphView sensor={sensor} readings={readingsQ.data ?? []} />
        )}
        {alert && (
          <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {alert.level === "high"
              ? `${alert.field} above ${alert.max}${sensor.unit ? ` ${sensor.unit}` : ""}`
              : `${alert.field} below ${alert.min}${sensor.unit ? ` ${sensor.unit}` : ""}`}
          </p>
        )}
      </div>
    </div>
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
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <p className={`text-xs uppercase tracking-[0.2em] ${on ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
        {on ? "On" : "Off"}
      </p>
      <div className="glass-chip px-4 py-2">
        <Switch
          checked={on}
          onCheckedChange={(v) => toggle.mutate(v)}
          className="scale-150 data-[state=checked]:bg-primary-foreground/90"
        />
      </div>
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
  const field = useMemo(
    () => (latest ? pickPrimaryField(sensor.kind, latest.payload) : "value"),
    [latest, sensor.kind],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const activeField = selected ?? field;
  const availableFields = latest ? Object.keys(latest.payload) : [];

  const data = readings.map((r, i) => ({
    t: r.ts ? new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : String(i),
    v: Number(r.payload?.[activeField] ?? 0),
  }));
  const flat = Array.from({ length: 10 }, (_, i) => ({ t: String(i), v: 0 }));
  const chartData = latest ? data : flat;

  return (
    <div className="flex h-full flex-col animate-fade-in">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-2xl font-bold leading-tight">
            {latest && typeof latest.payload[activeField] === "number"
              ? (latest.payload[activeField] as number).toFixed(2)
              : "0.00"}
            {sensor.unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{sensor.unit}</span> : null}
          </p>
          <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{activeField}</p>
        </div>
        {availableFields.length > 1 && (
          <div className="flex flex-wrap justify-end gap-1 max-w-[55%]">
            {availableFields.slice(0, 4).map((f) => (
              <Badge
                key={f}
                variant={f === activeField ? "default" : "outline"}
                className="cursor-pointer px-1.5 py-0 text-[9px] backdrop-blur-md transition-transform hover:scale-105"
                onClick={(e) => { e.stopPropagation(); setSelected(f); }}
              >
                {f}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className={`mt-1 flex-1 min-h-0 ${latest ? "" : "opacity-50"}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 6, right: 6, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in oklab, currentColor 12%, transparent)" />
            <XAxis dataKey="t" tick={{ fontSize: 9 }} hide />
            <YAxis tick={{ fontSize: 9 }} width={28} domain={latest ? ["auto", "auto"] : [0, 1]} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, backdropFilter: "blur(8px)", background: "color-mix(in oklab, var(--color-card) 80%, transparent)" }} />
            <Line
              type="monotone"
              dataKey="v"
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={{ r: 2.5, fill: "var(--color-primary)", strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive
              animationDuration={600}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {!latest && <p className="mt-1 text-[10px] text-muted-foreground text-center">Waiting for data…</p>}
    </div>
  );
}


function GraphView({ sensor, readings }: { sensor: Sensor; readings: Reading[] }) {
  const latest = readings[readings.length - 1];
  const field = useMemo(() => (latest ? pickPrimaryField(sensor.kind, latest.payload) : "value"), [latest, sensor.kind]);
  const [selected, setSelected] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeField = selected ?? field;
  const availableFields = latest ? Object.keys(latest.payload) : [];

  const data = readings.map((r) => ({
    t: new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    v: Number(r.payload?.[activeField] ?? 0),
  }));

  // Tapping the graph area opens the history dialog with date-range switching.
  const openHistory = (e: React.MouseEvent) => {
    // Don't open when a field badge is clicked
    if ((e.target as HTMLElement).closest("[data-graph-badge]")) return;
    setHistoryOpen(true);
  };

  if (!latest) {
    const flat = Array.from({ length: 10 }, (_, i) => ({ t: String(i), v: 0 }));
    return (
      <>
        <div
          className="flex h-full flex-col cursor-pointer transition-transform hover:scale-[1.01]"
          onClick={openHistory}
          role="button"
          aria-label="Open reading history"
        >
          <p className="truncate text-2xl font-bold leading-tight text-muted-foreground/60">
            0.00
            {sensor.unit ? <span className="ml-1 text-xs font-normal">{sensor.unit}</span> : null}
          </p>
          <div className="mt-1 flex-1 min-h-0 opacity-50">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={flat} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in oklab, currentColor 12%, transparent)" />
                <XAxis dataKey="t" hide />
                <YAxis domain={[0, 1]} tick={{ fontSize: 9 }} width={28} />
                <Line type="monotone" dataKey="v" stroke="currentColor" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground text-center">Tap to view history</p>
        </div>
        <SensorHistoryDialog
          sensor={sensor}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          initialField={activeField}
        />
      </>
    );
  }


  return (
    <>
      <div
        className="flex h-full flex-col cursor-pointer transition-transform hover:scale-[1.01]"
        onClick={openHistory}
        role="button"
        aria-label="Open reading history"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-2xl font-bold leading-tight">
              {typeof latest.payload[activeField] === "number"
                ? (latest.payload[activeField] as number).toFixed(2)
                : "—"}
              {sensor.unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{sensor.unit}</span> : null}
            </p>
            <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{activeField}</p>
          </div>
          {availableFields.length > 1 && (
            <div className="flex flex-wrap justify-end gap-1 max-w-[55%]">
              {availableFields.slice(0, 4).map((f) => (
                <Badge
                  key={f}
                  data-graph-badge
                  variant={f === activeField ? "default" : "outline"}
                  className="cursor-pointer px-1.5 py-0 text-[9px] backdrop-blur-md"
                  onClick={(e) => { e.stopPropagation(); setSelected(f); }}
                >
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="mt-1 flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in oklab, currentColor 12%, transparent)" />
              <XAxis dataKey="t" tick={{ fontSize: 9 }} hide />
              <YAxis tick={{ fontSize: 9 }} width={28} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, backdropFilter: "blur(8px)", background: "color-mix(in oklab, var(--color-card) 80%, transparent)" }} />
              <Line type="monotone" dataKey="v" stroke="var(--color-primary)" dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <SensorHistoryDialog
        sensor={sensor}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        initialField={activeField}
      />
    </>
  );
}

