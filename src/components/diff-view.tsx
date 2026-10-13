import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { DiffResult } from "@/lib/format/diff";
import { cn } from "@/lib/utils";

/**
 * The side-by-side diff body: two gutter-numbered columns per row, with the old
 * side tinted on removals and the new side tinted on additions. Rows render
 * lazily (see `.diff-row` in `index.css`), so a long comparison scrolls without
 * a virtualisation library.
 *
 * Used by the formatter's diff panel and by the diff checker page, so both
 * comparisons look and behave identically.
 */
export function DiffView({ result }: { result: DiffResult }) {
  return (
    <>
      <div
        data-testid="diff-view"
        className="editor-scroll max-h-[60vh] overflow-y-auto"
      >
        {result.rows.map((row, index) => (
          <div
            key={index}
            data-testid="diff-row"
            className="diff-row flex border-b border-border/60 last:border-b-0"
          >
            <div
              className={cn(
                "diff-side flex w-1/2 border-r border-border/60",
                (row.kind === "removed" || row.kind === "changed") &&
                  "diff-removed",
              )}
            >
              <span className="w-11 shrink-0 select-none px-2 text-right font-mono text-[11px] leading-6 text-muted-foreground/70">
                {row.leftNumber ?? ""}
              </span>
              <span className="shrink-0 whitespace-pre px-2 font-mono text-[12.5px] leading-6 text-foreground">
                {row.left ?? ""}
              </span>
            </div>
            <div
              className={cn(
                "diff-side flex w-1/2",
                (row.kind === "added" || row.kind === "changed") && "diff-added",
              )}
            >
              <span className="w-11 shrink-0 select-none px-2 text-right font-mono text-[11px] leading-6 text-muted-foreground/70">
                {row.rightNumber ?? ""}
              </span>
              <span className="shrink-0 whitespace-pre px-2 font-mono text-[12.5px] leading-6 text-foreground">
                {row.right ?? ""}
              </span>
            </div>
          </div>
        ))}
      </div>
      {result.approximate && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          Too large to align line by line — shown as one replaced block.
        </p>
      )}
    </>
  );
}

/**
 * The panel-sized stand-in shown before there is anything to compare, and when
 * the two sides already match. Keeping it here means every diff panel reserves
 * the same height and uses the same type.
 */
export function DiffMessage({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex h-[110px] items-center justify-center p-6 text-center">
      <div>
        <Icon className="mx-auto h-5 w-5 text-muted-foreground/60" />
        <p className="mt-2 text-[13px] text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

/**
 * The one-line summary used as a diff panel's subtitle: "3 lines added · 1
 * removed". A rewritten line counts on both sides, matching how the rows are
 * paired.
 */
export function diffSummary(result: DiffResult): string {
  const added = result.added + result.changed;
  const removed = result.removed + result.changed;
  return `${added} line${added === 1 ? "" : "s"} added · ${removed} removed`;
}

/**
 * The `+added −removed` pill for a panel's action slot. Both sides count as
 * changed, matching how the rows are paired.
 */
export function DiffCounts({ result }: { result: DiffResult }) {
  return (
    <span className="mr-0.5 flex items-center gap-2 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] font-medium">
      <span className="text-chart-5">+{result.added + result.changed}</span>
      <span className="text-destructive">−{result.removed + result.changed}</span>
    </span>
  );
}
