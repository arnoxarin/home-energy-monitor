import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
  KIND_META,
  PIN_ROLES,
  type PinRoleKey,
  type SensorKind,
  type SensorView,
} from "@/lib/sensor-config";

export const Route = createFileRoute("/_authenticated/sensors/$sensorId/edit")({
  component: EditSensorPage,
});

interface SensorRow {
  id: string;
  device_id: string;
  name: string;
  kind: SensorKind;
  pin: string | null;
  view: SensorView;
  unit: string | null;
  state: {
    on?: boolean;
    pins?: Record<string, string>;
    alerts?: { field?: string | null; min?: number | null; max?: number | null };
  } | null;
}
interface Device { id: string; name: string; }

function EditSensorPage() {
  const { sensorId } = useParams({ from: "/_authenticated/sensors/$sensorId/edit" });
  const navigate = useNavigate();
  const qc = useQueryClient();

  const sensorsQ = useQuery({
    queryKey: ["sensors"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sensors").select("id,device_id,name,kind,pin,view,unit,state");
      if (error) throw error;
      return data as SensorRow[];
    },
    refetchOnMount: "always",
  });

  // Realtime — refresh pin availability the moment any sensor is added/removed/changed
  useEffect(() => {
    const ch = supabase
      .channel("sensors-edit-form")
      .on("postgres_changes", { event: "*", schema: "public", table: "sensors" }, () => {
        qc.invalidateQueries({ queryKey: ["sensors"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("id,name");
      if (error) throw error;
      return data as Device[];
    },
  });

  const sensor = useMemo(
    () => (sensorsQ.data ?? []).find((s) => s.id === sensorId),
    [sensorsQ.data, sensorId],
  );
  const device = useMemo(
    () => (devicesQ.data ?? []).find((d) => d.id === sensor?.device_id),
    [devicesQ.data, sensor?.device_id],
  );

  const [name, setName] = useState("");
  const [pins, setPins] = useState<Partial<Record<PinRoleKey, string>>>({});
  const [view, setView] = useState<SensorView>("graph");
  const [unit, setUnit] = useState<string>("");
  const [alertField, setAlertField] = useState<string>("");
  const [alertMin, setAlertMin] = useState<string>("");
  const [alertMax, setAlertMax] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  // Prefill once the sensor loads.
  useEffect(() => {
    if (!sensor || loaded) return;
    setName(sensor.name);
    setPins((sensor.state?.pins ?? {}) as Partial<Record<PinRoleKey, string>>);
    setView(sensor.view);
    setUnit(sensor.unit ?? "");
    const a = sensor.state?.alerts;
    setAlertField(a?.field ?? "");
    setAlertMin(a?.min == null ? "" : String(a.min));
    setAlertMax(a?.max == null ? "" : String(a.max));
    setLoaded(true);
  }, [sensor, loaded]);

  // If the sensor being edited gets deleted (from another tab, dashboard, etc.)
  // bounce back to the dashboard instead of stranding the user on a dead form.
  useEffect(() => {
    if (!sensorsQ.isSuccess) return;
    if (loaded && !sensor) {
      toast.error("This sensor was deleted");
      navigate({ to: "/dashboard" });
    }
  }, [sensorsQ.isSuccess, sensorsQ.data, loaded, sensor, navigate]);

  const meta = sensor ? KIND_META[sensor.kind] : null;
  const roles = sensor ? PIN_ROLES[sensor.kind] : [];

  // Pins used by OTHER sensors on the same device (self is excluded so
  // its own current pins can be kept or moved without conflict).
  const pinOwners = useMemo(() => {
    const map = new Map<string, string>();
    if (!sensor) return map;
    for (const s of sensorsQ.data ?? []) {
      if (s.id === sensor.id) continue;
      if (s.device_id !== sensor.device_id) continue;
      if (s.pin) map.set(s.pin, s.name);
      const rp = s.state?.pins;
      if (rp) for (const v of Object.values(rp)) if (v) map.set(v, s.name);
    }
    return map;
  }, [sensorsQ.data, sensor]);

  const usedPins = useMemo(() => new Set(pinOwners.keys()), [pinOwners]);

  const takenByOtherRole = (roleKey: PinRoleKey) =>
    new Set(
      Object.entries(pins)
        .filter(([k, v]) => k !== roleKey && v)
        .map(([, v]) => v as string),
    );

  const save = useMutation({
    mutationFn: async () => {
      if (!sensor) throw new Error("Sensor not loaded");
      const errs: Record<string, string> = {};
      const trimmedName = name.trim();
      const nameParse = z.string().trim().min(1).max(60).safeParse(trimmedName);
      if (!nameParse.success) errs.name = "Name is required (max 60 chars)";
      const chosen: string[] = [];
      for (const role of roles) {
        const v = pins[role.key];
        if (!v) errs[`pin.${role.key}`] = `${role.label} required`;
        else if (chosen.includes(v)) errs[`pin.${role.key}`] = "Pin already used above";
        else if (usedPins.has(v)) errs[`pin.${role.key}`] = `Used by "${pinOwners.get(v)}"`;
        else chosen.push(v);
      }
      if (Object.keys(errs).length > 0) { setErrors(errs); throw new Error("Fix the highlighted fields"); }
      setErrors({});

      const primaryPin = pins[roles[0].key]!;
      const nextState = { ...(sensor.state ?? {}), pins } as Record<string, string | boolean | Record<string, string>>;
      const { error } = await supabase
        .from("sensors")
        .update({
          name: trimmedName,
          pin: primaryPin,
          view,
          unit: unit.trim() ? unit.trim() : null,
          state: nextState as never,
        })
        .eq("id", sensor.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Sensor updated");
      navigate({ to: "/dashboard" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

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
          <span className="text-lg font-semibold">Edit sensor</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8 space-y-6">
        {sensorsQ.isLoading || !sensor || !meta ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>{meta.label}</CardTitle>
                <CardDescription>
                  Device: {device?.name ?? "—"}. Sensor type and device can't be changed here — delete and re-add to move it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
                  {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-medium">Pin assignment</p>

                  {pinOwners.size > 0 && (
                    <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs">
                      <p className="font-medium text-foreground">Pins used by other sensors on this device</p>
                      <ul className="mt-1 space-y-0.5 text-muted-foreground">
                        {Array.from(pinOwners.entries())
                          .sort((a, b) => Number(a[0]) - Number(b[0]))
                          .map(([pin, owner]) => (
                            <li key={pin}>
                              GPIO {pin} — <span className="text-foreground">{owner}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}

                  {roles.map((role) => {
                    const otherRoleTaken = takenByOtherRole(role.key);
                    const selectedPin = pins[role.key];
                    const options = role.options.filter(
                      (o) => !usedPins.has(o.pin) && (!otherRoleTaken.has(o.pin) || o.pin === selectedPin),
                    );
                    return (
                      <div key={role.key} className="space-y-2 rounded-lg border bg-background p-4">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm font-semibold uppercase tracking-wide">{role.label}</Label>
                          <span className="rounded bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {role.key}
                          </span>
                        </div>
                        <Select
                          value={selectedPin ?? ""}
                          onValueChange={(v) => setPins((p) => ({ ...p, [role.key]: v }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={options.length === 0 ? "No free pins" : "Select a compatible GPIO"} />
                          </SelectTrigger>
                          <SelectContent>
                            {options.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                All compatible pins are in use.
                              </div>
                            ) : (
                              options.map((o) => (
                                <SelectItem key={o.pin} value={o.pin}>{o.label}</SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{role.hint}</p>
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
                    <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={16} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => navigate({ to: "/dashboard" })}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
