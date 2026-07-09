import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, PlugZap, CheckCircle2, Wifi, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createPairCode, getPairCodeStatus } from "@/lib/pair-code.functions";
import { toast } from "sonner";

/**
 * Modal that mints a 6-digit code, shows it big, and polls until an ESP32
 * has claimed it. When claimed, the devices list is invalidated so the
 * new device appears on the dashboard.
 */
export function PairDeviceDialog({
  trigger,
}: {
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pairId, setPairId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const qc = useQueryClient();

  const create = useServerFn(createPairCode);
  const status = useServerFn(getPairCodeStatus);

  const mint = useMutation({
    mutationFn: async () => await create(),
    onSuccess: (d) => {
      setPairId(d.id);
      setCode(d.code);
      setExpiresAt(d.expires_at);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Mint a code as soon as the dialog opens.
  useEffect(() => {
    if (open && !pairId && !mint.isPending) mint.mutate();
    if (!open) {
      setPairId(null);
      setCode(null);
      setExpiresAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Tick a clock so the countdown updates.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const secondsLeft = useMemo(() => {
    if (!expiresAt) return 0;
    return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  }, [expiresAt, now]);
  const expired = expiresAt !== null && secondsLeft === 0;

  // Poll status while waiting.
  const statusQ = useQuery({
    queryKey: ["pair-code-status", pairId],
    enabled: !!pairId && open && !expired,
    refetchInterval: 2500,
    queryFn: async () => await status({ data: { id: pairId! } }),
  });

  const claimed = statusQ.data?.found && statusQ.data.claimed;
  const claimedName = claimed ? statusQ.data?.device_name : null;

  useEffect(() => {
    if (claimed) {
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["devices-for-firmware"] });
      toast.success(`Paired: ${claimedName ?? "new device"}`);
    }
  }, [claimed, claimedName, qc]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <PlugZap className="mr-1 h-4 w-4" /> Pair new device
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pair a new ESP32</DialogTitle>
          <DialogDescription>
            Type this code into the ESP32's WiFi setup portal along with your
            home WiFi. The device will register itself and appear on your
            dashboard automatically — no need to create it first.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/40 p-6 text-center space-y-3">
          {mint.isPending || !code ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating code…
            </div>
          ) : claimed ? (
            <div className="py-4 space-y-2">
              <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
              <div className="text-lg font-semibold">Device paired</div>
              <div className="text-sm text-muted-foreground">
                {claimedName ?? "Your new device"} is now on the dashboard.
              </div>
            </div>
          ) : (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Pairing code
              </div>
              <div
                className="text-5xl font-bold tracking-[0.35em] tabular-nums text-primary select-all"
                aria-label={`Pairing code ${code}`}
              >
                {code}
              </div>
              {expired ? (
                <div className="text-xs text-destructive">
                  Code expired. Generate a new one.
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Wifi className="h-3.5 w-3.5" />
                  Waiting for ESP32 …
                  <span className="tabular-nums">
                    {minutes}:{seconds}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-5">
          <li>
            Flash the generic firmware (Firmware dialog → Pair via code).
          </li>
          <li>
            Join WiFi <code>Voltwatch-Setup</code> (pw <code>voltwatch</code>)
            on your phone.
          </li>
          <li>
            Enter your home WiFi <em>and</em> the code above, then Save.
          </li>
        </ol>

        <div className="flex justify-between gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPairId(null);
              setCode(null);
              setExpiresAt(null);
              mint.mutate();
            }}
            disabled={mint.isPending}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> New code
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            {claimed ? "Done" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
