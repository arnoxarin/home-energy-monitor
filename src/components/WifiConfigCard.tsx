import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wifi, Eye, EyeOff, ShieldCheck, Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

export const WIFI_STORAGE_KEY = "voltwatch:wifi";

export type WifiConfig = { ssid: string; pass: string };

const wifiSchema = z.object({
  ssid: z
    .string()
    .trim()
    .min(1, "Network name is required")
    .max(32, "SSID must be 32 characters or fewer"),
  pass: z
    .string()
    .max(63, "Password must be 63 characters or fewer")
    .refine((v) => v.length === 0 || v.length >= 8, {
      message: "WPA/WPA2 passwords must be at least 8 characters",
    }),
});

export function readWifiConfig(): WifiConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WIFI_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const result = wifiSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function WifiConfigCard() {
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const current = readWifiConfig();
    if (current) {
      setSsid(current.ssid);
      setPass(current.pass);
      setSaved(true);
    }
  }, []);

  const save = () => {
    const result = wifiSchema.safeParse({ ssid, pass });
    if (!result.success) {
      toast.error(result.error.issues[0]?.message ?? "Invalid WiFi details");
      return;
    }
    window.localStorage.setItem(WIFI_STORAGE_KEY, JSON.stringify(result.data));
    setSaved(true);
    toast.success("WiFi saved — next firmware download will include it");
  };

  const clear = () => {
    window.localStorage.removeItem(WIFI_STORAGE_KEY);
    setSsid("");
    setPass("");
    setSaved(false);
    toast.success("WiFi credentials cleared from this browser");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wifi className="h-5 w-5 text-primary" />
          <CardTitle>Home WiFi (optional)</CardTitle>
        </div>
        <CardDescription>
          Pre-fill your home network so the next firmware download connects on first boot — no captive
          portal needed. Credentials stay in this browser and are only baked into the firmware file
          you download.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="wifi-ssid">Network name (SSID)</Label>
          <Input
            id="wifi-ssid"
            value={ssid}
            onChange={(e) => setSsid(e.target.value)}
            maxLength={32}
            placeholder="MyHomeWiFi"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wifi-pass">Password</Label>
          <div className="relative">
            <Input
              id="wifi-pass"
              type={reveal ? "text" : "password"}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              maxLength={63}
              placeholder="At least 8 characters (leave blank for open networks)"
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Stored only in this browser's local storage. Never sent to the server. If baked WiFi fails
            on the ESP32, the setup portal opens automatically as a fallback.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} size="sm">
            <Save className="mr-1 h-4 w-4" /> Save WiFi
          </Button>
          {saved && (
            <Button onClick={clear} size="sm" variant="outline">
              Clear
            </Button>
          )}
          {saved && (
            <span className="text-xs text-muted-foreground">
              Saved · used automatically in Firmware downloads.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
