import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileCode2,
  Loader2,
  Lock,
  Minimize2,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import NotFound from "@/pages/not-found";
import { Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import { cn } from "@/lib/utils";
import {
  LANGUAGES,
  LANGUAGE_ORDER,
  countStats,
  detectLanguage,
  formatBytes,
  type LanguageId,
  type Mode,
} from "@/lib/formatter";
import { FormatterClient, MAX_FORMAT_BYTES } from "@/lib/format-client";
import { diffLines } from "@/lib/diff";

type Example = { name: string; language: LanguageId; source: string };

const examples: Example[] = [
  {
    name: "JavaScript",
    language: "javascript",
    source: `const users=[{id:1,name:"Ada",role:"admin"},{id:2,name:"Linus",role:"dev"}];
function summarize(list){let total=0;for(const user of list){if(!user)continue;total+=1;}return{count:total,names:list.map(user=>user.name)};}
const config={retries:3,timeout:5000,endpoints:{users:"/api/users",health:"/api/health"}};
export default summarize;`,
  },
  {
    name: "JSON",
    language: "json",
    source: `{"name":"code-compact","version":"1.0.0","private":true,"features":["format","minify","copy","download"],"config":{"indent":2,"printWidth":80,"local":true}}`,
  },
  {
    name: "TypeScript",
    language: "typescript",
    source: `interface User{id:number;name:string;roles:string[]}
export async function loadUsers(ids:number[]):Promise<User[]>{const results=await Promise.all(ids.map(async id=>{const res=await fetch(\`/api/users/\${id}\`);if(!res.ok)throw new Error("failed: "+id);return res.json() as Promise<User>;}));return results;}`,
  },
  {
    name: "CSS",
    language: "css",
    source: `:root{--bg:#fff;--fg:#000;--border:#eaeaea}
.card{padding:16px;border:1px solid var(--border);border-radius:8px}
.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.06)}@media (max-width:640px){.card{padding:12px}}`,
  },
  {
    name: "SQL",
    language: "sql",
    source: `select u.id,u.name,count(o.id) as orders from users u left join orders o on o.user_id=u.id where u.active=true group by u.id,u.name order by orders desc limit 10;`,
  },
  {
    name: "C",
    language: "c",
    source: `#include <stdio.h>
int main(){int sum=0;for(int i=0;i<10;i++){if(i%2==0){sum+=i;}}printf("%d\\n",sum);return 0;}`,
  },
];

const EXTENSION_TO_LANGUAGE: Record<string, LanguageId> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  graphql: "graphql",
  gql: "graphql",
  sql: "sql",
  py: "python",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  cs: "csharp",
  m: "objectivec",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  go: "go",
  rs: "rust",
  proto: "protobuf",
  xml: "xml",
  svg: "xml",
  toml: "toml",
};

const INDENT_OPTIONS = [
  { value: "2", label: "2 spaces" },
  { value: "4", label: "4 spaces" },
  { value: "8", label: "8 spaces" },
  { value: "tab", label: "Tab" },
];

// `No wrap` maps to a width Prettier will never reach, so statements stay on
// one line instead of being reflowed at the column limit.
const NO_WRAP_WIDTH = 1000;

const PRINT_WIDTH_OPTIONS = [
  { value: "80", label: "80 cols" },
  { value: "100", label: "100 cols" },
  { value: "120", label: "120 cols" },
  { value: "nowrap", label: "No wrap" },
];

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none";

function VercelMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 76 65" className={className} aria-hidden="true">
      <path d="M37.59.25l36.95 64H.64l36.95-64z" fill="currentColor" />
    </svg>
  );
}

function Panel({
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

function SelectBox({
  value,
  onChange,
  children,
  testId,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  testId?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full cursor-pointer appearance-none rounded-md border border-border bg-background py-0 pl-2.5 pr-7 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-foreground/40"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function Home() {
  const [source, setSource] = useState(examples[0].source);
  const [language, setLanguage] = useState<LanguageId>(examples[0].language);
  const [mode, setMode] = useState<Mode>("format");
  const [indent, setIndent] = useState("2");
  const [printWidth, setPrintWidth] = useState(120);
  const [exampleIndex, setExampleIndex] = useState(0);

  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [oversizeBytes, setOversizeBytes] = useState<number | null>(null);
  const [allowOversize, setAllowOversize] = useState(false);
  const [ranVia, setRanVia] = useState<"worker" | "main">("worker");

  const [client] = useState(() => new FormatterClient());

  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("cc-theme");
    if (stored) return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const info = LANGUAGES[language];
  const useTabs = indent === "tab";
  const indentWidth = useTabs ? 2 : Number(indent);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("cc-theme", dark ? "dark" : "light");
  }, [dark]);

  // Formatting runs in a worker, so the editor keeps responding while a large
  // document is rewritten. A new request supersedes the one in flight.
  useEffect(() => {
    const id = (requestId.current += 1);

    if (!source.trim()) {
      client.cancel();
      setOutput("");
      setError(null);
      setOversizeBytes(null);
      setBusy(false);
      return;
    }

    setBusy(true);
    const timer = window.setTimeout(() => {
      client
        .run(
          source,
          { language, mode, indentWidth, useTabs, printWidth },
          allowOversize,
        )
        .then((outcome) => {
          if (id !== requestId.current) return;
          setRanVia(outcome.via);

          // A newer run took over; it owns the busy state from here.
          if (outcome.status === "cancelled") return;

          setBusy(false);

          if (outcome.status === "too-large") {
            setOutput("");
            setError(null);
            setOversizeBytes(outcome.bytes);
            return;
          }

          setOversizeBytes(null);

          if (outcome.status === "error") {
            setOutput("");
            setError(outcome.error);
            return;
          }

          setOutput(outcome.output);
          setError(null);
        });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [
    client,
    source,
    language,
    mode,
    indentWidth,
    useTabs,
    printWidth,
    nonce,
    allowOversize,
  ]);

  useEffect(() => () => client.dispose(), [client]);

  const inputStats = useMemo(() => countStats(source), [source]);
  const outputStats = useMemo(() => countStats(output), [output]);
  const diff = useMemo(
    () => (output ? diffLines(source, output) : null),
    [source, output],
  );
  const byteDelta = outputStats.bytes - inputStats.bytes;

  const loadExample = useCallback(() => {
    const next = (exampleIndex + 1) % examples.length;
    setExampleIndex(next);
    setAllowOversize(false);
    setSource(examples[next].source);
    setLanguage(examples[next].language);
  }, [exampleIndex]);

  const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        setAllowOversize(false);
        setSource(text);
        const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
        const detected = EXTENSION_TO_LANGUAGE[extension];
        if (detected) setLanguage(detected);
      })
      .catch(() => undefined);
    event.target.value = "";
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleDownload = () => {
    if (!output) return;
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${mode === "minify" ? "minified" : "formatted"}.${info.extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    window.setTimeout(() => setDownloaded(false), 1600);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        setNonce((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
          <div className="flex items-center gap-3">
            {/* <VercelMark className="h-3.5 w-[15px] text-foreground" /> */}
            {/* <div className="h-4 w-px bg-border" /> */}
            <span className="text-sm font-semibold tracking-tight">
              TheBestFormatter
            </span>
            <nav className="ml-3 hidden items-center gap-1 md:flex">
              {/* <span className="rounded-md bg-muted px-2 py-1 text-[13px] font-medium">
                Code
              </span> */}
              <a
                className="rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                href="#languages"
              >
                Languages
              </a>
              <a
                className="rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                href="#about"
              >
                About
              </a>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground sm:flex">
              <Lock className="h-3 w-3" /> Runs in your browser
            </span>
            <button
              type="button"
              onClick={() => setDark((value) => !value)}
              aria-label="Toggle theme"
              data-testid="button-toggle-theme"
              className={cn(
                BUTTON_BASE,
                "h-9 w-9 border border-border hover:bg-muted",
              )}
            >
              {dark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 pb-16 pt-10 sm:px-6 lg:px-10">
        <div className="fade-in">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Code Formatter &amp; Beautifier
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            Paste code on the left, pick a language, and get clean, consistently
            formatted output on the right. Everything runs locally — nothing is
            uploaded.
          </p>
        </div>

        {/* Controls */}
        <div className="mt-8 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-4">
          <Field label="Language">
            <SelectBox
              value={language}
              testId="select-language"
              ariaLabel="Language"
              className="w-[170px]"
              onChange={(value) => setLanguage(value as LanguageId)}
            >
              {LANGUAGE_ORDER.map((id) => (
                <option key={id} value={id}>
                  {LANGUAGES[id].label}
                </option>
              ))}
            </SelectBox>
          </Field>

          <Field label="Indent">
            <SelectBox
              value={indent}
              ariaLabel="Indent width"
              className="w-[130px]"
              onChange={setIndent}
            >
              {INDENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectBox>
          </Field>

          <Field label="Print width">
            <SelectBox
              value={
                printWidth >= NO_WRAP_WIDTH ? "nowrap" : String(printWidth)
              }
              ariaLabel="Print width"
              className="w-[120px]"
              onChange={(value) =>
                setPrintWidth(
                  value === "nowrap" ? NO_WRAP_WIDTH : Number(value),
                )
              }
            >
              {PRINT_WIDTH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectBox>
          </Field>

          <Field label="Mode">
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              {(["format", "minify"] as Mode[]).map((option) => {
                const disabled = option === "minify" && !info.canMinify;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    data-testid={`mode-${option}`}
                    title={
                      disabled
                        ? `Minify is not available for ${info.label}`
                        : undefined
                    }
                    onClick={() => setMode(option)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[13px] font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      mode === option
                        ? "bg-background text-foreground shadow-[var(--shadow-sm)]"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option === "minify" ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                    {option}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLanguage(detectLanguage(source))}
              className={cn(
                BUTTON_BASE,
                "h-9 border border-border px-3 hover:bg-muted",
              )}
            >
              Auto-detect
            </button>
            <button
              type="button"
              onClick={() => setNonce((value) => value + 1)}
              data-testid="button-format"
              className={cn(
                BUTTON_BASE,
                "h-9 bg-primary px-4 text-primary-foreground hover:bg-primary/85",
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <WandSparkles className="h-4 w-4" />
              )}
              {mode === "minify" ? "Minify" : "Format"}
            </button>
          </div>
        </div>

        {/* Editors */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Panel
            title="Input"
            subtitle={`${inputStats.lines} lines · ${formatBytes(inputStats.bytes)}`}
            actions={
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleUpload}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    BUTTON_BASE,
                    "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Upload className="h-3.5 w-3.5" /> Load
                </button>
                <button
                  type="button"
                  onClick={loadExample}
                  data-testid="button-swap-example"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Sample
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAllowOversize(false);
                    setSource("");
                  }}
                  disabled={!source}
                  data-testid="button-clear-source"
                  aria-label="Clear input"
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
              value={source}
              onChange={(event) => {
                setAllowOversize(false);
                setSource(event.target.value);
              }}
              spellCheck={false}
              wrap="off"
              aria-label="Source code"
              data-testid="input-source-code"
              placeholder="Paste your code here…"
              className="editor-scroll h-[52vh] min-h-[340px] w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </Panel>

          <Panel
            title="Output"
            subtitle={`${LANGUAGES[language].label} · ${outputStats.lines} lines · ${formatBytes(outputStats.bytes)}`}
            actions={
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!output}
                  data-testid="button-copy-output"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 px-2 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!output}
                  aria-label="Download output"
                  className={cn(
                    BUTTON_BASE,
                    "h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {downloaded ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                </button>
              </>
            }
          >
            <div className="editor-scroll relative h-[52vh] min-h-[340px] overflow-auto">
              {oversizeBytes !== null ? (
                <div className="flex h-full items-start gap-3 p-4">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      {formatBytes(oversizeBytes)} of input — over the{" "}
                      {formatBytes(MAX_FORMAT_BYTES)} auto-format limit
                    </p>
                    <p className="mt-1 max-w-md text-[13px] leading-6 text-muted-foreground">
                      Rewriting a document this large can take a while, so it is
                      skipped unless you ask for it. Formatting still runs in
                      the background.
                    </p>
                    <button
                      type="button"
                      onClick={() => setAllowOversize(true)}
                      data-testid="button-format-anyway"
                      className={cn(
                        BUTTON_BASE,
                        "mt-3 h-8 border border-border px-3 hover:bg-muted",
                      )}
                    >
                      <WandSparkles className="h-3.5 w-3.5" /> Format anyway
                    </button>
                  </div>
                </div>
              ) : error ? (
                <div className="flex h-full items-start gap-3 p-4">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      Couldn&apos;t format this {LANGUAGES[language].label}
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-xs leading-5 text-muted-foreground">
                      {error}
                    </pre>
                  </div>
                </div>
              ) : output ? (
                <pre
                  data-testid="text-formatted-output"
                  className="min-h-full whitespace-pre p-4 font-mono text-[13px] leading-6 text-foreground"
                >
                  {output}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <div>
                    <FileCode2 className="mx-auto h-5 w-5 text-muted-foreground/60" />
                    <p className="mt-2 text-[13px] text-muted-foreground">
                      {source.trim()
                        ? "Nothing to show"
                        : "Formatted output appears here"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* Side-by-side diff */}
        <div className="mt-3">
          <Panel
            title="Diff"
            subtitle={
              diff && !diff.identical
                ? `${diff.added + diff.changed} lines added · ${diff.removed + diff.changed} removed`
                : `${info.label} · input against output`
            }
            actions={
              diff && !diff.identical ? (
                <span className="mr-0.5 flex items-center gap-2 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] font-medium">
                  <span className="text-chart-5">
                    +{diff.added + diff.changed}
                  </span>
                  <span className="text-destructive">
                    −{diff.removed + diff.changed}
                  </span>
                </span>
              ) : undefined
            }
          >
            {!diff ? (
              <div className="flex h-[110px] items-center justify-center p-6 text-center">
                <div>
                  <FileCode2 className="mx-auto h-5 w-5 text-muted-foreground/60" />
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    A line-by-line comparison appears here
                  </p>
                </div>
              </div>
            ) : diff.identical ? (
              <div className="flex h-[110px] items-center justify-center p-6 text-center">
                <div>
                  <Check className="mx-auto h-5 w-5 text-muted-foreground/60" />
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    No changes — the input is already{" "}
                    {mode === "minify" ? "minified" : "formatted"}
                  </p>
                </div>
              </div>
            ) : (
              <div
                data-testid="diff-view"
                className="editor-scroll max-h-[60vh] overflow-y-auto"
              >
                {diff.rows.map((row, index) => (
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
                        (row.kind === "added" || row.kind === "changed") &&
                          "diff-added",
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
            )}
            {diff?.approximate && (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                Too large to align line by line — shown as one replaced block.
              </p>
            )}
          </Panel>
        </div>

        {/* Status strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span>{mode === "minify" ? "minified" : "formatted"}</span>
          <span>{info.label}</span>
          <span>{useTabs ? "tab indent" : `${indentWidth}-space indent`}</span>
          <span>
            {printWidth >= NO_WRAP_WIDTH
              ? "no wrap"
              : `print width ${printWidth}`}
          </span>
          {diff && (
            <span className="text-foreground">
              {diff.identical
                ? `no changes — input was already ${mode === "minify" ? "minified" : "formatted"}`
                : `+${diff.added + diff.changed} / −${diff.removed + diff.changed} lines`}
            </span>
          )}
          {output && (
            <span>
              {ranVia === "worker"
                ? "off the main thread"
                : "main thread (worker unavailable)"}
            </span>
          )}
          {diff && !diff.identical && byteDelta !== 0 && (
            <span>
              {byteDelta < 0
                ? `${formatBytes(-byteDelta)} smaller`
                : `${formatBytes(byteDelta)} larger`}
            </span>
          )}
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            <kbd className="rounded border border-border px-1.5 py-0.5">⌘</kbd>
            <kbd className="rounded border border-border px-1.5 py-0.5">
              ↵
            </kbd>{" "}
            to run
          </span>
        </div>

        <section id="languages" className="mt-14">
          <h2 className="text-lg font-semibold tracking-tight">
            Supported languages
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Prettier, real WebAssembly formatters (clang-format, gofmt, Ruff),
            sql-formatter and terser — all running locally, off the main thread.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {LANGUAGE_ORDER.map((id) => {
              const item = LANGUAGES[id];
              const active = id === language;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setLanguage(id)}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                    active
                      ? "border-foreground/30 bg-muted font-medium"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <span>{item.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    .{item.extension}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section
          id="about"
          className="mt-12 border-t border-border pt-6 text-[13px] leading-6 text-muted-foreground"
        >
          <p className="max-w-3xl">
            A formatter rewrites indentation, spacing, and line breaks according
            to a consistent rule set — it does not compile, run, or fix your
            code, so always review the output before using it.
          </p>
          <p className="mt-4 flex items-center gap-2 font-mono text-[11px]">
            <VercelMark className="h-2.5 w-[11px]" /> Code Formatter ·
            local-first
          </p>
        </section>
      </main>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}

export default App;
