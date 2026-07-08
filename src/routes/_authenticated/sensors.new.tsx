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
        if (v && usedPins.has(v)) { delete next[k as PinRoleKey]; changed = true; }
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

            <div className="space-y-3">
              <p className="text-sm font-medium">Pin assignment</p>

              {pinOwners.size > 0 && (
                <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs">
                  <p className="font-medium text-foreground">Pins already in use on this device</p>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {Array.from(pinOwners.entries())
                      .sort((a, b) => Number(a[0]) - Number(b[0]))
                      .map(([pin, owner]) => (
                        <li key={pin}>
                          GPIO {pin} — <span className="text-foreground">{owner}</span>
                        </li>
                      ))}
                  </ul>
                  <p className="mt-1">Delete a sensor to free its pins.</p>
                </div>
              )}

              {roles.map((role) => {
                const otherRoleTaken = takenByOtherRole(role.key);
                const available = role.options.filter((o) => !usedPins.has(o.pin) && !otherRoleTaken.has(o.pin));
                const selectedPin = pins[role.key];
                const selectedOwner = selectedPin ? pinOwners.get(selectedPin) : undefined;
                return (
                  <div key={role.key} className="space-y-2 rounded-lg border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-semibold uppercase tracking-wide">{role.label}</Label>
                      <span className="rounded bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {role.key}
                      </span>
                    </div>
                    <Select
                      value={pins[role.key] ?? ""}
                      onValueChange={(v) => setPins((p) => ({ ...p, [role.key]: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={available.length === 0 ? "No free pins for this role" : "Select a compatible GPIO"} />
                      </SelectTrigger>
                      <SelectContent>
                        {available.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            All compatible pins are in use. Free one by deleting a sensor.
                          </div>
                        ) : (
                          available.map((o) => (
                            <SelectItem key={o.pin} value={o.pin}>{o.label}</SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{role.hint}</p>
                    {selectedOwner && (
                      <p className="text-xs text-amber-600">
                        GPIO {selectedPin} is already used by "{selectedOwner}". Pick a different pin or delete that sensor.
                      </p>
                    )}
                    {errors[`pin.${role.key}`] && <p className="text-xs text-destructive">{errors[`pin.${role.key}`]}</p>}
                  </div>
                );
              })}
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

        <Card>
          <CardHeader>
            <CardTitle>3. Preview</CardTitle>
            <CardDescription>How this sensor will appear on your dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center">
              <div className="w-[220px]">
                <TilePreview
                  name={name.trim() || meta.label}
                  pin={pins[roles[0]?.key] ?? ""}
                  kindLabel={meta.label}
                  Icon={meta.icon}
                  view={view}
                  unit={unit.trim()}
                />
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

function TilePreview({
  name,
  pin,
  kindLabel,
  Icon,
  view,
  unit,
}: {
  name: string;
  pin: string;
  kindLabel: string;
  Icon: React.ComponentType<{ className?: string }>;
  view: SensorView;
  unit: string;
}) {
  const isButton = view === "button";
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
      </div>
      <div className="relative z-10 mt-3 flex-1 min-h-0">
        {isButton ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Off</p>
            <Switch checked={false} className="scale-150 pointer-events-none" />
          </div>
        ) : view === "numeric" ? (
          <div className="flex h-full flex-col justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">value</p>
              <p className="text-3xl font-bold leading-tight">
                0.00
                {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
              </p>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">Waiting for data…</p>
          </div>
        ) : (
          <div className="flex h-full items-end gap-1">
            {[30, 50, 40, 70, 55, 80, 65, 90, 75, 60].map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-primary/40"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

