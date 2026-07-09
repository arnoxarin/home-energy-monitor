import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import {
  Cpu,
  Copy,
  Download,
  Zap,
  AlertCircle,
  CheckCircle2,
  Settings,
  ChevronRight,
} from "lucide-react";
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
const HEADING_FONT = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif";
const BODY_FONT = "'DM Sans', ui-sans-serif, system-ui, sans-serif";

type DeviceRow = { id: string; name: string; ingest_key: string };
type StepKey = "build" | "flash" | "advanced";

const STEPS: { key: StepKey; label: string; num: string }[] = [
  { key: "build", num: "01", label: "Build & verify" },
  { key: "flash", num: "02", label: "Flash to device" },
  { key: "advanced", num: "03", label: "Arduino IDE" },
];

export function FirmwareDialog() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<StepKey>("build");
  const [binReady, setBinReady] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const webSerialSupported =
    typeof navigator !== "undefined" && "serial" in navigator;

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

  const personalizedSource = useMemo(() => {
    if (typeof window === "undefined") return firmwareSource;
    const origin = window.location.origin;
    const ingestUrl = `${origin}/api/public/ingest`;
    const key = selected?.ingest_key ?? "";
    return firmwareSource
      .replaceAll("__INGEST_URL__", ingestUrl)
      .replaceAll("__INGEST_KEY__", key);
  }, [selected]);

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
      <DialogContent
        className="w-[calc(100vw-1.5rem)] max-w-4xl max-h-[92vh] overflow-hidden p-0 gap-0 border-[#e8ecf1] bg-white"
        style={{ fontFamily: BODY_FONT }}
      >
        <DialogTitle className="sr-only">Install ESP32 firmware</DialogTitle>

        <div className="flex flex-col sm:flex-row max-h-[92vh]">
          {/* ---------- Sidebar ---------- */}
          <aside className="sm:w-60 shrink-0 bg-[#fafbfc] border-b sm:border-b-0 sm:border-r border-[#e8ecf1] p-5 sm:p-6 flex sm:flex-col gap-1 sm:gap-1 overflow-x-auto sm:overflow-visible">
            <h2
              className="hidden sm:block text-[10px] font-bold uppercase tracking-[0.14em] text-[#94a3b8] mb-6"
              style={{ fontFamily: HEADING_FONT }}
            >
              Installation flow
            </h2>
            <nav className="flex sm:flex-col gap-1 w-full">
              {STEPS.map((s) => {
                const active = step === s.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStep(s.key)}
                    className={[
                      "group flex items-center gap-3 px-3 py-2 rounded-lg text-sm shrink-0 transition-all duration-200",
                      active
                        ? "bg-[#3b82f6]/10 text-[#3b82f6] font-semibold"
                        : "text-[#94a3b8] hover:text-slate-700 hover:bg-[#e8ecf1]/60 font-medium",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors",
                        active
                          ? "bg-[#3b82f6] text-white"
                          : "border border-[#e8ecf1] bg-white text-[#94a3b8]",
                      ].join(" ")}
                    >
                      {s.num}
                    </span>
                    <span className="whitespace-nowrap">{s.label}</span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto hidden sm:block pt-6">
              <Link to="/setup" onClick={() => setOpen(false)}>
                <button
                  type="button"
                  className="flex items-center justify-between w-full px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[#94a3b8] hover:text-slate-700 transition-colors border-t border-[#e8ecf1] pt-5"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Settings className="h-3.5 w-3.5" /> Setup
                  </span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </Link>
            </div>
          </aside>

          {/* ---------- Main ---------- */}
          <main className="flex-1 flex flex-col min-w-0">
            <header className="px-6 sm:px-8 pt-6 sm:pt-8 pb-5 border-b border-[#e8ecf1] flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1
                  className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight truncate"
                  style={{ fontFamily: HEADING_FONT }}
                >
                  Install ESP32 firmware
                </h1>
                <p className="text-xs sm:text-sm text-[#94a3b8] mt-1">
                  Configure, build, and flash your device from the browser.
                </p>
              </div>
              <Link to="/setup" onClick={() => setOpen(false)} className="shrink-0 sm:hidden">
                <Button variant="outline" size="sm" className="h-8 px-2 text-xs">
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </header>

            <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-6 sm:py-7 space-y-8 animate-fade-in" key={step}>
              {step === "build" && (
                <section className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3
                      className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-900"
                      style={{ fontFamily: HEADING_FONT }}
                    >
                      Build status
                    </h3>
                  </div>
                  <FirmwareBuildStatus />
                  <p className="text-xs text-[#94a3b8] leading-relaxed">
                    The <code className="text-slate-600">Verify build</code> button compares
                    the compiled <code className="text-slate-600">.bin</code> against the
                    server manifest. When the binary is missing, drop it at{" "}
                    <code className="text-slate-600">public/firmware/voltwatch-esp32.bin</code>{" "}
                    and refresh.
                  </p>
                </section>
              )}

              {step === "flash" && (
                <>
                  <section className="space-y-3">
                    <h3
                      className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-900"
                      style={{ fontFamily: HEADING_FONT }}
                    >
                      Flash firmware for device
                    </h3>
                    {devices.length === 0 ? (
                      <p className="text-xs text-[#94a3b8]">
                        No devices yet. Add a device on the Devices page first, then come back —
                        the firmware will be pre-configured for it automatically.
                      </p>
                    ) : (
                      <>
                        <Select value={deviceId} onValueChange={setDeviceId}>
                          <SelectTrigger className="bg-white border-[#e8ecf1] focus:ring-2 focus:ring-[#3b82f6]/20">
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
                          <div className="flex items-start gap-2 text-xs text-slate-600 bg-[#3b82f6]/5 border border-[#3b82f6]/15 rounded-lg p-3">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#3b82f6] mt-px" />
                            <span>
                              Ingest URL &amp; key for{" "}
                              <span className="font-semibold text-slate-900">"{selected.name}"</span>{" "}
                              are baked in — the ESP32 setup portal only asks for WiFi.
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </section>

                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3
                        className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-900"
                        style={{ fontFamily: HEADING_FONT }}
                      >
                        Flash from your browser
                      </h3>
                      <span className="text-[10px] text-[#94a3b8]">Chrome / Edge</span>
                    </div>

                    <p className="text-sm text-slate-600 leading-relaxed">
                      Plug the ESP32 in via USB, click Install, pick the serial port — done.
                    </p>

                    {!webSerialSupported ? (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                        <span>
                          Your browser doesn't support WebSerial. Open this page in desktop
                          Chrome or Edge, or use the Arduino IDE step.
                        </span>
                      </div>
                    ) : binReady === false ? (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                        <div>
                          Compiled firmware isn't published yet. Drop the ESP32 binary at{" "}
                          <code>public/firmware/voltwatch-esp32.bin</code>. Until then, use the
                          Arduino IDE step.
                        </div>
                      </div>
                    ) : (
                      <esp-web-install-button manifest={MANIFEST_URL} erase-first>
                        <Button
                          slot="activate"
                          className="w-full bg-[#3b82f6] hover:bg-[#2563eb] text-white font-semibold rounded-lg shadow-lg shadow-[#3b82f6]/20 h-11"
                        >
                          <Zap className="mr-2 h-4 w-4" /> Install firmware
                        </Button>
                        <span slot="unsupported" className="text-xs text-[#94a3b8]">
                          Browser doesn't support WebSerial.
                        </span>
                        <span slot="not-allowed" className="text-xs text-[#94a3b8]">
                          WebSerial requires HTTPS or localhost.
                        </span>
                      </esp-web-install-button>
                    )}

                    <p className="text-[11px] text-[#94a3b8] leading-relaxed">
                      After flashing, join WiFi <code>Voltwatch-Setup</code> (pw{" "}
                      <code>voltwatch</code>) on your phone and enter your home WiFi. Onboard LED:
                      fast blink = portal open, slow blink = connecting, solid = online.
                    </p>
                  </section>
                </>
              )}

              {step === "advanced" && (
                <section className="space-y-4">
                  <h3
                    className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-900"
                    style={{ fontFamily: HEADING_FONT }}
                  >
                    Build & upload from Arduino IDE
                  </h3>
                  <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
                    <li>
                      Download <code>voltwatch.ino</code> and open it in Arduino IDE.
                    </li>
                    <li>
                      Install ESP32 board support and libraries:{" "}
                      <span className="font-semibold text-slate-900">WiFiManager</span>,{" "}
                      <span className="font-semibold text-slate-900">ArduinoJson</span>,{" "}
                      <span className="font-semibold text-slate-900">DHT sensor library</span>.
                    </li>
                    <li>
                      Board "ESP32 Dev Module" → pick COM port → Upload.
                    </li>
                  </ol>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={copy}
                      className="border-[#e8ecf1] text-slate-700"
                    >
                      <Copy className="mr-1 h-4 w-4" /> Copy code
                    </Button>
                    <Button
                      size="sm"
                      onClick={download}
                      className="bg-[#3b82f6] hover:bg-[#2563eb] text-white"
                    >
                      <Download className="mr-1 h-4 w-4" /> Download voltwatch.ino
                    </Button>
                  </div>
                </section>
              )}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
