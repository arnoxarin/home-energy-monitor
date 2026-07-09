import { useEffect, useState, useSyncExternalStore } from "react";
import { Activity, Radio, WifiOff } from "lucide-react";
import { getLastReadingAt, getRecentCount, subscribe } from "@/lib/telemetry-pulse";

// Live per-device telemetry pill. Green + pulsing when readings are arriving,
// amber when the device is heartbeating but no readings for >20s, gray when
// the device itself hasn't been seen in >30s.
const ONLINE_WINDOW_MS = 30_000;
const IDLE_WINDOW_MS = 20_000;

export function TelemetryStatus({
  sensorIds,
  lastSeenAt,
  className = "",
}: {
  sensorIds: string[];
  lastSeenAt: string | null;
  className?: string;
}) {
  // Re-render every 2s so the pill decays even when nothing new arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  // Also re-render whenever a new reading is pushed into the pulse store.
  useSyncExternalStore(
    subscribe,
    () => getRecentCount(sensorIds),
    () => 0,
  );

  const now = Date.now();
  const deviceSeenAt = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  const deviceOnline = deviceSeenAt > 0 && now - deviceSeenAt < ONLINE_WINDOW_MS;
  const count = getRecentCount(sensorIds, now);
  const lastReading = getLastReadingAt(sensorIds);
  const readingFresh = lastReading !== null && now - lastReading < IDLE_WINDOW_MS;

  let state: "live" | "idle" | "offline";
  if (!deviceOnline) state = "offline";
  else if (readingFresh || count > 0) state = "live";
  else state = "idle";

  const styles = {
    live: {
      bg: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      dot: "bg-emerald-500",
      Icon: Activity,
      label: `Live · ${count}/min`,
    },
    idle: {
      bg: "bg-amber-500/15 text-amber-600 border-amber-500/40",
      dot: "bg-amber-500",
      Icon: Radio,
      label: "Idle · no readings",
    },
    offline: {
      bg: "bg-muted text-muted-foreground border-border",
      dot: "bg-muted-foreground/50",
      Icon: WifiOff,
      label: "Offline",
    },
  }[state];

  const title =
    state === "live"
      ? `${count} readings in last 60s${lastReading ? ` · last ${Math.max(0, Math.round((now - lastReading) / 1000))}s ago` : ""}`
      : state === "idle"
        ? "Device is online but not sending readings"
        : lastSeenAt
          ? `Offline · last seen ${new Date(lastSeenAt).toLocaleString()}`
          : "Offline · never seen";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles.bg} ${className}`}
      title={title}
      aria-label={title}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {state === "live" && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${styles.dot}`} />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${styles.dot}`} />
      </span>
      <styles.Icon className="h-3 w-3" />
      {styles.label}
    </span>
  );
}
