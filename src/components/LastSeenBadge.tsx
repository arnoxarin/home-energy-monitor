import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  lastSeenAt: string | null;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Relative "last seen" freshness badge shown next to the device name.
// Green = fresh (<30s, matches DeviceStatusDot's online window),
// amber = stale (<5m), red = long-offline, gray = never seen.
export function LastSeenBadge({ lastSeenAt }: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  if (!lastSeenAt) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[10px] font-mono text-muted-foreground"
        title="No data received yet"
      >
        <Clock className="h-3 w-3" /> never
      </Badge>
    );
  }

  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  const tone =
    ageMs < 30_000
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : ageMs < 5 * 60_000
        ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-destructive/40 bg-destructive/10 text-destructive";

  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-[10px] font-mono", tone)}
      title={`Last seen ${new Date(lastSeenAt).toLocaleString()}`}
    >
      <Clock className="h-3 w-3" /> {formatAgo(ageMs)}
    </Badge>
  );
}
