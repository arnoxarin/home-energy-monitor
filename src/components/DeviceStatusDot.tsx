import { useEffect, useState } from "react";

const ONLINE_WINDOW_MS = 30_000; // considered online if seen within 30s

export function DeviceStatusDot({
  lastSeenAt,
  className = "",
}: {
  lastSeenAt: string | null;
  className?: string;
}) {
  // Re-render every 5s so the dot flips to gray when the device stops posting
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const online =
    !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;

  const title = online
    ? `Online · last seen ${new Date(lastSeenAt!).toLocaleTimeString()}`
    : lastSeenAt
      ? `Offline · last seen ${new Date(lastSeenAt).toLocaleString()}`
      : "Offline · never seen";

  return (
    <span
      className={`relative inline-flex h-2.5 w-2.5 shrink-0 ${className}`}
      title={title}
      aria-label={title}
    >
      {online && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      )}
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
          online ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
      />
    </span>
  );
}
