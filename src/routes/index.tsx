import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Cpu, LineChart, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Voltwatch</span>
        </div>
        <Link to="/auth">
          <Button variant="outline">Sign in</Button>
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pt-16 pb-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-block rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            ESP32 · PZEM-04 · Realtime
          </span>
          <h1 className="mt-6 text-5xl font-bold tracking-tight sm:text-6xl">
            See every watt your home draws.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            Plug your ESP32 + PZEM-04 into Voltwatch and stream voltage, current, power and energy
            live. Add more sensors — DHT22, ultrasonic, radar, relays — and design your own
            dashboard.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/auth">
              <Button size="lg">Get started</Button>
            </Link>
          </div>
        </div>

        <div className="mt-20 grid gap-4 sm:grid-cols-3">
          {[
            { icon: Plug, title: "Plug & stream", body: "Register a device, drop the ingest key in your ESP32 sketch, done." },
            { icon: LineChart, title: "Live graphs", body: "Charts, numeric tiles and buttons — pick per sensor." },
            { icon: Cpu, title: "Any sensor", body: "PZEM-04, DHT22, ultrasonic, radar, relay, generic analog or digital." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-6">
              <f.icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
