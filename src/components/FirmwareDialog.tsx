import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Cpu, Copy, Download } from "lucide-react";
import { toast } from "sonner";
// Vite bundles the .ino file as a raw string, so the firmware source
// is always in sync with what's in the repo.
import firmwareSource from "../../firmware/voltwatch/voltwatch.ino?raw";

export function FirmwareDialog() {
  const [open, setOpen] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(firmwareSource);
    toast.success("Firmware copied to clipboard");
  };

  const download = () => {
    const blob = new Blob([firmwareSource], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "voltwatch.ino";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Cpu className="mr-1 h-4 w-4" /> Firmware
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>ESP32 firmware</DialogTitle>
          <DialogDescription>
            Flash this once. WiFi, endpoint, and ingest key are then configured from the ESP's
            own captive portal — no re-flashing to change them.
          </DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Download <code>voltwatch.ino</code> below and open it in the Arduino IDE.</li>
          <li>
            Install ESP32 board support (Tools → Board → Boards Manager → “esp32”) and these
            libraries (Tools → Manage Libraries):
            <span className="ml-1 font-medium">WiFiManager</span>,
            <span className="ml-1 font-medium">ArduinoJson</span>,
            <span className="ml-1 font-medium">DHT sensor library</span>.
          </li>
          <li>Plug the ESP32 in → Tools → Board “ESP32 Dev Module” → pick the COM port → Upload.</li>
          <li>
            First boot: connect your phone to WiFi <code>Voltwatch-Setup</code> (pw:{" "}
            <code>voltwatch</code>), enter your home WiFi + ingest endpoint + device key.
          </li>
          <li>Hold the BOOT button ~3 s any time later to reopen the portal.</li>
        </ol>

        <div className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3">
          <pre className="text-[11px] leading-relaxed">
            <code>{firmwareSource}</code>
          </pre>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={copy}>
            <Copy className="mr-1 h-4 w-4" /> Copy code
          </Button>
          <Button onClick={download}>
            <Download className="mr-1 h-4 w-4" /> Download voltwatch.ino
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
