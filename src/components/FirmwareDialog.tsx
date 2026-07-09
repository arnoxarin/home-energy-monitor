import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Cpu, Copy, Download, Zap, AlertCircle, CheckCircle2, Settings } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
// Vite bundles the .ino file as a raw string, so the firmware source
// is always in sync with what's in the repo.
import firmwareSource from "../../firmware/voltwatch/voltwatch.ino?raw";
// Registers the <esp-web-install-button> custom element in the browser.
import "esp-web-tools";
import { FirmwareBuildStatus } from "./FirmwareBuildStatus";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";

// Let TypeScript know about the custom element from esp-web-tools (React 19)
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "esp-web-install-button": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { manifest?: string; "erase-first"?: boolean },
        HTMLElement
      >;
    }
  }
}

const MANIFEST_URL = "/firmware/manifest.json";

type DeviceRow = { id: string; name: string; ingest_key: string };

export function FirmwareDialog() {
  const [open, setOpen] = useState(false);
  const [binReady, setBinReady] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const webSerialSupported =
    typeof navigator !== "undefined" && "serial" in navigator;

  // Load the user's devices so we can bake ingest URL + key into the .ino
  const { data: devices = [] } = useQuery<DeviceRow[]>({
    queryKey: ["devices-for-firmware"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("devices")
        .select("id, name, ingest_key")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!deviceId && devices.length > 0) setDeviceId(devices[0].id);
  }, [devices, deviceId]);

  const selected = devices.find((d) => d.id === deviceId);

  // Substitute the __INGEST_URL__ / __INGEST_KEY__ placeholders in the .ino
  // with this app's origin and the selected device's ingest key, so the
  // ESP32 doesn't have to be told either at the captive portal.
  const personalizedSource = useMemo(() => {
    if (typeof window === "undefined") return firmwareSource;
    const origin = window.location.origin;
    const ingestUrl = `${origin}/api/public/ingest`;
    const key = selected?.ingest_key ?? "";
    return firmwareSource
      .replaceAll("__INGEST_URL__", ingestUrl)
      .replaceAll("__INGEST_KEY__", key);
  }, [selected]);

  // Check whether the compiled .bin is actually deployed
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/firmware/voltwatch-esp32.bin", { method: "HEAD" });
        if (!cancelled) setBinReady(res.ok);
      } catch {
        if (!cancelled) setBinReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const copy = () => {
    navigator.clipboard.writeText(personalizedSource);
    toast.success(
      selected
        ? `Firmware copied — pre-configured for "${selected.name}"`
        : "Firmware copied to clipboard",
    );
  };

  const download = () => {
    const blob = new Blob([personalizedSource], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "voltwatch.ino";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };


  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Cpu className="mr-1 h-4 w-4" /> Firmware
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install ESP32 firmware</DialogTitle>
          <DialogDescription>
            The ingest URL and device key are baked into the firmware for the device you
            pick below, so the ESP32's setup portal only asks for WiFi — no URL or key to
            type. Onboard LED: fast blink = portal open, slow blink = connecting, solid = online.
          </DialogDescription>
        </DialogHeader>

        <FirmwareBuildStatus />

        {/* ---------- Device picker: which device is this firmware for? ---------- */}
        <div className="rounded-lg border p-3 space-y-2">
          <label className="text-sm font-medium">Flash firmware for device</label>
          {devices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No devices yet. Add a device on the Devices page first, then come back — the
              firmware will be pre-configured for it automatically.
            </p>
          ) : (
            <>
              <Select value={deviceId} onValueChange={setDeviceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a device" />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  Ingest URL &amp; key for "{selected.name}" are baked in — WiFi-only setup portal.
                </div>
              )}
            </>
          )}
        </div>


        {/* ---------- One-click browser flasher ---------- */}
        <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">Flash from your browser</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Plug the ESP32 in via USB, click Install, pick the serial port — done. Works in
            desktop Chrome or Edge.
          </p>

          {!webSerialSupported ? (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 text-yellow-600" />
              <span>
                Your browser doesn't support WebSerial. Open this page in desktop Chrome or Edge
                to use one-click flashing, or use the manual method below.
              </span>
            </div>
          ) : binReady === false ? (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 text-yellow-600" />
              <div>
                Compiled firmware isn't published yet. Drop the compiled ESP32 binary at{" "}
                <code>public/firmware/voltwatch-esp32.bin</code> (a single merged bin) and the
                Install button will light up. Until then use the manual .ino method below.
              </div>
            </div>
          ) : (
            <esp-web-install-button manifest={MANIFEST_URL} erase-first>
              <Button slot="activate" size="sm">
                <Zap className="mr-1 h-4 w-4" /> Install firmware
              </Button>
              <span slot="unsupported" className="text-xs text-muted-foreground">
                Browser doesn't support WebSerial.
              </span>
              <span slot="not-allowed" className="text-xs text-muted-foreground">
                WebSerial requires HTTPS or localhost.
              </span>
            </esp-web-install-button>
          )}
          <p className="text-[11px] text-muted-foreground">
            After flashing, join WiFi <code>Voltwatch-Setup</code> (pw <code>voltwatch</code>)
            on your phone and enter your home WiFi. That's it — ingest URL and key are already baked in.
          </p>

        </div>

        {/* ---------- Manual Arduino path ---------- */}
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Advanced: build & upload from Arduino IDE
          </summary>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Download <code>voltwatch.ino</code> and open it in Arduino IDE.</li>
            <li>
              Install ESP32 board support and libraries:{" "}
              <span className="font-medium">WiFiManager</span>,{" "}
              <span className="font-medium">ArduinoJson</span>,{" "}
              <span className="font-medium">DHT sensor library</span>.
            </li>
            <li>Board "ESP32 Dev Module" → pick COM port → Upload.</li>
          </ol>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-1 h-4 w-4" /> Copy code
            </Button>
            <Button size="sm" onClick={download}>
              <Download className="mr-1 h-4 w-4" /> Download voltwatch.ino
            </Button>
          </div>
        </details>
      </DialogContent>
    </Dialog>
  );
}
