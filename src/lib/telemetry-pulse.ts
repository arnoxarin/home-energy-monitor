// Tracks timestamps of incoming sensor readings per sensor so UI components
// can show a live "readings/min" pulse without hitting the database.
// A small module-level store + subscribe/getSnapshot pattern that works with
// React's useSyncExternalStore.

type Listener = () => void;

const timestamps = new Map<string, number[]>();
const listeners = new Set<Listener>();
const WINDOW_MS = 60_000;

function prune(now: number) {
  for (const [id, arr] of timestamps) {
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) timestamps.delete(id);
    else timestamps.set(id, kept);
  }
}

export function recordReading(sensorId: string, ts: number = Date.now()) {
  const arr = timestamps.get(sensorId) ?? [];
  arr.push(ts);
  timestamps.set(sensorId, arr);
  prune(ts);
  for (const l of listeners) l();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getRecentCount(sensorIds: string[], now: number = Date.now()): number {
  let total = 0;
  for (const id of sensorIds) {
    const arr = timestamps.get(id);
    if (!arr) continue;
    for (const t of arr) if (now - t < WINDOW_MS) total++;
  }
  return total;
}

export function getLastReadingAt(sensorIds: string[]): number | null {
  let latest: number | null = null;
  for (const id of sensorIds) {
    const arr = timestamps.get(id);
    if (!arr || arr.length === 0) continue;
    const last = arr[arr.length - 1];
    if (latest === null || last > latest) latest = last;
  }
  return latest;
}
