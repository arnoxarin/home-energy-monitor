import { Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Props {
  version: string | null;
  build: string | null;
  reportedAt: string | null;
}

// Small badge showing the firmware version the ESP32 last reported.
// Helps confirm which .bin / LED logic is actually running on a device
// after an OTA / re-flash. Hover reveals the compile timestamp and when
// the device last checked in with this version.
export function FirmwareBadge({ version, build, reportedAt }: Props) {
  if (!version) {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] font-mono text-muted-foreground">
        <Cpu className="h-3 w-3" /> fw ?
      </Badge>
    );
  }
  const title = [
    `Firmware ${version}`,
    build ? `Build ${build}` : null,
    reportedAt ? `Reported ${new Date(reportedAt).toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Badge variant="secondary" className="gap-1 text-[10px] font-mono" title={title}>
      <Cpu className="h-3 w-3" /> fw {version}
    </Badge>
  );
}
