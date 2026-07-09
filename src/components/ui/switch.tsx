import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-[background-color,box-shadow,opacity,filter] duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input data-[state=checked]:shadow-[0_0_0_4px_hsl(var(--primary)/0.15)] active:[&>span]:w-5 disabled:cursor-not-allowed disabled:opacity-60 disabled:saturate-50 disabled:shadow-none disabled:border-dashed disabled:border-muted-foreground/30 disabled:bg-muted data-[disabled][data-state=checked]:bg-muted-foreground/40 data-[disabled][data-state=checked]:shadow-none disabled:[transition-duration:500ms] disabled:[&>span]:bg-muted disabled:[&>span]:shadow-none disabled:[&>span]:ring-1 disabled:[&>span]:ring-muted-foreground/20",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-all duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>

));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
