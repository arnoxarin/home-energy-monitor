import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Cpu, Wifi, Settings2, RefreshCw } from "lucide-react";
import { FirmwareDialog } from "@/components/FirmwareDialog";

export const Route = createFileRoute("/_authenticated/setup")({
  component: SetupPage,
});

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
        {n}
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold leading-tight">{title}</h3>
        <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function SetupPage() {
  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
          <Link to="/dashboard">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Settings2 className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Setup</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8 space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-primary" />
              <CardTitle>1. Flash the ESP32</CardTitle>
            </div>
            <CardDescription>You only do this once. From then on everything is remote.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Step n={1} title="Grab the firmware">
              Open the Firmware button below to copy or download <code>voltwatch.ino</code>.
              <div className="mt-2"><FirmwareDialog /></div>
            </Step>
            <Step n={2} title="Install Arduino IDE + ESP32 support">
              Get <a className="underline" href="https://www.arduino.cc/en/software" target="_blank" rel="noreferrer">Arduino IDE</a>.
              Add the ESP32 board URL in <em>Preferences → Additional board manager URLs</em>:
              <code className="ml-1 rounded bg-muted px-1 text-[11px]">https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json</code>,
              then install <strong>esp32</strong> in <em>Boards Manager</em>.
            </Step>
            <Step n={3} title="Install libraries">
              In <em>Tools → Manage Libraries</em>, install: <strong>WiFiManager</strong> (tzapu),
              <strong> ArduinoJson</strong> (Blanchon), and <strong>DHT sensor library</strong> (Adafruit).
            </Step>
            <Step n={4} title="Upload">
              Plug the ESP32 in with USB. Pick <em>Tools → Board → ESP32 Dev Module</em>,
              select the COM/tty port, and click the Upload arrow.
            </Step>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Wifi className="h-5 w-5 text-primary" />
              <CardTitle>2. Connect to WiFi via the captive portal</CardTitle>
            </div>
            <CardDescription>The ESP hosts its own setup network on first boot.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Step n={1} title="Join the setup network">
              After upload, on your phone connect to WiFi{" "}
              <code className="rounded bg-muted px-1">Voltwatch-Setup</code> with password{" "}
              <code className="rounded bg-muted px-1">voltwatch</code>. A configuration page opens
              automatically (if not, browse to <code>http://192.168.4.1</code>).
            </Step>
            <Step n={2} title="Pick your home WiFi">
              Tap <em>Configure WiFi</em>, choose your home SSID, and enter the password.
            </Step>
            <Step n={3} title="Paste your ingest details">
              In the same portal, paste the <strong>Ingest URL</strong> and{" "}
              <strong>Device ingest key</strong> shown on the dashboard under{" "}
              <em>Show ingest details</em>. Save. The ESP reboots and connects.
            </Step>
            <Step n={4} title="Change settings later">
              Any time you need to switch WiFi or update the ingest key, hold the{" "}
              <strong>BOOT</strong> button on the ESP32 for about 3 seconds — the portal reopens.
            </Step>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              <CardTitle>3. Add sensors from the dashboard</CardTitle>
            </div>
            <CardDescription>
              No re-flashing. The ESP polls the app every ~15 s and reconfigures itself.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Step n={1} title="Add or edit a sensor">
              On the dashboard tap <em>Add sensor</em>. Pick the type (DHT22, relay, analog…),
              pin, and how you want it displayed. Save.
            </Step>
            <Step n={2} title="Wait for the next sync">
              Within ~15 seconds the ESP fetches the new config and starts sampling that pin.
              Readings appear on the tile automatically.
            </Step>
            <Step n={3} title="Toggle relays live">
              Switches on the dashboard update the physical output pin on the next ingest cycle
              (~5 s). No firmware changes needed.
            </Step>
            <Step n={4} title="Move a sensor to a different pin">
              Open the sensor's edit page, change the pin, save. The ESP picks up the new pin on
              its next sync — safe to do without rebooting.
            </Step>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
