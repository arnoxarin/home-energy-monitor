import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Activity, ArrowLeft } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  KIND_META,
  PIN_ROLES,
  type PinRoleKey,
  type SensorKind,
  type SensorView,
} from "@/lib/sensor-config";

export const Route = createFileRoute("/_authenticated/sensors/new")({
  component: NewSensorPage,
});

interface Device {
  id: string;
  name: string;
}

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

  const sensorsQ = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sensors").select("id,device_id,name,pin,state");
      if (error) throw error;
      return data as {
        id: string;
        device_id: string;
        name: string;
        pin: string | null;
        state: { pins?: Record<string, string> } | null;
      }[];
    },
    refetchOnMount: "always",
  });

  // Realtime — refresh pin availability the moment any sensor is added/removed/changed
  useEffect(() => {
    const ch = supabase
      .channel("sensors-new-form")
      .on("postgres_changes", { event: "*", schema: "public", table: "sensors" }, () => {
        qc.invalidateQueries({ queryKey: ["sensors"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const [deviceId, setDeviceId] = useState<string>("");
  const [kind, setKind] = useState<SensorKind>("pzem04");
  const [name, setName] = useState("");
  const [pins, setPins] = useState<Partial<Record<PinRoleKey, string>>>({});
  const [view, setView] = useState<SensorView>("graph");
  const [unit, setUnit] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const meta = KIND_META[kind];
  const roles = PIN_ROLES[kind];

  // pin -> sensor name (scoped to the currently selected device).
  const pinOwners = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sensorsQ.data ?? []) {
      if (s.device_id !== deviceId) continue;
      if (s.pin) map.set(s.pin, s.name);
      const rolePins = s.state?.pins;
      if (rolePins) for (const v of Object.values(rolePins)) if (v) map.set(v, s.name);
    }
    return map;
  }, [sensorsQ.data, deviceId]);

  const usedPins = useMemo(() => new Set(pinOwners.keys()), [pinOwners]);

  useEffect(() => {
    setView(meta.defaultView);
    setUnit(meta.unit ?? "");
    setPins({}); // reset pin assignments when kind changes
  }, [kind, meta.defaultView, meta.unit]);

  useEffect(() => {
    if (!deviceId && devicesQ.data && devicesQ.data.length > 0) setDeviceId(devicesQ.data[0].id);
  }, [devicesQ.data, deviceId]);

  // Clear any locally chosen pin that is now marked as used (e.g. after
  // switching devices, or another tab created a sensor).
  useEffect(() => {
    setPins((prev) => {
      let changed = false;
      const next: Partial<Record<PinRoleKey, string>> = { ...prev };
      for (const [k, v] of Object.entries(prev)) {
        if (v && usedPins.has(v)) {
          delete next[k as PinRoleKey];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [usedPins]);

  // Also add the current selections to the check so the same pin can't be
  // picked in two roles at once.
  const takenByOtherRole = (roleKey: PinRoleKey) =>
    new Set(
      Object.entries(pins)
        .filter(([k, v]) => k !== roleKey && v)
        .map(([, v]) => v as string),
    );

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
      if (Object.keys(errs).length > 0) {
        setErrors(errs);
        throw new Error("Fix the highlighted fields");
      }
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
        state: kind === "relay" ? { on: false, pins } : { pins },
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      // Refetch the sensors list before leaving so the dashboard mounts with
      // the new sensor already present instead of racing an empty cache.
      await qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor saved");
      navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const kinds = useMemo(() => Object.keys(KIND_META) as SensorKind[], []);

  const primaryPin = pins[roles[0]?.key] ?? "";

  // Try to load real recent readings from any existing sensor on the same
  // device+pin (helpful when recreating a sensor). Falls back to mocked data.
  const previewQ = useQuery({
    queryKey: ["preview-readings", deviceId, primaryPin],
    enabled: Boolean(deviceId && primaryPin),
    queryFn: async () => {
      const { data: matches, error: mErr } = await supabase
        .from("sensors")
        .select("id")
        .eq("device_id", deviceId)
        .eq("pin", primaryPin)
        .limit(1);
      if (mErr) throw mErr;
      const match = matches?.[0];
      if (!match) return null;
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("id, ts, payload")
        .eq("sensor_id", match.id)
        .order("ts", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []).reverse() as {
        id: number;
        ts: string;
        payload: Record<string, number>;
      }[];
    },
    staleTime: 30_000,
  });

  const mockedPayload = useMemo(() => MOCK_PAYLOADS[kind] ?? { value: 0 }, [kind]);
  const realReadings = previewQ.data ?? [];
  const previewReadings =
    realReadings.length > 0
      ? realReadings
      : Array.from({ length: 10 }, (_, i) => ({
          id: i,
          ts: new Date(Date.now() - (9 - i) * 5000).toISOString(),
          payload: jitterPayload(mockedPayload, i),
        }));
  const isMocked = realReadings.length === 0;

  return (
    <div
      className="min-h-screen w-full bg-[#0F1216] text-[#E5EDF5]"
      style={{ fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif" }}
    >
      <header className="border-b border-white/5">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4 md:px-12">
          <button
            onClick={() => navigate({ to: "/dashboard" })}
            className="grid h-9 w-9 place-items-center rounded-md border border-white/10 bg-[#1A222B] text-[#7A8794] transition-colors hover:border-[#22D3EE]/40 hover:text-[#E5EDF5]"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="grid h-9 w-9 place-items-center rounded-md bg-[#22D3EE]/10 text-[#22D3EE] ring-1 ring-inset ring-[#22D3EE]/30">
            <Activity className="h-4 w-4" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Add sensor</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 md:px-12 md:py-12">
        <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-12">
          {/* Left: sensor type + live preview */}
          <div className="space-y-8 md:col-span-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Add new sensor</h1>
              <p className="mt-1 text-sm text-[#7A8794]">
                Configure hardware parameters and display settings for a new node.
              </p>
            </div>

            {/* 01. Sensor type */}
            <section className="space-y-4">
              <h2
                className="text-xs font-bold uppercase tracking-[0.18em] text-[#7A8794]"
                style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
              >
                01. Sensor type
              </h2>
              <RadioGroup
                value={kind}
                onValueChange={(v) => setKind(v as SensorKind)}
                className="grid grid-cols-2 gap-3"
              >
                {kinds.map((k) => {
                  const m = KIND_META[k];
                  const Icon = m.icon;
                  const selected = kind === k;
                  return (
                    <label
                      key={k}
                      htmlFor={`kind-${k}`}
                      className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-4 transition-all ${
                        selected
                          ? "border-[#22D3EE] bg-[#22D3EE]/5 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]"
                          : "border-white/10 bg-[#1A222B] hover:border-white/25"
                      }`}
                    >
                      <RadioGroupItem id={`kind-${k}`} value={k} className="sr-only" />
                      <Icon
                        className={`h-5 w-5 transition-colors ${
                          selected ? "text-[#22D3EE]" : "text-[#7A8794] group-hover:text-[#E5EDF5]"
                        }`}
                      />
                      <div>
                        <p className="text-sm font-medium leading-tight">{m.label}</p>
                        <p className="mt-0.5 text-[11px] leading-snug text-[#7A8794]">
                          {m.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            </section>

            {/* Live preview */}
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#1A222B] shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                <span
                  className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7A8794]"
                  style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                >
                  Live tile preview
                </span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isMocked ? "bg-[#7A8794]" : "bg-[#22D3EE] animate-pulse"
                    }`}
                  />
                  <span
                    className={`text-[10px] font-medium tracking-widest ${
                      isMocked ? "text-[#7A8794]" : "text-[#22D3EE]"
                    }`}
                    style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                  >
                    {isMocked ? "SIMULATED" : "STREAMING"}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-center bg-gradient-to-b from-transparent to-[#22D3EE]/5 p-6">
                <div className="w-[220px]">
                  <TilePreview
                    name={name.trim() || meta.label}
                    pin={primaryPin}
                    kindLabel={meta.label}
                    Icon={meta.icon}
                    view={view}
                    unit={unit.trim()}
                    readings={previewReadings}
                    isMocked={isMocked}
                  />
                </div>
              </div>

              <div
                className="flex items-center justify-between border-t border-white/5 bg-black/20 px-4 py-2.5 text-[10px] text-[#7A8794]"
                style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
              >
                <span>KIND: {kind.toUpperCase()}</span>
                <span>PIN: {primaryPin ? `GPIO ${primaryPin}` : "—"}</span>
              </div>
            </div>

            <div className="rounded-lg border border-[#22D3EE]/20 bg-[#22D3EE]/5 p-4">
              <p className="text-[11px] leading-relaxed text-[#22D3EE]/80">
                <span className="font-bold">Tip:</span>{" "}
                {previewQ.isFetching
                  ? "Checking for existing readings on this pin…"
                  : isMocked
                    ? "Preview shows simulated values. Real readings appear as soon as your device posts data."
                    : "Preview is streaming live readings from a previous sensor on this pin."}
              </p>
            </div>
          </div>

          {/* Right: hardware config + display + actions */}
          <div className="space-y-10 md:col-span-7">
            {/* 02. Hardware config */}
            <section className="space-y-5">
              <h2
                className="text-xs font-bold uppercase tracking-[0.18em] text-[#7A8794]"
                style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
              >
                02. Hardware config
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#7A8794]">
                    Target device
                  </label>
                  {devicesQ.isLoading ? (
                    <p className="text-sm text-[#7A8794]">Loading…</p>
                  ) : (devicesQ.data ?? []).length === 0 ? (
                    <p className="text-sm">
                      No devices yet.{" "}
                      <Link to="/devices" className="text-[#22D3EE] underline underline-offset-4">
                        Create one first
                      </Link>
                      .
                    </p>
                  ) : (
                    <Select value={deviceId} onValueChange={setDeviceId}>
                      <SelectTrigger className="border-white/10 bg-[#1A222B] text-[#E5EDF5] hover:border-white/25 focus:border-[#22D3EE] focus:ring-[#22D3EE]/30">
                        <SelectValue placeholder="Select device" />
                      </SelectTrigger>
                      <SelectContent>
                        {(devicesQ.data ?? []).map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {errors.device_id && <p className="text-xs text-red-400">{errors.device_id}</p>}
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#7A8794]">
                    Sensor label
                  </label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={meta.label}
                    maxLength={60}
                    className="border-white/10 bg-[#1A222B] text-[#E5EDF5] placeholder:text-white/25 focus-visible:border-[#22D3EE] focus-visible:ring-[#22D3EE]/30"
                  />
                  {errors.name && <p className="text-xs text-red-400">{errors.name}</p>}
                </div>
              </div>

              {/* Pin assignment panel */}
              <div className="space-y-4 rounded-lg border border-white/5 bg-[#1A222B] p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Pin assignment</span>
                  <span
                    className="rounded border border-[#22D3EE]/25 bg-[#22D3EE]/10 px-2 py-0.5 text-[10px] font-medium tracking-wider text-[#22D3EE]"
                    style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                  >
                    {meta.label.toUpperCase()}
                  </span>
                </div>

                {pinOwners.size > 0 && (
                  <div className="rounded-md border border-dashed border-white/10 bg-black/20 p-3">
                    <p
                      className="text-[10px] font-medium uppercase tracking-wider text-[#7A8794]"
                      style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                    >
                      Already wired on this device
                    </p>
                    <ul
                      className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#7A8794]"
                      style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                    >
                      {Array.from(pinOwners.entries())
                        .sort((a, b) => Number(a[0]) - Number(b[0]))
                        .map(([pin, owner]) => (
                          <li key={pin}>
                            <span className="text-[#22D3EE]">GPIO {pin}</span>
                            <span className="mx-1 text-white/30">—</span>
                            <span className="text-[#E5EDF5]">{owner}</span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {roles.map((role) => {
                    const otherRoleTaken = takenByOtherRole(role.key);
                    const available = role.options.filter(
                      (o) => !usedPins.has(o.pin) && !otherRoleTaken.has(o.pin),
                    );
                    const selectedPin = pins[role.key];
                    const selectedOwner = selectedPin ? pinOwners.get(selectedPin) : undefined;
                    const conflict = Boolean(selectedOwner) || Boolean(errors[`pin.${role.key}`]);
                    return (
                      <div key={role.key} className="space-y-2">
                        <label
                          className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-[#7A8794]"
                          style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                        >
                          <span>{role.label}</span>
                          <span className="text-[#22D3EE]/70">{role.key}</span>
                        </label>
                        <Select
                          value={pins[role.key] ?? ""}
                          onValueChange={(v) => setPins((p) => ({ ...p, [role.key]: v }))}
                        >
                          <SelectTrigger
                            className={`bg-[#0F1216] text-[#E5EDF5] focus:ring-[#22D3EE]/30 ${
                              conflict
                                ? "border-amber-500/60 focus:border-amber-500"
                                : "border-white/10 hover:border-white/25 focus:border-[#22D3EE]"
                            }`}
                            style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                          >
                            <SelectValue
                              placeholder={available.length === 0 ? "No free pins" : "Select GPIO"}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {available.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                All compatible pins are in use.
                              </div>
                            ) : (
                              available.map((o) => (
                                <SelectItem key={o.pin} value={o.pin}>
                                  {o.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] leading-snug text-[#7A8794]">{role.hint}</p>
                        {selectedOwner && (
                          <p
                            className="text-[10px] font-medium text-amber-400"
                            style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                          >
                            ! GPIO {selectedPin} in use by {selectedOwner}
                          </p>
                        )}
                        {errors[`pin.${role.key}`] && (
                          <p className="text-[11px] text-red-400">{errors[`pin.${role.key}`]}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* 03. Display */}
            <section className="space-y-4 pb-4">
              <h2
                className="text-xs font-bold uppercase tracking-[0.18em] text-[#7A8794]"
                style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
              >
                03. Display
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#7A8794]">
                    Display as
                  </label>
                  <Select value={view} onValueChange={(v) => setView(v as SensorView)}>
                    <SelectTrigger className="border-white/10 bg-[#1A222B] text-[#E5EDF5] hover:border-white/25 focus:border-[#22D3EE] focus:ring-[#22D3EE]/30">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {meta.allowedViews.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v === "graph"
                            ? "Graph"
                            : v === "numeric"
                              ? "Numeric"
                              : "Button (output)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#7A8794]">
                    Unit label (optional)
                  </label>
                  <Input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    placeholder={meta.unit ?? "e.g. W"}
                    maxLength={16}
                    className="border-white/10 bg-[#1A222B] text-[#E5EDF5] placeholder:text-white/25 focus-visible:border-[#22D3EE] focus-visible:ring-[#22D3EE]/30"
                    style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}
                  />
                </div>
              </div>
            </section>

            <div className="flex items-center gap-3 border-t border-white/5 pt-6">
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || (devicesQ.data ?? []).length === 0}
                className="rounded-md bg-[#22D3EE] px-6 py-2.5 text-sm font-semibold text-[#0F1216] shadow-[0_0_24px_rgba(34,211,238,0.25)] transition-transform hover:bg-[#5EE0F1] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                {save.isPending ? "Saving…" : "Save sensor"}
              </button>
              <button
                onClick={() => navigate({ to: "/dashboard" })}
                className="rounded-md px-6 py-2.5 text-sm font-medium text-[#7A8794] transition-colors hover:text-[#E5EDF5]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TilePreview({
  name,
  pin,
  kindLabel,
  Icon,
  view,
  unit,
  readings,
  isMocked,
}: {
  name: string;
  pin: string;
  kindLabel: string;
  Icon: React.ComponentType<{ className?: string }>;
  view: SensorView;
  unit: string;
  readings: { id: number; ts: string; payload: Record<string, number> }[];
  isMocked: boolean;
}) {
  const isButton = view === "button";
  const latest = readings[readings.length - 1];
  const entries = latest ? Object.entries(latest.payload) : [];
  const primary = entries[0];
  const rest = entries.slice(1);

  return (
    <div className={`glass-tile group aspect-square flex flex-col p-3 text-sm`}>
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-background/40 backdrop-blur-md border border-white/30">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              {name}
              {pin ? <span className="ml-1 font-normal text-muted-foreground">[{pin}]</span> : null}
            </p>
            {!isButton && (
              <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                {kindLabel}
              </p>
            )}
          </div>
        </div>
        {isMocked && (
          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
            sim
          </span>
        )}
      </div>
      <div className="relative z-10 mt-3 flex-1 min-h-0">
        {isButton ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Off</p>
            <div className="glass-chip px-4 py-2">
              <Switch checked={false} className="scale-150 pointer-events-none" />
            </div>
          </div>
        ) : view === "numeric" ? (
          <div className="flex h-full flex-col justify-between">
            {primary && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {primary[0]}
                </p>
                <p className="text-3xl font-bold leading-tight">
                  {typeof primary[1] === "number" ? primary[1].toFixed(2) : String(primary[1])}
                  {unit ? (
                    <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
                  ) : null}
                </p>
              </div>
            )}
            {rest.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {rest.slice(0, 4).map(([k, v]) => (
                  <div key={k} className="glass-chip px-2 py-1">
                    <p className="truncate text-[9px] uppercase text-muted-foreground">{k}</p>
                    <p className="truncate text-xs font-semibold">
                      {typeof v === "number" ? v.toFixed(2) : String(v)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Sparkline readings={readings} field={primary?.[0] ?? "value"} />
        )}
      </div>
    </div>
  );
}

function Sparkline({
  readings,
  field,
}: {
  readings: { payload: Record<string, number> }[];
  field: string;
}) {
  const values = readings.map((r) => Number(r.payload[field] ?? 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return (
    <div className="flex h-full items-end gap-1">
      {values.map((v, i) => {
        const h = ((v - min) / range) * 90 + 10;
        return (
          <div key={i} className="flex-1 rounded-sm bg-primary/50" style={{ height: `${h}%` }} />
        );
      })}
    </div>
  );
}

const MOCK_PAYLOADS: Partial<Record<SensorKind, Record<string, number>>> = {
  pzem04: { power: 285.4, voltage: 230.1, current: 1.24, energy: 12.34, frequency: 50.0 },
  dht22: { temperature: 23.5, humidity: 48.2 },
  analog: { value: 2048 },
  digital: { state: 1 },
  ultrasonic: { distance: 42.7 },
  radar: { distance: 180, presence: 1 },
  relay: { on: 0 },
};

function jitterPayload(base: Record<string, number>, i: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) {
    const wobble = Math.sin(i * 0.7 + k.length) * 0.06;
    out[k] = Number((v * (1 + wobble)).toFixed(3));
  }
  return out;
}
