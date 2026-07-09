import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu, Download, FileWarning, Loader2, RefreshCw } from "lucide-react";
import firmwareSource from "../../firmware/voltwatch/voltwatch.ino?raw";

const BIN_URL = "/firmware/voltwatch-esp32.bin";
const POLL_MS = 10_000;

// Pull FW_VERSION out of the bundled .ino so the "source version" shown here
// is always in sync with what a fresh compile would report to the backend.
function parseSourceVersion(src: string): string | null {
  const m = src.match(/#define\s+FW_VERSION\s+"([^"]+)"/);
  return m ? m[1] : null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface BinStatus {
  available: boolean;
  size: number | null;
  lastModified: string | null;
  checkedAt: number;
}

/**
 * Live status card for the flashable firmware .bin.
 *
 * - Source version is parsed out of the bundled voltwatch.ino at build time,
 *   so it always matches what a fresh compile would report to the backend.
 * - Binary metadata (availability, size, build time) is polled from a HEAD
 *   request every 10s, so if someone drops a new .bin into
 *   public/firmware/voltwatch-esp32.bin it lights up here without a reload.
 */
export function FirmwareBuildStatus() {
  const sourceVersion = parseSourceVersion(firmwareSource);
  const [status, setStatus] = useState<BinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);

  const check = async () => {
    try {
      const res = await fetch(BIN_URL, { method: "HEAD", cache: "no-store" });
      if (!res.ok) {
        setStatus({ available: false, size: null, lastModified: null, checkedAt: Date.now() });
      } else {
        const len = res.headers.get("content-length");
        setStatus({
          available: true,
          size: len ? Number(len) : null,
          lastModified: res.headers.get("last-modified"),
          checkedAt: Date.now(),
        });
      }
    } catch {
      setStatus({ available: false, size: null, lastModified: null, checkedAt: Date.now() });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void check();
    const poll = setInterval(check, POLL_MS);
    // Re-render for the "checked Xs ago" label
    const rerender = setInterval(() => tick((n) => n + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(rerender);
    };
  }, []);

  const builtAt = status?.lastModified ? new Date(status.lastModified) : null;

  return (
    <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">Build status</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLoading(true);
            void check();
          }}
          disabled={loading}
          title="Re-check binary"
        >
          <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Source version
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="secondary" className="font-mono text-[11px]">
              fw {sourceVersion ?? "?"}
            </Badge>
            <span className="text-xs text-muted-foreground">from voltwatch.ino</span>
          </div>
        </div>

        <div className="rounded-md border bg-background p-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Binary</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {loading && !status ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> checking…
              </span>
            ) : status?.available ? (
              <>
                <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40">
                  available
                </Badge>
                {status.size != null && (
                  <span className="text-xs text-muted-foreground">{formatSize(status.size)}</span>
                )}
                {builtAt && (
                  <span
                    className="text-xs text-muted-foreground"
                    title={builtAt.toLocaleString()}
                  >
                    · built {formatAgo(Date.now() - builtAt.getTime())}
                  </span>
                )}
              </>
            ) : (
              <span className="flex items-center gap-1 text-xs text-amber-600">
                <FileWarning className="h-3 w-3" /> not built yet
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {status ? `Checked ${formatAgo(Date.now() - status.checkedAt)}` : "Waiting for first check"}
          {" · auto-refreshes every 10s"}
        </div>
        <a
          href={BIN_URL}
          download
          className={
            "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium " +
            (status?.available
              ? "hover:bg-accent"
              : "pointer-events-none opacity-40")
          }
          aria-disabled={!status?.available}
        >
          <Download className="mr-1 h-3.5 w-3.5" /> Download .bin
        </a>
      </div>
    </div>
  );
}
