import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  CaseSensitive,
  Check,
  Copy,
  FileDiff,
  Pilcrow,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

import {
  DiffCounts,
  DiffMessage,
  DiffView,
  diffSummary,
} from "@/components/diff-view";
import { Panel } from "@/components/panel";
import { SiteHeader } from "@/components/site-header";
import { countStats, formatBytes } from "@/lib/bytes";
import { diffLines, type DiffOptions } from "@/lib/format/diff";
import { BUTTON_BASE } from "@/lib/styles";
import { cn } from "@/lib/utils";

type Side = "left" | "right";

type Sample = { name: string; before: string; after: string };

/** Two versions of the same file, the way the checker is normally used. */
const SAMPLES: Sample[] = [
  {
    name: "Function refactor",
    before: `const users=[{id:1,name:"Ada",role:"admin"},{id:2,name:"Linus",role:"dev"}];
function summarize(list){
  let total=0;
  for(const user of list){
    if(!user) continue;
    total+=1;
  }
  return {count:total,names:list.map(user=>user.name)};
}
const config={retries:3,timeout:5000};
export default summarize;`,
    after: `const users = [{ id: 1, name: "Ada", role: "admin" }, { id: 2, name: "Linus", role: "dev" }];

function summarize(list) {
  const names = [];
  for (const user of list) {
    if (!user) continue;
    names.push(user.name);
  }
  return { count: names.length, names };
}

const config = { retries: 3, timeout: 5000 };
export default summarize;`,
  },
  {
    name: "Config change",
    before: `{
  "name": "code-compact",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "prettier": "^3.6.2"
  }
}`,
    after: `{
  "name": "code-compact",
  "version": "1.1.0",
  "private": true,
  "scripts": {
    "dev": "vite --config vite.config.ts",
    "build": "vite build",
    "test": "node --test"
  },
  "dependencies": {
    "prettier": "^3.9.6"
  }
}`,
  },
];

/** The comparison switches, in the order they appear in the controls card. */
const COMPARE_OPTIONS: {
  key: keyof DiffOptions;
  label: string;
  hint: string;
  icon: typeof Pilcrow;
}[] = [
  {
    key: "ignoreWhitespace",
    label: "Ignore whitespace",
    hint: "Treat lines that differ only by spacing or indentation as equal.",
    icon: Pilcrow,
  },
  {
    key: "ignoreCase",
    label: "Ignore case",
    hint: "Treat lines that differ only by letter case as equal.",
    icon: CaseSensitive,
  },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export default function DiffCheckerPage() {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [options, setOptions] = useState<DiffOptions>({});
  const [sampleIndex, setSampleIndex] = useState(0);
  const [copied, setCopied] = useState<Side | null>(null);
  const leftFileRef = useRef<HTMLInputElement>(null);
  const rightFileRef = useRef<HTMLInputElement>(null);

  const leftStats = useMemo(() => countStats(left), [left]);
  const rightStats = useMemo(() => countStats(right), [right]);

  // Comparing only starts once there is something on both sides: a half-filled
  // form should not read as "everything was removed".
  const ready = left.length > 0 && right.length > 0;
  const diff = useMemo(
    () => (ready ? diffLines(left, right, options) : null),
    [ready, left, right, options],
  );
  const byteDelta = rightStats.bytes - leftStats.bytes;

  const loadSample = () => {
    const next = (sampleIndex + 1) % SAMPLES.length;
    setSampleIndex(next);
    setLeft(SAMPLES[next].before);
    setRight(SAMPLES[next].after);
  };

  const swapSides = () => {
    setLeft(right);
    setRight(left);
  };

  const clearBoth = () => {
    setLeft("");
    setRight("");
  };

  const handleUpload = (side: Side, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => (side === "left" ? setLeft(text) : setRight(text)))
      .catch(() => undefined);
    event.target.value = "";
  };

  const handleCopy = async (side: Side) => {
    try {
      await navigator.clipboard.writeText(side === "left" ? left : right);
      setCopied(side);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const panels: { side: Side; title: string; stats: typeof leftStats }[] = [
    { side: "left", title: "Original", stats: leftStats },
    { side: "right", title: "Changed", stats: rightStats },
  ];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <SiteHeader active="diff" />

      <main className="px-4 pb-16 pt-10 sm:px-6 lg:px-10">
        <div className="fade-in">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Code Diff Checker
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            Paste two versions of a file and see exactly which lines were added,
            removed or changed. The comparison runs as you type, entirely in your
            browser — nothing is uploaded.
          </p>
        </div>

        {/* Controls */}
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-4">
          <Field label="Compare">
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              {COMPARE_OPTIONS.map((option) => {
                const active = options[option.key] === true;
                const Icon = option.icon;
                return (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={active}
                    title={option.hint}
                    data-testid={`toggle-${option.key}`}
                    onClick={() =>
                      setOptions((current) => ({
                        ...current,
                        [option.key]: !current[option.key],
                      }))
                    }
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 text-[13px] font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-[var(--shadow-sm)]"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={swapSides}
              disabled={!left && !right}
              data-testid="button-swap-sides"
              className={cn(
                BUTTON_BASE,
                "h-9 border border-border px-3 hover:bg-muted",
              )}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" /> Swap sides
            </button>
            <button
              type="button"
              onClick={loadSample}
              data-testid="button-load-sample"
              className={cn(
                BUTTON_BASE,
                "h-9 border border-border px-3 hover:bg-muted",
              )}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Sample
            </button>
            <button
              type="button"
              onClick={clearBoth}
              disabled={!left && !right}
              data-testid="button-clear-both"
              className={cn(
                BUTTON_BASE,
                "h-9 border border-border px-3 hover:bg-muted",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          </div>
        </div>

        {/* The two sides */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {panels.map(({ side, title, stats }) => (
            <Panel
              key={side}
              title={title}
              subtitle={`${stats.lines} lines · ${formatBytes(stats.bytes)}`}
              actions={
                <>
                  <input
                    ref={side === "left" ? leftFileRef : rightFileRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => handleUpload(side, event)}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      (side === "left" ? leftFileRef : rightFileRef).current?.click()
                    }
                    className={cn(
                      BUTTON_BASE,
                      "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Upload className="h-3.5 w-3.5" /> Load
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopy(side)}
                    disabled={side === "left" ? !left : !right}
                    aria-label={`Copy ${title.toLowerCase()}`}
                    className={cn(
                      BUTTON_BASE,
                      "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {copied === side ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === side ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => (side === "left" ? setLeft("") : setRight(""))}
                    disabled={side === "left" ? !left : !right}
                    aria-label={`Clear ${title.toLowerCase()}`}
                    className={cn(
                      BUTTON_BASE,
                      "h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            >
              <textarea
                value={side === "left" ? left : right}
                onChange={(event) =>
                  side === "left" ? setLeft(event.target.value) : setRight(event.target.value)
                }
                spellCheck={false}
                wrap="off"
                aria-label={title}
                data-testid={`input-${side}`}
                placeholder={
                  side === "left"
                    ? "Paste the original code here…"
                    : "Paste the changed code here…"
                }
                className="editor-scroll h-[34vh] min-h-[220px] w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </Panel>
          ))}
        </div>

        {/* Side-by-side diff */}
        <div className="mt-3">
          <Panel
            title="Diff"
            subtitle={
              diff && !diff.identical
                ? diffSummary(diff)
                : "original against changed"
            }
            actions={diff && !diff.identical ? <DiffCounts result={diff} /> : undefined}
          >
            {!diff ? (
              <DiffMessage icon={FileDiff}>
                {ready
                  ? "A line-by-line comparison appears here"
                  : "Add code to both sides to compare them"}
              </DiffMessage>
            ) : diff.identical ? (
              <DiffMessage icon={Check}>
                {options.ignoreWhitespace || options.ignoreCase
                  ? "No differences — the two sides match under the current options"
                  : "No differences — the two sides are identical"}
              </DiffMessage>
            ) : (
              <DiffView result={diff} />
            )}
          </Panel>
        </div>

        {/* Status strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span>{leftStats.lines} → {rightStats.lines} lines</span>
          {diff ? (
            diff.identical ? (
              <span className="text-foreground">
                {options.ignoreWhitespace || options.ignoreCase
                  ? "no differences under the current options"
                  : "no differences"}
              </span>
            ) : (
              <span className="text-foreground">
                +{diff.added + diff.changed} / −{diff.removed + diff.changed} lines
                {diff.unchanged > 0 ? `, ${diff.unchanged} unchanged` : ""}
              </span>
            )
          ) : (
            <span>waiting for both sides</span>
          )}
          {diff && !diff.identical && byteDelta !== 0 && (
            <span>
              {byteDelta < 0
                ? `${formatBytes(-byteDelta)} smaller`
                : `${formatBytes(byteDelta)} larger`}
            </span>
          )}
          {diff?.approximate && <span>alignment approximated</span>}
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            <FileDiff className="h-3.5 w-3.5" />
            runs in your browser
          </span>
        </div>
      </main>
    </div>
  );
}
