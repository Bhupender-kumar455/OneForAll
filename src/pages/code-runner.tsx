import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Clock,
  Gauge,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";

import { Panel } from "@/components/panel";
import { SiteHeader } from "@/components/site-header";
import { formatBytes } from "@/lib/bytes";
import { RUNNER_LANGUAGES } from "@/lib/runner/data/languages";
import {
  executeCode,
  executionAvailable,
  RunnerError,
} from "@/lib/runner/execute-client";
import type { EditorHandle } from "@/components/runner/runner-editor";
import type { ExecutionResult, RunPhase } from "@/lib/runner/types";
import { BUTTON_BASE } from "@/lib/styles";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The Monaco wrapper is the only heavy thing on this page, so it is the only
 * thing split out: nothing here pulls the editor's megabyte until the tab is
 * actually open.
 */
const RunnerEditor = lazy(() =>
  import("@/components/runner/runner-editor").then((module) => ({
    default: module.RunnerEditor,
  })),
);

/** Server-side ceilings, shown in the footer so the numbers are not a mystery. */
const MAX_SOURCE_BYTES = 200_000;
const MAX_STDIN_BYTES = 50_000;

/** How the phase reads in the status pill. */
const PHASE_LABEL: Record<RunPhase, string> = {
  idle: "Ready",
  submitting: "Submitting",
  running: "Running",
  done: "Finished",
  cancelled: "Cancelled",
  error: "Failed",
};

/** Which section of the output the user is looking at. */
type OutputTab = "stdout" | "stderr" | "compile";

type Failure = { where: "run" | "api"; text: string };

/** A labelled control, matching the formatter toolbar. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export default function CodeRunnerPage() {
  const [languageId, setLanguageId] = useState(RUNNER_LANGUAGES[0]!.id);
  const [source, setSource] = useState(RUNNER_LANGUAGES[0]!.defaultCode);
  const [stdin, setStdin] = useState("");
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [outputTab, setOutputTab] = useState<OutputTab>("stdout");
  const [copied, setCopied] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);

  const abort = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const theme = useTheme();

  const language = RUNNER_LANGUAGES.find((item) => item.id === languageId) ?? RUNNER_LANGUAGES[0]!;
  const busy = phase === "submitting" || phase === "running";

  // A static-only host has no /api/execute. Ask once, and say so in the panel
  // rather than letting the first Run fail with a confusing message.
  useEffect(() => {
    let cancelled = false;
    void executionAvailable().then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Releasing the in-flight request on unmount is what keeps a navigation from
  // leaving an execution running against the provider.
  useEffect(() => () => abort.current?.abort(), []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);

  const run = useCallback(
    async (code: string) => {
      if (code.trim() === "") {
        setFailure({ where: "run", text: "Write something before running it." });
        setPhase("error");
        return;
      }

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setResult(null);
      setFailure(null);
      setOutputTab("stdout");
      setPhase("submitting");

      // Polling is gone: the API waits upstream and answers once. This timer
      // exists only so the pill moves to "Running" after a moment, instead of
      // claiming to still be submitting while the program works.
      clearTimer();
      timer.current = window.setInterval(() => setPhase("running"), 1_200);

      try {
        const answer = await executeCode(
          { languageId, sourceCode: code, stdin },
          controller.signal,
        );
        clearTimer();
        setResult(answer);
        if (answer.compileOutput) setOutputTab("compile");
        else if (answer.stderr) setOutputTab("stderr");
        setPhase("done");
      } catch (error) {
        clearTimer();
        const text =
          error instanceof RunnerError ? error.message : "Execution failed.";
        if (controller.signal.aborted && text === "Cancelled.") {
          setPhase("cancelled");
          return;
        }
        setFailure({ where: "api", text });
        setPhase("error");
      }
    },
    [clearTimer, languageId, stdin],
  );

  const cancel = useCallback(() => {
    abort.current?.abort();
    clearTimer();
  }, [clearTimer]);

  const reset = useCallback(() => {
    setSource(language.defaultCode);
    setResult(null);
    setFailure(null);
    setPhase("idle");
  }, [language]);

  const copyOutput = useCallback(async () => {
    const text =
      outputTab === "compile"
        ? (result?.compileOutput ?? "")
        : outputTab === "stderr"
          ? (result?.stderr ?? "")
          : (result?.stdout ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard permission is the user's to give; failing silently is fine.
    }
  }, [outputTab, result]);

  const consoleText =
    outputTab === "compile"
      ? (result?.compileOutput ?? "")
      : outputTab === "stderr"
        ? (result?.stderr ?? "")
        : (result?.stdout ?? "");

  const verdict = failure
    ? { tone: "bad" as const, label: "Failed" }
    : result
      ? result.timedOut
        ? { tone: "bad" as const, label: "Timed out" }
        : result.compileOutput
          ? { tone: "bad" as const, label: "Compilation error" }
          : result.statusId === 3
            ? { tone: "good" as const, label: "Accepted" }
            : { tone: "bad" as const, label: result.status }
      : null;

  const editorRef = useRef<EditorHandle | null>(null);

  // Compiler diagnostics and runtime errors each get their own tab when there is
  // something in them; stdout is always there, even when empty.
  const tabs: OutputTab[] = [];
  if (result?.compileOutput) tabs.push("compile");
  if (result?.stderr) tabs.push("stderr");
  tabs.push("stdout");
  const activeTab = tabs.includes(outputTab) ? outputTab : "stdout";

  const outputBody = (
    <>
      {available === false && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/50 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="text-[12px] leading-5 text-muted-foreground">
            This deployment has no execution endpoint, so Run is disabled.
            Running code needs the <code className="font-mono">/api/execute</code>{" "}
            serverless function, which a static-only host does not serve. The
            formatter, extractor and transfer tabs are unaffected.
          </p>
        </div>
      )}

      {failure && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-destructive/5 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-[12px] leading-5 text-foreground">{failure.text}</p>
            <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
              {failure.where === "run"
                ? "Nothing was submitted."
                : "Details are in the server logs; nothing from the provider is shown here."}
            </p>
          </div>
        </div>
      )}

      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setOutputTab(tab)}
              className={cn(
                "rounded-md px-2 py-1 text-[12px] transition-colors",
                activeTab === tab
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "compile" ? "Compiler" : tab === "stderr" ? "Errors" : "Output"}
            </button>
          ))}
        </div>
      )}

      {result || busy || failure ? (
        <pre className="min-h-[180px] max-h-[440px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-5 text-foreground lg:max-h-none lg:min-h-0 lg:flex-1">
          {consoleText ||
            (busy ? "Waiting for the program to finish…" : "(no output)")}
        </pre>
      ) : (
        <div className="flex h-[180px] items-center justify-center p-6 text-center lg:h-auto lg:min-h-0 lg:flex-1">
          <div>
            <Play className="mx-auto h-5 w-5 text-muted-foreground/60" />
            <p className="mt-2 text-[13px] text-muted-foreground">
              Output appears here after you run.
            </p>
          </div>
        </div>
      )}
    </>
  );

  return (
    /**
     * A column that ends at the viewport: at desktop widths the header, the
     * intro, the controls, the workspace and the status strip are laid out once
     * and the page itself never scrolls — only the panels inside it do.
     */
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground lg:h-[100dvh] lg:min-h-0 lg:overflow-hidden">
      <SiteHeader active="run" />

      <main className="flex flex-1 flex-col px-4 pb-16 pt-10 sm:px-6 lg:min-h-0 lg:overflow-y-auto lg:px-10 lg:pb-5 lg:pt-8">
        <div className="fade-in shrink-0">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Code Runner
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            Write a program, choose a language, and run it in a sandbox.
            Execution happens in a remote container — the one thing in this app
            that does leave your browser — and only the source you submit is
            sent.
          </p>
        </div>

        {/* Controls */}
        <div className="mt-8 flex shrink-0 flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-4">
          <Field label="Language">
            <select
              value={languageId}
              data-testid="select-runner-language"
              aria-label="Language"
              onChange={(event) => {
                const next = Number(event.target.value);
                const match = RUNNER_LANGUAGES.find((item) => item.id === next);
                setLanguageId(next);
                if (match) {
                  setSource(match.defaultCode);
                  setResult(null);
                  setFailure(null);
                  setPhase("idle");
                }
              }}
              className="h-9 w-[190px] rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {RUNNER_LANGUAGES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>

          <span className="hidden pb-2 font-mono text-[11px] text-muted-foreground sm:inline">
            {language.runtime} · {language.extension}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              title="Restore the sample for this language"
              className={cn(
                BUTTON_BASE,
                "h-9 border border-border px-3 hover:bg-muted",
              )}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
            {busy ? (
              <button
                type="button"
                onClick={cancel}
                data-testid="button-stop"
                className={cn(
                  BUTTON_BASE,
                  "h-9 border border-border px-3 hover:bg-muted",
                )}
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void run(source)}
                disabled={available === false}
                data-testid="button-run"
                className={cn(
                  BUTTON_BASE,
                  "h-9 bg-primary px-4 text-primary-foreground hover:bg-primary/85",
                )}
              >
                <Play className="h-4 w-4" />
                Run
              </button>
            )}
          </div>
        </div>

        {/*
          One grid holds the whole workspace: source on the left, standard input
          above output on the right. At desktop widths every panel is stretched
          by its grid cell, so the two columns end level and nothing sits in
          blank space; below `lg` the same three panels stack and the page
          scrolls as usual.
        */}
        <div className="mt-3 grid gap-3 lg:min-h-[320px] lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel
            title="Source"
            subtitle={`${language.extension} · ${source.split("\n").length} lines · ${formatBytes(new TextEncoder().encode(source).length)}`}
            actions={
              <span className="font-mono text-[11px] text-muted-foreground">
                Ctrl/Cmd + Enter
              </span>
            }
            className="min-h-0 lg:row-span-2"
          >
            <div className="h-[420px] min-h-0 sm:h-[480px] lg:h-auto lg:flex-1">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading editor
                  </div>
                }
              >
                <RunnerEditor
                  value={source}
                  language={language.monaco}
                  theme={theme}
                  onChange={setSource}
                  onReady={(handle) => {
                    editorRef.current = handle;
                  }}
                  onRun={() => void run(editorRef.current?.getValue() ?? source)}
                />
              </Suspense>
            </div>
          </Panel>

          <Panel
            title="Standard input"
            subtitle={`${stdin.split("\n").length} lines · ${formatBytes(new TextEncoder().encode(stdin).length)}`}
            className="min-h-0"
          >
            <textarea
              value={stdin}
              onChange={(event) => setStdin(event.target.value)}
              spellCheck={false}
              placeholder="What the program reads from stdin"
              data-testid="runner-stdin"
              className="h-[200px] w-full resize-none bg-transparent p-3 font-mono text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 sm:h-[220px] lg:h-auto lg:min-h-0 lg:flex-1"
            />
          </Panel>

          <Panel
            title="Output"
            subtitle={
              result
                ? [
                    result.time ? `${result.time}s` : null,
                    result.memory ? `${(result.memory / 1024).toFixed(1)} MB` : null,
                    result.exitCode !== null ? `exit ${result.exitCode}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "no timing reported"
                : "nothing run yet"
            }
            actions={
              <>
                <button
                  type="button"
                  onClick={() => void copyOutput()}
                  disabled={consoleText === ""}
                  className={cn(
                    BUTTON_BASE,
                    "h-7 border border-border px-2 hover:bg-muted",
                  )}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setFailure(null);
                    setPhase("idle");
                  }}
                  disabled={busy || (result === null && failure === null)}
                  data-testid="button-clear-output"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 border border-border px-2 hover:bg-muted",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </button>
              </>
            }
            className="min-h-0"
          >
            {outputBody}
          </Panel>
        </div>

        {/* State strip */}
        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                phase === "error" || phase === "cancelled"
                  ? "bg-destructive"
                  : busy
                    ? "bg-primary"
                    : verdict?.tone === "good"
                      ? "bg-primary"
                      : "bg-muted-foreground",
              )}
            />
            {PHASE_LABEL[phase]}
          </span>
          <span>source limit {formatBytes(MAX_SOURCE_BYTES)}</span>
          <span>stdin limit {formatBytes(MAX_STDIN_BYTES)}</span>
          {result && result.time && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {result.time}s
            </span>
          )}
          {result && result.memory && (
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" />
              {(result.memory / 1024).toFixed(1)} MB
            </span>
          )}
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            executed in an isolated sandbox
          </span>
        </div>
      </main>
    </div>
  );
}