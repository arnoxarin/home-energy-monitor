import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Activity, ArrowLeft, Copy, Eye, EyeOff, KeyRound, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DeviceStatusDot } from "@/components/DeviceStatusDot";
import { FirmwareBadge } from "@/components/FirmwareBadge";
import { LastSeenBadge } from "@/components/LastSeenBadge";

export const Route = createFileRoute("/_authenticated/devices")({
  component: DevicesPage,
});

interface Device {
  id: string;
  name: string;
  ingest_key: string;
  last_seen_at: string | null;
  created_at: string;
  fw_version: string | null;
  fw_build: string | null;
  fw_reported_at: string | null;
}

function randomHex(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function DevicesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("*").order("created_at");
      if (error) throw error;
      return data as Device[];
    },
    refetchInterval: 15_000,
  });

  const createDevice = useMutation({
    mutationFn: async (name: string) => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("not signed in");
      const { error } = await supabase
        .from("devices")
        .insert({ name: name.trim() || "ESP32", user_id: userData.user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Device created");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/dashboard" })}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">Devices</span>
          </div>
          <NewDeviceDialog onCreate={(n) => createDevice.mutate(n)} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        {devicesQ.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (devicesQ.data ?? []).length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No devices yet</CardTitle>
              <CardDescription>Create one to get an ingest key for your ESP32.</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          (devicesQ.data ?? []).map((d) => (
            <DeviceRow key={d.id} device={d} origin={origin} />
          ))
        )}

        <EspCodeCard origin={origin} sampleKey={(devicesQ.data ?? [])[0]?.ingest_key ?? "YOUR_INGEST_KEY"} />
      </main>
    </div>
  );
}

function NewDeviceDialog({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="mr-1 h-4 w-4" /> New device</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New device</DialogTitle>
          <DialogDescription>A unique ingest key is generated automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main panel" />
        </div>
        <DialogFooter>
          <Button onClick={() => { onCreate(name); setName(""); setOpen(false); }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceRow({ device, origin }: { device: Device; origin: string }) {
  const qc = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);

  const rename = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("devices").update({ name: name.trim() || "ESP32" }).eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); toast.success("Renamed"); setEditing(false); },
    onError: (e) => toast.error((e as Error).message),
  });

  const rotate = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("devices").update({ ingest_key: randomHex(24) }).eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); toast.success("Ingest key revoked & regenerated"); },
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("devices").delete().eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["devices"] }); qc.invalidateQueries({ queryKey: ["sensors"] }); toast.success("Device deleted"); },
    onError: (e) => toast.error((e as Error).message),
  });

  const copy = (v: string) => { navigator.clipboard.writeText(v); toast.success("Copied"); };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
              <Button size="sm" onClick={() => rename.mutate()} disabled={rename.isPending}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(device.name); }}>Cancel</Button>
            </div>
          ) : (
            <>
              <CardTitle className="text-lg flex items-center gap-2">
                <DeviceStatusDot lastSeenAt={device.last_seen_at} />
                {device.name}
                <FirmwareBadge
                  version={device.fw_version}
                  build={device.fw_build}
                  reportedAt={device.fw_reported_at}
                />
                <LastSeenBadge lastSeenAt={device.last_seen_at} />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </CardTitle>
              <CardDescription>
                {device.last_seen_at ? `Last seen ${new Date(device.last_seen_at).toLocaleString()}` : "Never seen"}
              </CardDescription>
            </>
          )}
        </div>
        <div className="flex gap-1">
          <Link to="/devices/$deviceId/register" params={{ deviceId: device.id }}>
            <Button variant="outline" size="sm"><Link2 className="mr-1 h-3.5 w-3.5" /> Register</Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm"><KeyRound className="mr-1 h-3.5 w-3.5" /> Revoke key</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke ingest key?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current key stops working immediately. Update your ESP32 firmware with the new key.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => rotate.mutate()}>Revoke & regenerate</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon"><Trash2 className="h-4 w-4" /></Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete device?</AlertDialogTitle>
                <AlertDialogDescription>All sensors and readings for this device will be removed.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-32">Endpoint</span>
          <code className="rounded bg-muted px-2 py-0.5 text-xs">{origin}/api/public/ingest</code>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(`${origin}/api/public/ingest`)}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-32">x-ingest-key</span>
          <code className="rounded bg-muted px-2 py-0.5 text-xs font-mono">
            {showKey ? device.ingest_key : "•".repeat(Math.min(device.ingest_key.length, 32))}
          </code>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowKey((v) => !v)}>
            {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(device.ingest_key)}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EspCodeCard({ origin, sampleKey }: { origin: string; sampleKey: string }) {
  const host = origin.replace(/^https?:\/\//, "");
  const code = `// Voltwatch — ESP32 + PZEM-004T v3 example
// Libraries (Arduino IDE > Library Manager):
//   - PZEM004Tv30 by mandulaj
//   - ArduinoJson by Benoit Blanchon

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>

const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* INGEST_URL = "https://${host || "YOUR_APP_HOST"}/api/public/ingest";
const char* STATE_URL  = "https://${host || "YOUR_APP_HOST"}/api/public/state";
const char* INGEST_KEY = "${sampleKey}"; // from the Devices page

// PZEM-004T v3 on UART2: RX=16, TX=17 (adjust to your wiring)
PZEM004Tv30 pzem(Serial2, 16, 17);

// Example relay on GPIO 27 — set the sensor's "pin" to "27" in the app
const int RELAY_PIN = 27;

unsigned long lastPost = 0;
const unsigned long POST_INTERVAL_MS = 5000;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\\nWiFi connected");
}

void applyRelayStates(JsonArray states) {
  for (JsonObject s : states) {
    const char* pin = s["pin"] | "";
    bool on = s["on"] | false;
    if (String(pin) == String(RELAY_PIN)) {
      digitalWrite(RELAY_PIN, on ? HIGH : LOW);
    }
  }
}

void postReadings() {
  float v = pzem.voltage();
  float i = pzem.current();
  float p = pzem.power();
  float e = pzem.energy();
  float f = pzem.frequency();
  float pf = pzem.pf();
  if (isnan(v)) { Serial.println("PZEM read failed"); return; }

  StaticJsonDocument<512> doc;
  JsonArray readings = doc.createNestedArray("readings");
  JsonObject r = readings.createNestedObject();
  r["pin"] = "16"; // matches the sensor pin you set in the app
  JsonObject payload = r.createNestedObject("payload");
  payload["voltage"] = v;
  payload["current"] = i;
  payload["power"]   = p;
  payload["energy"]  = e;
  payload["frequency"] = f;
  payload["pf"] = pf;

  String body; serializeJson(doc, body);

  WiFiClientSecure client; client.setInsecure(); // simple TLS
  HTTPClient http;
  http.begin(client, INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ingest-key", INGEST_KEY);
  int code = http.POST(body);
  Serial.printf("POST %d\\n", code);

  if (code == 200) {
    String resp = http.getString();
    StaticJsonDocument<512> rd;
    if (!deserializeJson(rd, resp)) {
      JsonArray states = rd["states"].as<JsonArray>();
      if (!states.isNull()) applyRelayStates(states);
    }
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  if (millis() - lastPost > POST_INTERVAL_MS) {
    lastPost = millis();
    postReadings();
  }
}
`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>ESP32 firmware</CardTitle>
        <CardDescription>
          Arduino sketch for PZEM-004T v3 + optional relay. Replace WiFi credentials and the ingest key,
          then flash your ESP32. The device polls back relay states in the POST response.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(code); toast.success("Copied sketch"); }}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy sketch
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
        <p className="text-xs text-muted-foreground">
          Payload shape: <code>{`{"readings":[{"pin":"<pin>","payload":{...}}]}`}</code>. The "pin" must match the value you set on the sensor in <Link to="/dashboard" className="underline">the dashboard</Link>.
        </p>
      </CardContent>
    </Card>
  );
}
