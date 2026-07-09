import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays, subMonths, subYears, startOfHour, startOfDay, startOfMonth } from "date-fns";
import { Loader2, TrendingUp, TrendingDown, Minus } from "lucide-react";

type Range = "day" | "week" | "month" | "year";

interface Reading {
  id: number;
  ts: string;
  payload: Record<string, number>;
}

interface Sensor {
  id: string;
  name: string;
  kind: string;
  unit: string | null;
}

const RANGE_META: Record<Range, { label: string; hint: string }> = {
  day: { label: "Day", hint: "Last 24 hours · hourly buckets" },
  week: { label: "Week", hint: "Last 7 days · hourly buckets" },
  month: { label: "Month", hint: "Last 30 days · daily buckets" },
  year: { label: "Year", hint: "Last 12 months · monthly buckets" },
};

function rangeStart(range: Range): Date {
  const now = new Date();
  switch (range) {
    case "day": return subDays(now, 1);
    case "week": return subDays(now, 7);
    case "month": return subMonths(now, 1);
    case "year": return subYears(now, 1);
  }
}

function bucketKey(ts: Date, range: Range): { key: number; label: string } {
  if (range === "day" || range === "week") {
    const d = startOfHour(ts);
    return { key: d.getTime(), label: range === "day" ? format(d, "HH:mm") : format(d, "EEE HH:mm") };
  }
  if (range === "month") {
    const d = startOfDay(ts);
    return { key: d.getTime(), label: format(d, "MMM d") };
  }
  const d = startOfMonth(ts);
  return { key: d.getTime(), label: format(d, "MMM yy") };
}

export function SensorHistoryDialog({
  sensor,
  open,
  onOpenChange,
  initialField,
}: {
  sensor: Sensor;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialField?: string;
}) {
  const [range, setRange] = useState<Range>("day");
  const [field, setField] = useState<string | undefined>(initialField);

  const { data: readings = [], isLoading } = useQuery<Reading[]>({
    queryKey: ["sensor-history", sensor.id, range],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, ts, payload")
        .eq("sensor_id", sensor.id)
        .gte("ts", rangeStart(range).toISOString())
        .order("ts", { ascending: true })
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as Reading[];
    },
  });

  const availableFields = useMemo(() => {
    const set = new Set<string>();
    for (const r of readings) for (const k of Object.keys(r.payload ?? {})) set.add(k);
    return Array.from(set);
  }, [readings]);

  const activeField = field ?? availableFields[0] ?? "value";

  // Bucket & average per bucket
  const bucketed = useMemo(() => {
    const map = new Map<number, { label: string; sum: number; count: number; min: number; max: number }>();
    for (const r of readings) {
      const v = Number(r.payload?.[activeField]);
      if (!Number.isFinite(v)) continue;
      const { key, label } = bucketKey(new Date(r.ts), range);
      const entry = map.get(key);
      if (entry) {
        entry.sum += v;
        entry.count += 1;
        entry.min = Math.min(entry.min, v);
        entry.max = Math.max(entry.max, v);
      } else {
        map.set(key, { label, sum: v, count: 1, min: v, max: v });
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ t: v.label, avg: v.sum / v.count, min: v.min, max: v.max }));
  }, [readings, activeField, range]);

  const stats = useMemo(() => {
    if (bucketed.length === 0) return null;
    const values = bucketed.map((b) => b.avg);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const trend = Math.abs(delta) < Math.abs(avg) * 0.02 ? "flat" : delta > 0 ? "up" : "down";
    return { min, max, avg, first, last, delta, trend };
  }, [bucketed]);

  const unit = sensor.unit ?? "";
  const fmt = (n: number) => `${n.toFixed(2)}${unit ? ` ${unit}` : ""}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl animate-scale-in">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {sensor.name}
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              {sensor.kind}
            </Badge>
          </DialogTitle>
          <DialogDescription>{RANGE_META[range].hint}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
            <TabsList>
              {(Object.keys(RANGE_META) as Range[]).map((r) => (
                <TabsTrigger key={r} value={r} className="transition-all">
                  {RANGE_META[r].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {availableFields.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {availableFields.map((f) => (
                <Badge
                  key={f}
                  variant={f === activeField ? "default" : "outline"}
                  className="cursor-pointer transition-all hover:scale-105"
                  onClick={() => setField(f)}
                >
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Stat strip */}
        {stats && (
          <div
            key={`stats-${range}-${activeField}`}
            className="grid grid-cols-2 gap-2 animate-fade-in sm:grid-cols-4"
          >
            <StatCell label="Latest" value={fmt(stats.last)} />
            <StatCell label="Average" value={fmt(stats.avg)} />
            <StatCell label="Min" value={fmt(stats.min)} />
            <StatCell label="Max" value={fmt(stats.max)} />
            <div className="col-span-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs sm:col-span-4">
              {stats.trend === "up" && <TrendingUp className="h-4 w-4 text-green-600" />}
              {stats.trend === "down" && <TrendingDown className="h-4 w-4 text-red-600" />}
              {stats.trend === "flat" && <Minus className="h-4 w-4 text-muted-foreground" />}
              <span className="text-muted-foreground">
                {stats.trend === "flat"
                  ? "Steady across this range."
                  : `Changed by ${stats.delta > 0 ? "+" : ""}${stats.delta.toFixed(2)}${unit ? ` ${unit}` : ""} over this range.`}
              </span>
            </div>
          </div>
        )}

        {/* Chart */}
        <div
          key={`chart-${range}-${activeField}`}
          className="h-[340px] w-full animate-fade-in rounded-lg border bg-card p-3"
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading history…
            </div>
          ) : bucketed.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
              <p>No readings recorded in this range yet.</p>
              <p className="text-xs">
                Try a longer range — the sensor may not have been reporting during this window.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={bucketed} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="histFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="color-mix(in oklab, currentColor 12%, transparent)"
                />
                <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={40} />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    backdropFilter: "blur(8px)",
                    background: "color-mix(in oklab, var(--color-card) 85%, transparent)",
                  }}
                  formatter={(value: number) => [fmt(value), activeField]}
                />
                <Area
                  type="monotone"
                  dataKey="avg"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  fill="url(#histFill)"
                  animationDuration={600}
                  animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold">{value}</p>
    </div>
  );
}
