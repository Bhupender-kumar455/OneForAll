import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  Braces,
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Download,
  FileCode2,
  Gauge,
  Github,
  Hash,
  Keyboard,
  Layers3,
  Menu,
  Moon,
  PanelLeft,
  RefreshCcw,
  ScanSearch,
  Settings2,
  Sun,
  Trash2,
  WandSparkles,
  Zap,
} from 'lucide-react';

const queryClient = new QueryClient();

type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'json'
  | 'css'
  | 'html'
  | 'sql'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust';

type Example = {
  name: string;
  language: Language;
  source: string;
};

const examples: Example[] = [
  {
    name: 'Payment progress',
    language: 'typescript',
    source: `const tabbyPaymentProgress =
  extensionProperties.find(
    prop => prop.Key === "TABBYPAYMETPROGRESS"
  );

if (tabbyPaymentProgress?.Value?.BooleanValue === true) {
  const tabbyHelper = new HelperMethod(
    this.context,
    options.cart.Id
  );

  const result = await tabbyHelper.getTabbyPaymentStatus();

  if (result === "CLOSED") {
    await MessageDialog.show(
      this.context,
      this.context.resources.getString("string_0183")
    );

    return { canceled: true };
  }

  // Previous Tabby payment is still open
  await tabbyHelper.TabbyVoidPayment();
  const tabbyProperty: ProxyEntities.CommerceProperty = {
    Key: "TABBYPAYMETPROGRESS",
    Value: {
      BooleanValue: false
    }
  };
  await this.context.runtime.executeAsync(
    new SaveExtensionPropertiesOnCartClientRequest(
      [tabbyProperty]
    )
  );
}`,
  },
  {
    name: 'User config',
    language: 'json',
    source: `{
  "name": "code-compact",
  "version": "1.0.0",
  "features": [
    "formatting",
    "copying",
    "download"
  ],
  "preferences": {
    "theme": "light",
    "compactness": 72
  }
}`,
  },
  {
    name: 'Normalize records',
    language: 'python',
    source: `def normalize_records(records):
    normalized = []
    for record in records:
        if not record.get("active"):
            continue
        normalized.append({
            "id": record["id"],
            "label": record.get("label", "").strip(),
            "tags": [tag.lower() for tag in record.get("tags", [])],
        })
    return normalized`,
  },
];

const languageLabels: Record<Language, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  sql: 'SQL',
  java: 'Java',
  csharp: 'C#',
  go: 'Go',
  rust: 'Rust',
};

const languageExtensions: Record<Language, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  json: 'json',
  css: 'css',
  html: 'html',
  sql: 'sql',
  java: 'java',
  csharp: 'cs',
  go: 'go',
  rust: 'rs',
};

function detectLanguage(source: string): Language {
  const trimmed = source.trim();
  if (!trimmed) return 'typescript';
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // An object-shaped program is not necessarily JSON.
    }
  }
  if (/^\s*(def |from |import |class .*\:|print\()/m.test(trimmed)) return 'python';
  if (/^\s*(selector|@media|body|:root)\s*\{/m.test(trimmed)) return 'css';
  if (/^\s*(<!doctype html|<html|<head|<body|<div)\b/i.test(trimmed)) return 'html';
  if (/\b(select|insert\s+into|update|delete\s+from|create\s+table)\b/i.test(trimmed)) return 'sql';
  if (/\b(public|private|protected)\s+(static\s+)?(class|interface)\b/.test(trimmed)) return 'java';
  if (/\b(using\s+System|namespace\s+\w+|Console\.WriteLine)\b/.test(trimmed)) return 'csharp';
  if (/^\s*(package\s+\w+|func\s+\w+\s*\()/m.test(trimmed)) return 'go';
  if (/^\s*(fn\s+\w+|use\s+\w+::|let\s+mut\s+)/m.test(trimmed)) return 'rust';
  if (/\b(interface|type|Promise<|Record<|: string|: number)\b/.test(trimmed)) return 'typescript';
  return 'javascript';
}

function isControlBlock(line: string): boolean {
  return /^(if|else|for|while|switch|catch|try|finally|do|function|class|interface|enum)\b/.test(line)
    || /^(export\s+)?(async\s+)?function\b/.test(line)
    || /^(public|private|protected)\s+(static\s+)?(class|interface|void|[\w<>\[\]]+)\b/.test(line);
}

function delimiterDelta(value: string): { paren: number; brace: number; bracket: number } {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '(') {
      paren += 1;
    } else if (character === ')') {
      paren -= 1;
    } else if (character === '{') {
      brace += 1;
    } else if (character === '}') {
      brace -= 1;
    } else if (character === '[') {
      bracket += 1;
    } else if (character === ']') {
      bracket -= 1;
    }
  }

  return { paren, brace, bracket };
}

function normalizeExpression(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;)\]}])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\[\s+/g, '[')
    .replace(/\{\s+/g, '{ ')
    .replace(/\s+([.?])/g, '$1')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s*=\s*>\s*/g, ' => ')
    .trim();
}

function compactStatements(source: string): string {
  const lines = source.split('\n');
  const compacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    if (!current || current.startsWith('//') || current.startsWith('/*') || current.startsWith('*')) {
      compacted.push(lines[index].replace(/[ \t]+$/g, ''));
      continue;
    }

    const startsExpression = /(?:=\s*$|=\s*{|return\s*{|new\s+\w+\s*\(|\w+\s*\(|\bawait\b.*\()/.test(current);
    if (!startsExpression || isControlBlock(current)) {
      compacted.push(lines[index].replace(/[ \t]+$/g, ''));
      continue;
    }

    const opening = delimiterDelta(current);
    let end = index;
    let balance = opening;
    if (balance.paren === 0 && balance.brace === 0 && balance.bracket === 0 && /[=,(]\s*$/.test(current) && end < lines.length - 1) {
      end += 1;
      const nextLine = lines[end].trim();
      const next = delimiterDelta(nextLine);
      balance = {
        paren: balance.paren + next.paren,
        brace: balance.brace + next.brace,
        bracket: balance.bracket + next.bracket,
      };
    }
    if (end === index && balance.paren === 0 && balance.brace === 0 && balance.bracket === 0) {
      compacted.push(lines[index].replace(/[ \t]+$/g, ''));
      continue;
    }
    while (end < lines.length - 1 && (balance.paren > 0 || balance.brace > 0 || balance.bracket > 0)) {
      end += 1;
      const nextLine = lines[end].trim();
      if (nextLine.startsWith('//') || nextLine.startsWith('/*') || nextLine.startsWith('*')) break;
      const next = delimiterDelta(nextLine);
      balance = {
        paren: balance.paren + next.paren,
        brace: balance.brace + next.brace,
        bracket: balance.bracket + next.bracket,
      };
    }

    if (end > index && balance.paren === 0 && balance.brace === 0 && balance.bracket === 0) {
      const joined = normalizeExpression(lines.slice(index, end + 1).map((line) => line.trim()).join(' '));
      const isObject = current.includes('=') && current.includes('{');
      const isInlineCallback = /(?:=>\s*\{|async\s*\([^)]*\)\s*=>)/.test(joined);
      const maxLength = isObject ? 300 : 220;
      if (isInlineCallback || joined.length <= maxLength) {
        compacted.push(joined);
        index = end;
        continue;
      }
    }

    compacted.push(lines[index].replace(/[ \t]+$/g, ''));
  }

  return compacted
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatCode(source: string, language: Language, compactness: number): string {
  if (!source.trim()) return '';
  const normalized = source.replace(/\r\n/g, '\n').trim();
  if (language === 'json') {
    try {
      const parsed = JSON.parse(normalized);
      return JSON.stringify(parsed, null, compactness > 74 ? 2 : 4);
    } catch {
      return normalized.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
    }
  }
  let formatted = normalized.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (['javascript', 'typescript', 'java', 'csharp', 'go', 'rust'].includes(language)) {
    formatted = compactStatements(formatted);
  }
  if (language === 'css') {
    formatted = formatted
      .replace(/\s*\{\s*/g, ' {\n  ')
      .replace(/;\s*/g, ';\n  ')
      .replace(/\s*\}\s*/g, '\n}\n')
      .replace(/\n  \n}/g, '\n}');
  }
  if (language === 'python') {
    formatted = formatted.replace(/\s*:\s*$/gm, ':').replace(/,\s*/g, ', ');
  }
  if (language === 'html') {
    formatted = formatted
      .replace(/>\s+</g, '>\n<')
      .replace(/\n{3,}/g, '\n\n');
  }
  if (language === 'sql') {
    formatted = formatted
      .replace(/\s+/g, ' ')
      .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT)\s+/gi, '\n$1 ')
      .trim();
  }
  if (compactness >= 72) {
    formatted = formatted.replace(/\n[ \t]*\n[ \t]*/g, '\n');
  }
  return formatted.trim();
}

function countTokens(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function IconButton({
  label,
  onClick,
  children,
  active = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={`button-${label.toLowerCase().replaceAll(' ', '-')}`}
      onClick={onClick}
      className={`grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
        active
          ? 'border-[hsl(var(--sidebar-primary)/.35)] bg-[hsl(var(--sidebar-primary)/.14)] text-[hsl(var(--sidebar-primary))]'
          : 'border-transparent text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]'
      }`}
    >
      {children}
    </button>
  );
}

function BrandMark() {
  return (
    <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-[hsl(var(--sidebar-primary))] text-[hsl(var(--sidebar-primary-foreground))] shadow-sm">
      <span className="absolute h-4 w-4 rounded-[5px] border-2 border-current opacity-90" />
      <span className="absolute h-1.5 w-1.5 rounded-sm bg-current" />
    </div>
  );
}

function CodePanel({
  title,
  subtitle,
  value,
  editable,
  onChange,
  lineCount,
  action,
  empty,
}: {
  title: string;
  subtitle: string;
  value: string;
  editable?: boolean;
  onChange?: (value: string) => void;
  lineCount: number;
  action?: React.ReactNode;
  empty?: boolean;
}) {
  const lines = Math.max(lineCount, 1);
  return (
    <section className="flex min-h-[390px] flex-1 flex-col overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.78)] shadow-[var(--shadow-sm)]">
      <div className="flex min-h-14 items-center justify-between border-b border-[hsl(var(--border))] px-4">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
            {editable ? <FileCode2 size={15} /> : <Braces size={15} />}
          </span>
          <div>
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-[hsl(var(--foreground))]">{title}</h2>
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[hsl(var(--muted-foreground))]">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
      {empty && !editable ? (
        <div className="grid flex-1 place-items-center p-8 text-center">
          <div>
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/.55)] text-[hsl(var(--muted-foreground))]">
              <ScanSearch size={20} strokeWidth={1.5} />
            </div>
            <p className="text-sm font-medium text-[hsl(var(--foreground))]">Your compact output will land here</p>
            <p className="mt-1 max-w-[250px] text-xs leading-5 text-[hsl(var(--muted-foreground))]">Paste code on the left or load an example to start the formatter.</p>
          </div>
        </div>
      ) : (
        <div className="code-scroll flex min-h-0 flex-1 overflow-auto bg-[hsl(var(--background)/.38)]">
          <div className="select-none border-r border-[hsl(var(--border)/.75)] px-3 py-4 text-right font-mono text-[11px] leading-6 text-[hsl(var(--muted-foreground)/.62)]">
            {Array.from({ length: lines }, (_, index) => <div key={index}>{String(index + 1).padStart(2, '0')}</div>)}
          </div>
          {editable ? (
            <textarea
              value={value}
              onChange={(event) => onChange?.(event.target.value)}
              spellCheck={false}
              data-testid="input-source-code"
              aria-label="Source code"
              className="min-h-[350px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[12px] leading-6 text-[hsl(var(--foreground))] outline-none placeholder:text-[hsl(var(--muted-foreground)/.7)]"
              placeholder="Paste your source code here..."
            />
          ) : (
            <pre data-testid="text-formatted-output" className="m-0 min-w-0 whitespace-pre px-4 py-4 font-mono text-[12px] leading-6 text-[hsl(var(--foreground))]">
              {value}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

function Home() {
  const [source, setSource] = useState(examples[0].source);
  const [language, setLanguage] = useState<Language>(examples[0].language);
  const [compactness, setCompactness] = useState(72);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [dark, setDark] = useState(false);
  const output = useMemo(() => formatCode(source, language, compactness), [source, language, compactness]);
  const beforeTokens = countTokens(source);
  const afterTokens = countTokens(output);
  const savedPercent = beforeTokens > 0 ? Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100)) : 0;
  const sourceLines = source ? source.split('\n').length : 1;
  const outputLines = output ? output.split('\n').length : 1;

  const loadExample = () => {
    const next = (exampleIndex + 1) % examples.length;
    setExampleIndex(next);
    setSource(examples[next].source);
    setLanguage(examples[next].language);
  };

  const handleCopy = async () => {
    if (!output) return;
    await navigator.clipboard?.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = () => {
    if (!output) return;
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `compact.${languageExtensions[language]}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    window.setTimeout(() => setDownloaded(false), 1800);
  };

  const toggleTheme = () => {
    setDark((current) => {
      const next = !current;
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  };

  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[68px] flex-col items-center border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar))] py-5 md:flex">
        <BrandMark />
        <div className="mt-14 flex flex-1 flex-col items-center gap-3">
          <IconButton label="Workspace" active onClick={() => undefined}><Code2 size={18} /></IconButton>
          <IconButton label="Saved snippets" onClick={() => undefined}><Layers3 size={18} /></IconButton>
          <IconButton label="Preferences" onClick={() => undefined}><Settings2 size={18} /></IconButton>
        </div>
        <IconButton label={dark ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}><span className="text-[hsl(var(--sidebar-foreground))]">{dark ? <Sun size={17} /> : <Moon size={17} />}</span></IconButton>
      </aside>

      <main className="min-h-[100dvh] md:pl-[68px]">
        <header className="flex h-[72px] items-center justify-between border-b border-[hsl(var(--border))] px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] md:hidden" aria-label="Open menu" data-testid="button-open-menu"><Menu size={18} /></button>
            <div className="md:hidden"><BrandMark /></div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--muted-foreground))]">Code</span>
                <span className="text-[hsl(var(--accent))]">/</span>
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--foreground))]">Compact</span>
              </div>
              <p className="mt-0.5 hidden text-xs text-[hsl(var(--muted-foreground))] sm:block">A quieter way to read generated code.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-[hsl(var(--border))] px-3 py-1.5 font-mono text-[10px] text-[hsl(var(--muted-foreground))] lg:flex">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" /> LOCAL · NO UPLOADS
            </span>
            <button type="button" onClick={loadExample} data-testid="button-swap-example" className="flex h-9 items-center gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 text-xs font-semibold text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]">
              <RefreshCcw size={14} /> <span className="hidden sm:inline">Swap example</span>
            </button>
            <button type="button" onClick={toggleTheme} data-testid="button-toggle-theme" aria-label="Toggle theme" className="grid h-9 w-9 place-items-center rounded-lg border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] md:hidden">
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </header>

        <div className="mx-auto max-w-[1500px] px-5 py-7 sm:px-8 lg:px-10">
          <div className="fade-up mb-7 flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.08)] px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--accent-foreground))]">
                <WandSparkles size={12} /> formatter workspace
              </div>
              <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.05em] text-[hsl(var(--foreground))] sm:text-4xl">Make verbose code <span className="text-[hsl(var(--primary))]">quiet.</span></h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[hsl(var(--muted-foreground))]">Paste the output you got. Keep the meaning, lose the noise. Your source stays in this tab.</p>
            </div>
            <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:min-w-[330px]">
              <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card)/.6)] px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">before</p>
                <p data-testid="text-before-tokens" className="mt-1 font-mono text-lg font-semibold">{beforeTokens}<span className="ml-1 text-[11px] font-normal text-[hsl(var(--muted-foreground))]">tok</span></p>
              </div>
              <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card)/.6)] px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">after</p>
                <p data-testid="text-after-tokens" className="mt-1 font-mono text-lg font-semibold">{afterTokens}<span className="ml-1 text-[11px] font-normal text-[hsl(var(--muted-foreground))]">tok</span></p>
              </div>
              <div className="rounded-lg border border-[hsl(var(--primary)/.3)] bg-[hsl(var(--primary)/.08)] px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-[hsl(var(--primary))]">saved</p>
                <p data-testid="text-saved-percent" className="mt-1 font-mono text-lg font-semibold text-[hsl(var(--primary))]">{savedPercent}<span className="ml-1 text-[11px] font-normal">%</span></p>
              </div>
            </div>
          </div>

          <div className="fade-up-delay grid-paper rounded-2xl border border-[hsl(var(--border))] p-2 sm:p-3">
            <div className="flex flex-col gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background)/.82)] p-2 sm:flex-row sm:items-center sm:justify-between sm:px-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">language</span>
                  <div className="relative">
                    <select value={language} onChange={(event) => setLanguage(event.target.value as Language)} data-testid="select-language" className="h-8 appearance-none rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] py-0 pl-2.5 pr-7 text-xs font-semibold text-[hsl(var(--foreground))] outline-none focus:ring-2 focus:ring-[hsl(var(--ring)/.25)]">
                      {(Object.keys(languageLabels) as Language[]).map((item) => <option key={item} value={item}>{languageLabels[item]}</option>)}
                    </select>
                    <ChevronDown size={13} className="pointer-events-none absolute right-2 top-2 text-[hsl(var(--muted-foreground))]" />
                  </div>
                </div>
                <button type="button" onClick={() => setLanguage(detectLanguage(source))} data-testid="button-detect-language" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]">
                  <ScanSearch size={13} /> Detect
                </button>
              </div>
              <div className="flex items-center gap-3 sm:min-w-[265px]">
                <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">compactness</span>
                <input type="range" min="0" max="100" value={compactness} onChange={(event) => setCompactness(Number(event.target.value))} data-testid="input-compactness" aria-label="Compactness" className="h-1 w-full cursor-pointer accent-[hsl(var(--primary))]" />
                <span data-testid="text-compactness-value" className="w-8 text-right font-mono text-[11px] font-semibold text-[hsl(var(--primary))]">{compactness}</span>
              </div>
            </div>

            <div className="mt-2 flex flex-col gap-2 lg:flex-row">
              <CodePanel title="Source" subtitle={`${languageLabels[language]} · editable`} value={source} editable onChange={setSource} lineCount={sourceLines} empty={!source} action={
                <button type="button" onClick={() => setSource('')} data-testid="button-clear-source" aria-label="Clear source" title="Clear source" className="grid h-7 w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--destructive))]"><Trash2 size={14} /></button>
              } />
              <div className="hidden items-center justify-center px-1 lg:flex"><div className="grid h-8 w-8 place-items-center rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--primary))]"><Zap size={14} /></div></div>
              <CodePanel title="Compact output" subtitle={`${outputLines} lines · ready to use`} value={output} lineCount={outputLines} empty={!output} action={
                <div className="flex items-center gap-1">
                  <button type="button" onClick={handleCopy} disabled={!output} data-testid="button-copy-output" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)/.1)] disabled:cursor-not-allowed disabled:opacity-40">{copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? 'Copied' : 'Copy'}</button>
                  <button type="button" onClick={handleDownload} disabled={!output} data-testid="button-download-output" aria-label="Download output" title="Download output" className="grid h-7 w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] disabled:cursor-not-allowed disabled:opacity-40">{downloaded ? <Check size={14} className="text-[hsl(var(--primary))]" /> : <Download size={14} />}</button>
                </div>
              } />
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[1.3fr_.7fr]">
            <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.66)] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--muted-foreground))]">What changed</p>
                  <p data-testid="text-improvement-summary" className="mt-1 text-sm font-medium">{source ? `A cleaner read with ${savedPercent}% fewer tokens to scan.` : 'Add a snippet to see the difference.'}</p>
                </div>
                <Gauge size={22} className="text-[hsl(var(--primary))]" />
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                <div className="h-full rounded-full bg-[hsl(var(--primary))] transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(4, savedPercent))}%` }} />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-[hsl(var(--muted-foreground))]"><span>{beforeTokens} source tokens</span><span>{afterTokens} compact tokens</span></div>
            </section>
            <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.66)] p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[hsl(var(--accent)/.13)] text-[hsl(var(--accent-foreground))]"><Keyboard size={15} /></div>
                <div>
                  <p className="text-xs font-semibold">Small controls, less friction</p>
                  <p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">Tune compactness, swap examples, or paste something new. Nothing leaves your browser.</p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-[hsl(var(--border))] pt-3 font-mono text-[10px] text-[hsl(var(--muted-foreground))]"><Hash size={12} /> {examples[exampleIndex].name} <span className="ml-auto">{languageLabels[language]}</span></div>
            </section>
          </div>

          <footer className="mt-8 flex flex-col items-start justify-between gap-3 border-t border-[hsl(var(--border))] py-5 text-[11px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center">
            <p className="flex items-center gap-2"><span className="font-mono font-semibold text-[hsl(var(--foreground))]">CC</span> Code Compact · local-first formatting</p>
            <div className="flex items-center gap-4"><span className="flex items-center gap-1.5"><PanelLeft size={13} /> dense by design</span><span className="flex items-center gap-1.5"><Github size={13} /> open workspace</span></div>
          </footer>
        </div>
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
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;