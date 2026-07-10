import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Activity, ArrowLeft, Ban, Check, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DeviceStatusDot } from "@/components/DeviceStatusDot";
import { FirmwareBadge } from "@/components/FirmwareBadge";
import { LastSeenBadge } from "@/components/LastSeenBadge";

export const Route = createFileRoute("/_authenticated/devices")({
  component: DevicesPage,
});

interface Device {
  id: string;
  mac: string;
  name: string | null;
  status: "pending" | "approved" | "blocked";
  user_id: string | null;
  fw_version: string | null;
  last_seen: string | null;
  created_at: string;
}

function DevicesPage() {
  const navigate = useNavigate();

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("devices")
        .select("id, mac, name, status, user_id, fw_version, last_seen, created_at")
        .order("created_at");
      if (error) throw error;
      return data as Device[];
    },
    refetchInterval: 10_000,
  });

  const devices = devicesQ.data ?? [];
  const mine = devices.filter((d) => d.status !== "pending" || d.user_id);
  const pending = devices.filter((d) => d.status === "pending" && !d.user_id);

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/dashboard" })}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Activity className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">Devices</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Pending approval
          </h2>
          {devicesQ.isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : pending.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No devices waiting</CardTitle>
                <CardDescription>
                  Flash your ESP32 and it will register itself here automatically. Approve it to
                  bind it to your account.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            pending.map((d) => <PendingDeviceRow key={d.id} device={d} />)
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Your devices
          </h2>
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">You haven't approved any devices yet.</p>
          ) : (
            mine.map((d) => <DeviceRow key={d.id} device={d} />)
          )}
        </section>
      </main>
    </div>
  );
}

function PendingDeviceRow({ device }: { device: Device }) {
  const qc = useQueryClient();

  const approve = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const { error } = await supabase
        .from("devices")
        .update({ user_id: userData.user.id, status: "approved" })
        .eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Device approved");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const block = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not signed in");
      const { error } = await supabase
        .from("devices")
        .update({ user_id: userData.user.id, status: "blocked" })
        .eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Device blocked");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            {device.name || device.mac}
            <Badge variant="outline">pending</Badge>
          </CardTitle>
          <CardDescription>
            MAC <code className="font-mono">{device.mac}</code>
            {device.fw_version ? <> · fw {device.fw_version}</> : null}
            {device.last_seen ? <> · registered {new Date(device.last_seen).toLocaleString()}</> : null}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
            <Check className="mr-1 h-4 w-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => block.mutate()} disabled={block.isPending}>
            <Ban className="mr-1 h-4 w-4" /> Block
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}

function DeviceRow({ device }: { device: Device }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name ?? "");

  const rename = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("devices")
        .update({ name: name.trim() || null })
        .eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Renamed");
      setEditing(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const setStatus = useMutation({
    mutationFn: async (status: "approved" | "blocked") => {
      const { error } = await supabase.from("devices").update({ status }).eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success("Updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("devices").delete().eq("id", device.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      qc.invalidateQueries({ queryKey: ["sensors"] });
      toast.success("Device deleted");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" placeholder={device.mac} />
              <Button size="sm" onClick={() => rename.mutate()} disabled={rename.isPending}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(device.name ?? ""); }}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                <DeviceStatusDot lastSeenAt={device.last_seen} />
                {device.name || device.mac}
                <Badge variant={device.status === "approved" ? "secondary" : "destructive"}>
                  {device.status}
                </Badge>
                <FirmwareBadge version={device.fw_version} build={null} reportedAt={null} />
                <LastSeenBadge lastSeenAt={device.last_seen} />
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </CardTitle>
              <CardDescription>
                MAC <code className="font-mono">{device.mac}</code>
              </CardDescription>
            </>
          )}
        </div>
        <div className="flex gap-2">
          {device.status === "blocked" ? (
            <Button size="sm" variant="outline" onClick={() => setStatus.mutate("approved")}>
              <Check className="mr-1 h-4 w-4" /> Unblock
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setStatus.mutate("blocked")}>
              <Ban className="mr-1 h-4 w-4" /> Block
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon"><Trash2 className="h-4 w-4" /></Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete device?</AlertDialogTitle>
                <AlertDialogDescription>
                  All sensors and readings for this device will be removed. The physical ESP32 will
                  re-register as pending on its next boot.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {device.last_seen
          ? <>Last seen {new Date(device.last_seen).toLocaleString()}</>
          : "Never seen"}
      </CardContent>
    </Card>
  );
}
