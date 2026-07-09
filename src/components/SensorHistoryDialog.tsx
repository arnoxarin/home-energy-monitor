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
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import {
  format,
  addDays,
  addMonths,
  addYears,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  startOfHour,
  isSameDay,
  isAfter,
} from "date-fns";
import {
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronLeft,
  ChevronRight,
  CalendarIcon,
  Download,
  FileText,
  FileSpreadsheet,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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
  day: { label: "Day", hint: "Hourly buckets" },
  week: { label: "Week", hint: "Hourly buckets, Mon–Sun" },
  month: { label: "Month", hint: "Daily buckets" },
  year: { label: "Year", hint: "Monthly buckets" },
};

// Compute the window around an anchor date for the current range.
function rangeWindow(range: Range, anchor: Date): { start: Date; end: Date } {
  switch (range) {
    case "day":   return { start: startOfDay(anchor),   end: endOfDay(anchor) };
    case "week":  return { start: startOfWeek(anchor, { weekStartsOn: 1 }), end: endOfWeek(anchor, { weekStartsOn: 1 }) };
    case "month": return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
    case "year":  return { start: startOfYear(anchor),  end: endOfYear(anchor) };
  }
}

// Step the anchor by one range unit forward/backward.
function stepAnchor(range: Range, anchor: Date, dir: 1 | -1): Date {
  switch (range) {
    case "day":   return addDays(anchor, dir);
    case "week":  return addDays(anchor, dir * 7);
    case "month": return addMonths(anchor, dir);
    case "year":  return addYears(anchor, dir);
  }
}

// Human label for the currently selected window (used in the picker button).
function windowLabel(range: Range, anchor: Date): string {
  switch (range) {
    case "day":   return format(anchor, "EEE, MMM d, yyyy");
    case "week": {
      const { start, end } = rangeWindow("week", anchor);
      return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
    }
    case "month": return format(anchor, "MMMM yyyy");
    case "year":  return format(anchor, "yyyy");
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
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [field, setField] = useState<string | undefined>(initialField);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { start, end } = useMemo(() => rangeWindow(range, anchor), [range, anchor]);
  const canGoForward = !isAfter(end, new Date());

  const { data: readings = [], isFetching, isLoading } = useQuery<Reading[]>({
    queryKey: ["sensor-history", sensor.id, range, start.toISOString()],
    enabled: open,
    // Keep previous data on screen while the new window loads —
    // prevents the chart from unmounting and flickering.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, ts, payload")
        .eq("sensor_id", sensor.id)
        .gte("ts", start.toISOString())
        .lte("ts", end.toISOString())
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

        {/* Date navigator: prev / date picker / next / today */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor((a) => stepAnchor(range, a, -1))}
            aria-label={`Previous ${range}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn("h-8 min-w-[180px] justify-start gap-2 font-normal")}
              >
                <CalendarIcon className="h-4 w-4" />
                <span className="truncate">{windowLabel(range, anchor)}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={anchor}
                onSelect={(d) => {
                  if (d) {
                    setAnchor(d);
                    setPickerOpen(false);
                  }
                }}
                disabled={(d) => isAfter(d, new Date())}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>

          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAnchor((a) => stepAnchor(range, a, 1))}
            disabled={!canGoForward}
            aria-label={`Next ${range}`}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => setAnchor(new Date())}
            disabled={isSameDay(anchor, new Date())}
          >
            Today
          </Button>

          {/* Quick month jumps for month/year ranges */}
          {(range === "month" || range === "year") && (
            <div className="ml-auto flex gap-1">
              {[-3, -2, -1, 0].map((offset) => {
                const d = range === "month" ? addMonths(new Date(), offset) : addYears(new Date(), offset);
                const label = range === "month" ? format(d, "MMM") : format(d, "yyyy");
                const active =
                  range === "month"
                    ? format(d, "yyyy-MM") === format(anchor, "yyyy-MM")
                    : format(d, "yyyy") === format(anchor, "yyyy");
                return (
                  <Badge
                    key={offset}
                    variant={active ? "default" : "outline"}
                    className="cursor-pointer transition-all hover:scale-105"
                    onClick={() => setAnchor(d)}
                  >
                    {label}
                  </Badge>
                );
              })}
            </div>
          )}
        </div>


        {/* Stat strip — values transition individually, container never remounts */}
        {stats && (
          <div className="grid grid-cols-2 gap-2 transition-opacity duration-300 sm:grid-cols-4"
               style={{ opacity: isFetching ? 0.6 : 1 }}>
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

        {/* Chart — stays mounted across range/field switches; recharts
            interpolates between data sets. A small loading dot shows in the
            corner while the new range is fetching. */}
        <div className="relative h-[340px] w-full rounded-lg border bg-card p-3">
          {isLoading && bucketed.length === 0 ? (
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
            <div className="h-full w-full transition-opacity duration-300"
                 style={{ opacity: isFetching ? 0.75 : 1 }}>
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
                    animationDuration={550}
                    animationEasing="ease-in-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          {isFetching && bucketed.length > 0 && (
            <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border bg-background/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" /> updating
            </div>
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
      {/* keyed so the number crossfades when the range/field changes */}
      <p key={value} className="truncate text-sm font-semibold animate-fade-in">
        {value}
      </p>
    </div>
  );
}

