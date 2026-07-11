import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  LogOut,
  Menu,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Zap,
  Thermometer,
  Power,
  Radar,
  Waves,
  Cpu,
  Download,
  LayoutGrid,
  Rows3,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { FirmwareDialog } from "@/components/FirmwareDialog";
import { ThemeToggle } from "@/components/ThemeToggle";

import { DeviceStatusDot } from "@/components/DeviceStatusDot";
import { FirmwareBadge } from "@/components/FirmwareBadge";
import { LastSeenBadge } from "@/components/LastSeenBadge";
import { TelemetryStatus } from "@/components/TelemetryStatus";
import { recordReading } from "@/lib/telemetry-pulse";
import { SensorHistoryDialog } from "@/components/SensorHistoryDialog";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";

const ResponsiveGrid = WidthProvider(GridLayout);

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type SensorKind = "pzem04" | "dht22" | "relay" | "analog" | "digital" | "ultrasonic" | "radar";
type SensorView = "graph" | "numeric" | "button";

interface Device {
  id: string;
  mac: string;
  name: string | null;
  status: "pending" | "approved" | "blocked";
  fw_version: string | null;
  last_seen: string | null;
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

const KIND_META: Record<
  SensorKind,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    defaultView: SensorView;
    unit?: string;
    fields: string[];
  }
> = {
  pzem04: {
    label: "PZEM-04 (Power)",
    icon: Zap,
    defaultView: "graph",
    unit: "W",
    fields: ["voltage", "current", "power", "energy", "frequency", "pf"],
  },
  dht22: {
    label: "DHT22 (Temp/Humidity)",
    icon: Thermometer,
    defaultView: "graph",
    unit: "°C",
    fields: ["temperature", "humidity"],
  },
  relay: { label: "Relay / Switch", icon: Power, defaultView: "button", fields: [] },
  analog: { label: "Analog input", icon: Activity, defaultView: "graph", fields: ["value"] },
  digital: { label: "Digital input", icon: Cpu, defaultView: "numeric", fields: ["value"] },
  ultrasonic: {
    label: "Ultrasonic (Distance)",
    icon: Waves,
    defaultView: "graph",
    unit: "cm",
    fields: ["distance"],
  },
  radar: {
    label: "Radar",
    icon: Radar,
    defaultView: "graph",
    unit: "",
    fields: ["presence", "distance"],
  },
};

type AlertConfig = { field?: string | null; min?: number | null; max?: number | null };
type AlertStatus = {
  level: "low" | "high";
  field: string;
  value: number;
  min: number | null;
  max: number | null;
} | null;

function evaluateAlert(sensor: Sensor, payload: Record<string, number> | undefined): AlertStatus {
  const alerts = (sensor.state as { alerts?: AlertConfig } | null)?.alerts;
  if (!alerts || !payload) return null;
  const hasMin = typeof alerts.min === "number";
  const hasMax = typeof alerts.max === "number";
  if (!hasMin && !hasMax) return null;
  const field =
    alerts.field && alerts.field in payload ? alerts.field : pickPrimaryField(sensor.kind, payload);
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

  // Batch-load recent readings for every graphable sensor in ONE query and
  // prime the per-sensor cache entries. This eliminates the N+1 waterfall
  // where each SensorCard fired its own request on mount.
  const graphableIds = useMemo(
    () =>
      (sensorsQ.data ?? [])
        .filter((s) => s.view !== "button")
        .map((s) => s.id)
        .sort()
        .join(","),
    [sensorsQ.data],
  );
  useQuery({
    queryKey: ["readings-batch", graphableIds],
    enabled: graphableIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const ids = graphableIds.split(",").filter(Boolean);
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, sensor_id, ts, payload")
        .in("sensor_id", ids)
        .order("ts", { ascending: false })
        .limit(100 * ids.length);
      if (error) throw error;
      const rows = (data ?? []) as Reading[];
      // Group by sensor_id and prime each per-sensor cache.
      const grouped = new Map<string, Reading[]>();
      for (const r of rows) {
        const arr = grouped.get(r.sensor_id) ?? [];
        arr.push(r);
        grouped.set(r.sensor_id, arr);
      }
      for (const id of ids) {
        const list = (grouped.get(id) ?? []).slice(0, 100).reverse();
        qc.setQueryData<Reading[]>(["readings", id], list);
      }
      return rows;
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
          recordReading(row.sensor_id, row.ts ? new Date(row.ts).getTime() : Date.now());
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
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">Voltwatch</span>
          </div>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" title="Menu" aria-label="Open menu">
                  <Menu className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-2">
                <div className="flex flex-col gap-1 [&_button]:w-full [&_button]:justify-start [&_a]:w-full">
                  <FirmwareDialog />
                  <ExportReadingsDialog sensors={sensorsQ.data ?? []} />
                  <Link to="/devices">
                    <Button variant="outline" size="sm">
                      <Plus className="mr-1 h-4 w-4" /> Manage devices
                    </Button>
                  </Link>
                </div>
              </PopoverContent>
            </Popover>
            <ThemeToggle />
            <Button variant="ghost" size="icon" onClick={signOut} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-3 py-5 sm:px-6 sm:py-8 space-y-6 sm:space-y-8">
        {devicesQ.isLoading ? (
          <div
            className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm">Loading your dashboard…</p>
          </div>
        ) : (devicesQ.data ?? []).length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <SummaryBar devices={devicesQ.data ?? []} sensors={sensorsQ.data ?? []} />
            {(devicesQ.data ?? []).map((d, i) => (
              <DeviceSection
                key={d.id}
                device={d}
                index={i}
                sensors={(sensorsQ.data ?? []).filter((s) => s.device_id === d.id)}
              />
            ))}
          </>
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
      const rows = (data ?? []) as {
        sensor_id: string;
        ts: string;
        payload: Record<string, number>;
      }[];
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
        voltage: "V",
        current: "A",
        power: "W",
        energy: "kWh",
        frequency: "Hz",
        pf: "",
        temperature: "°C",
        humidity: "%",
        distance: "cm",
        speed: "m/s",
        value: "",
        state: "",
      };
      const fieldHeader = (f: string) => {
        const u = FIELD_UNITS[f];
        return u ? `${f} (${u})` : f;
      };

      const header = [
        "timestamp",
        "sensor_id",
        "sensor_name",
        "sensor_kind",
        "sensor_unit",
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

      const label =
        sensorId === "__all__"
          ? "all-sensors"
          : (sensorById.get(sensorId)?.name ?? "sensor").replace(/\s+/g, "_");
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
        blob = new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
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
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All sensors</SelectItem>
                {sensors.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Start date</Label>
              <Input
                type="date"
                value={start}
                max={end}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>End date</Label>
              <Input
                type="date"
                value={end}
                min={start}
                max={today}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as "csv" | "xlsx")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
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

function SummaryBar({ devices, sensors }: { devices: Device[]; sensors: Sensor[] }) {
  const qc = useQueryClient();

  // Recomputed each render; the parent re-renders on realtime reading inserts
  // and the device poll, so these figures stay reasonably fresh.
  const now = Date.now();
  const online = devices.filter(
    (d) => d.last_seen && now - new Date(d.last_seen).getTime() < 120_000,
  ).length;

  const activeAlerts = sensors.reduce((count, s) => {
    if (s.view === "button") return count;
    const readings = qc.getQueryData<Reading[]>(["readings", s.id]);
    const latest = readings?.[readings.length - 1];
    return evaluateAlert(s, latest?.payload) ? count + 1 : count;
  }, 0);

  const stats: {
    label: string;
    value: number;
    icon: React.ComponentType<{ className?: string }>;
    tone: string;
  }[] = [
    { label: "Devices", value: devices.length, icon: Cpu, tone: "text-primary" },
    {
      label: "Online",
      value: online,
      icon: Activity,
      tone: online > 0 ? "text-emerald-500" : "text-muted-foreground",
    },
    { label: "Sensors", value: sensors.length, icon: Zap, tone: "text-primary" },
    {
      label: "Active alerts",
      value: activeAlerts,
      icon: AlertTriangle,
      tone: activeAlerts > 0 ? "text-destructive" : "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s, i) => {
        const Icon = s.icon;
        return (
          <Card
            key={s.label}
            className="animate-fade-in-up border-border/60"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted ${s.tone}`}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold leading-none tabular-nums">{s.value}</p>
                <p className="truncate text-xs text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for your first device</CardTitle>
        <CardDescription>
          Flash your ESP32 with the Voltwatch firmware — it will register itself automatically.
          Approve it on the Devices page to bind it to your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link to="/devices">
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" /> Open Devices
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function DeviceSection({
  device,
  index,
  sensors,
}: {
  device: Device;
  index: number;
  sensors: Sensor[];
}) {
  const qc = useQueryClient();
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dashboard-compact") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dashboard-compact", compact ? "1" : "0");
    }
  }, [compact]);
  const [editing, setEditing] = useState(false);
  const [showGraph, setShowGraph] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(`dashboard-graph:${device.id}`) === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`dashboard-graph:${device.id}`, showGraph ? "1" : "0");
    }
  }, [showGraph, device.id]);

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

  // Friendly fallback so a freshly-registered board reads "ESP 1", "ESP 2"…
  // instead of a raw MAC address. Persisted names still win.
  const fallbackName = `ESP ${index + 1}`;
  const displayName = device.name?.trim() || fallbackName;

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(displayName);

  const renameDevice = useMutation({
    mutationFn: async () => {
      const next = draftName.trim();
      const { error } = await supabase
        .from("devices")
        .update({ name: next || null })
        .eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Renamed");
      setRenaming(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold flex flex-wrap items-center gap-2">
            <DeviceStatusDot lastSeenAt={device.last_seen} />
            {renaming ? (
              <span className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameDevice.mutate();
                    if (e.key === "Escape") {
                      setDraftName(displayName);
                      setRenaming(false);
                    }
                  }}
                  maxLength={60}
                  placeholder={fallbackName}
                  className="h-8 w-44 text-base"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-emerald-600"
                  onClick={() => renameDevice.mutate()}
                  disabled={renameDevice.isPending}
                  title="Save name"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    setDraftName(displayName);
                    setRenaming(false);
                  }}
                  title="Cancel"
                >
                  <X className="h-4 w-4" />
                </Button>
              </span>
            ) : (
              <span className="group/name flex items-center gap-1">
                {displayName}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => {
                    setDraftName(device.name?.trim() || "");
                    setRenaming(true);
                  }}
                  title="Rename device"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </span>
            )}
            <TelemetryStatus sensorIds={sensors.map((s) => s.id)} lastSeenAt={device.last_seen} />
            <FirmwareBadge version={device.fw_version} build={null} reportedAt={null} />
            <LastSeenBadge lastSeenAt={device.last_seen} />
          </h2>
          <p className="text-xs text-muted-foreground">
            MAC <code className="font-mono">{device.mac}</code>
            {device.last_seen ? (
              <> · Last seen {new Date(device.last_seen).toLocaleString()}</>
            ) : (
              " · Never seen"
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/sensors/new">
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> Add sensor
            </Button>
          </Link>
          {sensors.some((s) => s.view !== "button") && (
            <Button
              variant={showGraph ? "default" : "outline"}
              size="sm"
              onClick={() => setShowGraph((v) => !v)}
              title="Toggle live graph panel"
            >
              <Activity className="mr-1 h-4 w-4" />
              {showGraph ? "Hide graph" : "Live graph"}
            </Button>
          )}
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
          <Button
            variant="ghost"
            size="icon"
            onClick={() => deleteDevice.mutate()}
            title="Delete device"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {sensors.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sensors yet. Add one to get started.</p>
      ) : (
        <>
          {showGraph && (
            <div className="animate-fade-in-up">
              <SensorGraphPanel sensors={sensors} />
            </div>
          )}
          <SortableSensorGrid
            storageKey={`sensor-layout:${device.id}`}
            sensors={sensors}
            compact={compact}
            editing={editing}
          />
        </>
      )}
    </section>
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
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_META) as SensorKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_META[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={KIND_META[kind].label}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Pin / identifier</Label>
            <Input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="e.g. 26" />
            <p className="text-xs text-muted-foreground">Use this as "pin" in the ESP32 payload.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Display as</Label>
            <Select value={view} onValueChange={(v) => setView(v as SensorView)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="graph">Graph</SelectItem>
                <SelectItem value="numeric">Numeric</SelectItem>
                <SelectItem value="button">Button (output)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            Create sensor
          </Button>
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
  const isMobile = useIsMobile();
  const cols = isMobile ? 4 : compact ? 12 : 7;
  const defaultSize = (view: SensorView) => {
    if (isMobile) {
      return view === "button"
        ? { w: 2, h: 2 }
        : view === "numeric"
          ? { w: 4, h: 2 }
          : { w: 4, h: 3 };
    }
    if (compact) {
      return view === "button"
        ? { w: 2, h: 2 }
        : view === "numeric"
          ? { w: 3, h: 3 }
          : { w: 4, h: 3 };
    }
    return view === "button"
      ? { w: 2, h: 2 }
      : view === "numeric"
        ? { w: 2, h: 2 }
        : { w: 3, h: 3 };
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

  // Drop layout entries for sensors that no longer exist (e.g. after a delete)
  // so the leftover slot doesn't linger and vertical compaction can pull the
  // remaining tiles up to fill the gap.
  useEffect(() => {
    setLayout((prev) => {
      const ids = new Set(sensors.map((s) => s.id));
      const pruned = prev.filter((l) => ids.has(l.i));
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [sensors]);

  // Merge saved layout with sensors: keep saved positions, append new sensors.
  // On mobile, ignore the saved (desktop) layout and lay tiles out fresh so
  // nothing overflows the 4-column mobile grid.
  const effectiveLayout: Layout[] = useMemo(() => {
    const source = isMobile ? [] : layout;
    const byId = new Map(source.map((l) => [l.i, l]));
    const rankBase: Record<SensorView, number> = { graph: 0, numeric: 1, button: 2 };
    const sorted = [...sensors].sort((a, b) => rankBase[a.view] - rankBase[b.view]);
    let nextY = source.reduce((m, l) => Math.max(m, l.y + l.h), 0);
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
  }, [layout, sensors, cols, compact, isMobile]);

  const sensorMap = useMemo(() => new Map(sensors.map((s) => [s.id, s])), [sensors]);

  return (
    <div
      className={`glass-frame mx-auto ${compact ? "max-w-3xl" : "max-w-4xl"} ${editing && !isMobile ? "ring-2 ring-primary/40" : ""}`}
    >
      <ResponsiveGrid
        className="layout"
        layout={effectiveLayout as Layout[]}
        cols={cols}
        rowHeight={isMobile ? 70 : compact ? 60 : 90}
        margin={[8, 8]}
        isDraggable={editing && !isMobile}
        isResizable={editing && !isMobile}
        compactType="vertical"
        onLayoutChange={(next: Layout[]) => {
          if (editing && !isMobile) setLayout(next);
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
      qc.setQueryData<Sensor[]>(["sensors"], (prev) =>
        (prev ?? []).filter((s) => s.id !== sensor.id),
      );
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
      className={`glass-tile group h-full w-full flex flex-col p-2 text-xs animate-fade-in ${on ? "glass-tile-on" : ""} ${
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
                <span className={`ml-1 font-normal ${on ? "tile-on-muted" : "tile-muted"}`}>
                  [{sensor.pin}]
                </span>
              ) : null}
            </p>
            {!isButton && (
              <p
                className={`truncate text-[10px] uppercase tracking-wide ${on ? "tile-on-muted" : "tile-muted"}`}
              >
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
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => deleteSensor.mutate()}
              title="Delete sensor"
            >
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
      <p className={`text-xs uppercase tracking-[0.2em] ${on ? "tile-on-muted" : "tile-muted"}`}>
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
    t: r.ts
      ? new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : String(i),
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
            {sensor.unit ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">{sensor.unit}</span>
            ) : null}
          </p>
          <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {activeField}
          </p>
        </div>
        {availableFields.length > 1 && (
          <div className="flex flex-wrap justify-end gap-1 max-w-[55%]">
            {availableFields.slice(0, 4).map((f) => (
              <Badge
                key={f}
                variant={f === activeField ? "default" : "outline"}
                className="cursor-pointer px-1.5 py-0 text-[9px] backdrop-blur-md transition-transform hover:scale-105"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(f);
                }}
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
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis dataKey="t" tick={{ fontSize: 9 }} hide />
            <YAxis tick={{ fontSize: 9 }} width={28} domain={latest ? ["auto", "auto"] : [0, 1]} />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                backdropFilter: "blur(8px)",
                background: "color-mix(in oklab, var(--color-card) 80%, transparent)",
              }}
            />
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
      {!latest && (
        <p className="mt-1 text-[10px] text-muted-foreground text-center">Waiting for data…</p>
      )}
    </div>
  );
}

function GraphView({ sensor, readings }: { sensor: Sensor; readings: Reading[] }) {
  const latest = readings[readings.length - 1];
  const field = useMemo(
    () => (latest ? pickPrimaryField(sensor.kind, latest.payload) : "value"),
    [latest, sensor.kind],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeField = selected ?? field;
  const availableFields = latest ? Object.keys(latest.payload) : [];

  const data = readings.map((r) => ({
    t: new Date(r.ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
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
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis dataKey="t" hide />
                <YAxis domain={[0, 1]} tick={{ fontSize: 9 }} width={28} />
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="var(--chart-line-muted)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
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
              {sensor.unit ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {sensor.unit}
                </span>
              ) : null}
            </p>
            <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
              {activeField}
            </p>
          </div>
          {availableFields.length > 1 && (
            <div className="flex flex-wrap justify-end gap-1 max-w-[55%]">
              {availableFields.slice(0, 4).map((f) => (
                <Badge
                  key={f}
                  data-graph-badge
                  variant={f === activeField ? "default" : "outline"}
                  className="cursor-pointer px-1.5 py-0 text-[9px] backdrop-blur-md"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(f);
                  }}
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
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="t" tick={{ fontSize: 9 }} hide />
              <YAxis tick={{ fontSize: 9 }} width={28} />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 8,
                  backdropFilter: "blur(8px)",
                  background: "color-mix(in oklab, var(--color-card) 80%, transparent)",
                }}
              />
              <Line
                type="monotone"
                dataKey="v"
                stroke="var(--color-primary)"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
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

// ---- Dynamic graph panel: pick any graphable sensor and see its live history ----
function SensorGraphPanel({ sensors }: { sensors: Sensor[] }) {
  const graphable = useMemo(() => sensors.filter((s) => s.view !== "button"), [sensors]);
  const [sensorId, setSensorId] = useState<string | null>(null);
  const active = useMemo(() => {
    if (!graphable.length) return null;
    return graphable.find((s) => s.id === sensorId) ?? graphable[0];
  }, [graphable, sensorId]);

  const readingsQ = useQuery({
    queryKey: ["panel-readings", active?.id],
    enabled: Boolean(active),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, sensor_id, ts, payload")
        .eq("sensor_id", active!.id)
        .order("ts", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data as Reading[]).reverse();
    },
    staleTime: 30_000,
    refetchInterval: 15_000,
  });

  const readings = readingsQ.data ?? [];
  const latest = readings[readings.length - 1];
  const fields = latest ? Object.keys(latest.payload) : [];
  const defaultField = active && latest ? pickPrimaryField(active.kind, latest.payload) : "value";
  const [fieldSel, setFieldSel] = useState<string | null>(null);
  const field = fieldSel && fields.includes(fieldSel) ? fieldSel : defaultField;

  const chartData = readings.map((r, i) => ({
    t: r.ts
      ? new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : String(i),
    v: Number(r.payload?.[field] ?? 0),
  }));

  const values = chartData.map((d) => d.v);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const unit = active?.unit ?? "";

  if (!graphable.length) return null;

  return (
    <Card className="glass-tile">
      <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">Live graph</CardTitle>
          <CardDescription className="text-xs">
            {active
              ? `${active.name} · last ${readings.length || 0} readings`
              : "Pick a sensor to view its data"}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={active?.id ?? ""}
            onValueChange={(v) => {
              setSensorId(v);
              setFieldSel(null);
            }}
          >
            <SelectTrigger className="h-8 w-[200px] text-xs">
              <SelectValue placeholder="Choose sensor" />
            </SelectTrigger>
            <SelectContent>
              {graphable.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  {s.name}
                  <span className="ml-1 text-muted-foreground">· {KIND_META[s.kind].label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fields.length > 1 && (
            <Select value={field} onValueChange={setFieldSel}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fields.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="mb-3 flex flex-wrap gap-4 text-xs tile-muted">
          <span>
            latest{" "}
            <span className="font-semibold text-foreground">
              {values.at(-1)?.toFixed(2) ?? "—"}
              {unit && ` ${unit}`}
            </span>
          </span>
          <span>
            min{" "}
            <span className="font-semibold text-foreground">
              {values.length ? min.toFixed(2) : "—"}
            </span>
          </span>
          <span>
            max{" "}
            <span className="font-semibold text-foreground">
              {values.length ? max.toFixed(2) : "—"}
            </span>
          </span>
        </div>
        <div className="relative h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={
                chartData.length
                  ? chartData
                  : [
                      { t: "", v: 0 },
                      { t: " ", v: 0 },
                    ]
              }
              margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
            >
              <defs>
                <linearGradient id="panelFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11 }} width={40} />
              {chartData.length > 0 && (
                <Tooltip
                  cursor={{
                    stroke: "var(--color-primary)",
                    strokeWidth: 1,
                    strokeDasharray: "4 4",
                    opacity: 0.7,
                  }}
                  wrapperStyle={{ outline: "none" }}
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--tile-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--muted-foreground)" }}
                />
              )}
              <Legend
                verticalAlign="top"
                align="right"
                height={24}
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)", paddingBottom: 4 }}
              />
              {chartData.length > 0 && (
                <Area
                  type="monotone"
                  dataKey="v"
                  name={`${field}${unit ? ` (${unit})` : ""}`}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  fill="url(#panelFill)"
                  isAnimationActive={false}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
          {!chartData.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
                No readings yet
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
