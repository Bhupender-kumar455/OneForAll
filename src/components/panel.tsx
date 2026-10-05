import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A titled panel with an optional row of actions — the shared chrome behind the
 * input, output, diff, image and extracted-text panels.
 *
 * `className` is how a page hands a panel its height: the runner's desktop grid
 * stretches these, so each one fills its cell rather than guessing a size.
 */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      {children}
    </section>
  );
}
