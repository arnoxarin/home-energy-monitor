import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Cpu, Download, FileWarning, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
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

      <VerifyBuildRow available={!!status?.available} />

      <div className="flex flex-wrap items-center justify-end gap-2">

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

type VerifyState =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | {
      kind: "match";
      sha256: string;
      size: number;
    }
  | {
      kind: "mismatch";
      serverSha: string;
      localSha: string;
      serverSize: number;
      localSize: number;
    }
  | { kind: "error"; message: string };

// Downloads the .bin and hashes it locally, then compares against the
// server-computed manifest. Only when both match is it safe to flash.
function VerifyBuildRow({ available }: { available: boolean }) {
  const [state, setState] = useState<VerifyState>({ kind: "idle" });

  const run = async () => {
    setState({ kind: "running", step: "Fetching server manifest…" });
    try {
      const mRes = await fetch("/api/public/firmware-manifest", { cache: "no-store" });
      if (!mRes.ok) throw new Error(`manifest HTTP ${mRes.status}`);
      const manifest = (await mRes.json()) as {
        available: boolean;
        sha256?: string;
        size?: number;
      };
      if (!manifest.available || !manifest.sha256 || manifest.size == null) {
        throw new Error("Server has no binary to verify against");
      }

      setState({ kind: "running", step: "Downloading .bin…" });
      const bRes = await fetch(BIN_URL, { cache: "no-store" });
      if (!bRes.ok) throw new Error(`bin HTTP ${bRes.status}`);
      const buf = await bRes.arrayBuffer();

      setState({ kind: "running", step: "Hashing locally…" });
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const localSha = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (localSha === manifest.sha256 && buf.byteLength === manifest.size) {
        setState({ kind: "match", sha256: localSha, size: buf.byteLength });
      } else {
        setState({
          kind: "mismatch",
          serverSha: manifest.sha256,
          localSha,
          serverSize: manifest.size,
          localSize: buf.byteLength,
        });
      }
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div className="rounded-md border bg-background p-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">Verify build</span>
          <span className="text-muted-foreground">
            Compares SHA-256 + size of the .bin against the server manifest.
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={run}
          disabled={!available || state.kind === "running"}
        >
          {state.kind === "running" ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Verifying…
            </>
          ) : (
            <>
              <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Verify build
            </>
          )}
        </Button>
      </div>

      {state.kind === "running" && (
        <div className="text-[11px] text-muted-foreground">{state.step}</div>
      )}

      {state.kind === "match" && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <div className="min-w-0">
            <div className="font-medium text-emerald-700 dark:text-emerald-400">
              Match — safe to flash
            </div>
            <div className="font-mono break-all text-muted-foreground">
              sha256 {state.sha256}
            </div>
            <div className="text-muted-foreground">{formatSize(state.size)}</div>
          </div>
        </div>
      )}

      {state.kind === "mismatch" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-destructive">
              Mismatch — do NOT flash. The download differs from the server binary.
            </div>
            <div className="font-mono break-all">
              <div className="text-muted-foreground">server sha256 {state.serverSha}</div>
              <div className="text-muted-foreground">local  sha256 {state.localSha}</div>
            </div>
            <div className="text-muted-foreground">
              server {formatSize(state.serverSize)} · local {formatSize(state.localSize)}
            </div>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <div className="text-amber-700 dark:text-amber-400">{state.message}</div>
        </div>
      )}
    </div>
  );
}

