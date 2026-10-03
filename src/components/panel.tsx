import type { ReactNode } from "react";

/**
 * A titled panel with an optional row of actions — the shared chrome behind the
 * input, output, diff, image and extracted-text panels.
 */
export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
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
