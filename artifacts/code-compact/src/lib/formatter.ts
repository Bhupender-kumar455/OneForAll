import type { Options as PrettierOptions } from 'prettier';
import type { Config as RuffFormatConfig } from '@wasm-fmt/ruff_fmt/vite';

export type LanguageId =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'vue'
  | 'angular'
  | 'markdown'
  | 'yaml'
  | 'graphql'
  | 'sql'
  | 'python'
  | 'c'
  | 'cpp'
  | 'java'
  | 'csharp'
  | 'objectivec'
  | 'swift'
  | 'kotlin'
  | 'php'
  | 'go'
  | 'rust'
  | 'protobuf'
  | 'xml'
  | 'toml';

export type Mode = 'format' | 'minify';

export interface FormatOptions {
  language: LanguageId;
  mode: Mode;
  /** Spaces per indent level (ignored when `useTabs` is true). */
  indentWidth: number;
  useTabs: boolean;
  /** Preferred maximum line length. */
  printWidth: number;
}

type PrettierPluginName =
  | 'babel'
  | 'estree'
  | 'typescript'
  | 'postcss'
  | 'html'
  | 'angular'
  | 'markdown'
  | 'yaml'
  | 'graphql';

type Engine = 'prettier' | 'sql' | 'xml' | 'toml' | 'structural' | 'wasm' | 'plain';

/** Real formatters compiled to WebAssembly, one package per engine. */
type WasmFormatterId = 'clang-format' | 'gofmt' | 'ruff_fmt';

interface WasmFormatterRef {
  formatter: WasmFormatterId;
  /** Selects the dialect for clang-format (C vs C++ vs Java vs Protobuf ...). */
  filename: string;
}

export interface LanguageInfo {
  id: LanguageId;
  label: string;
  extension: string;
  /** Grouping used by the language menu. */
  family: 'Web' | 'Data' | 'Scripting' | 'Systems' | 'Markup' | 'Query';
  engine: Engine;
  /** Prettier parser + plugins, when `engine` is `'prettier'`. */
  prettier?: { parser: string; plugins: PrettierPluginName[] };
  /** WASM formatter package + dialect, when `engine` is `'wasm'`. */
  wasm?: WasmFormatterRef;
  /** Whether the Minify action is supported for this language. */
  canMinify: boolean;
}

const prettierLanguages = {
  javascript: { parser: 'babel', plugins: ['babel', 'estree'] as PrettierPluginName[] },
  jsx: { parser: 'babel', plugins: ['babel', 'estree'] as PrettierPluginName[] },
  typescript: { parser: 'typescript', plugins: ['typescript', 'estree'] as PrettierPluginName[] },
  tsx: { parser: 'typescript', plugins: ['typescript', 'estree'] as PrettierPluginName[] },
  json: { parser: 'json', plugins: ['babel', 'estree'] as PrettierPluginName[] },
  css: { parser: 'css', plugins: ['postcss'] as PrettierPluginName[] },
  scss: { parser: 'scss', plugins: ['postcss'] as PrettierPluginName[] },
  less: { parser: 'less', plugins: ['postcss'] as PrettierPluginName[] },
  html: { parser: 'html', plugins: ['html'] as PrettierPluginName[] },
  vue: { parser: 'vue', plugins: ['html'] as PrettierPluginName[] },
  angular: { parser: 'angular', plugins: ['angular', 'html'] as PrettierPluginName[] },
  markdown: { parser: 'markdown', plugins: ['markdown'] as PrettierPluginName[] },
  yaml: { parser: 'yaml', plugins: ['yaml'] as PrettierPluginName[] },
  graphql: { parser: 'graphql', plugins: ['graphql'] as PrettierPluginName[] },
};

function prettier(id: LanguageId, label: string, extension: string, family: LanguageInfo['family'], key: keyof typeof prettierLanguages): LanguageInfo {
  return {
    id,
    label,
    extension,
    family,
    engine: 'prettier',
    prettier: prettierLanguages[key],
    canMinify: id !== 'markdown' && id !== 'yaml' && id !== 'graphql',
  };
}

function wasm(
  id: LanguageId,
  label: string,
  extension: string,
  family: LanguageInfo['family'],
  formatter: WasmFormatterId,
  filename: string,
): LanguageInfo {
  return {
    id,
    label,
    extension,
    family,
    engine: 'wasm',
    wasm: { formatter, filename },
    canMinify: true,
  };
}

export const LANGUAGES: Record<LanguageId, LanguageInfo> = {
  javascript: prettier('javascript', 'JavaScript', 'js', 'Web', 'javascript'),
  jsx: prettier('jsx', 'JSX', 'jsx', 'Web', 'jsx'),
  typescript: prettier('typescript', 'TypeScript', 'ts', 'Web', 'typescript'),
  tsx: prettier('tsx', 'TSX', 'tsx', 'Web', 'tsx'),
  json: prettier('json', 'JSON', 'json', 'Data', 'json'),
  css: prettier('css', 'CSS', 'css', 'Web', 'css'),
  scss: prettier('scss', 'SCSS', 'scss', 'Web', 'scss'),
  less: prettier('less', 'Less', 'less', 'Web', 'less'),
  html: prettier('html', 'HTML', 'html', 'Markup', 'html'),
  vue: prettier('vue', 'Vue', 'vue', 'Web', 'vue'),
  angular: prettier('angular', 'Angular', 'html', 'Web', 'angular'),
  markdown: prettier('markdown', 'Markdown', 'md', 'Markup', 'markdown'),
  yaml: prettier('yaml', 'YAML', 'yaml', 'Data', 'yaml'),
  graphql: prettier('graphql', 'GraphQL', 'graphql', 'Query', 'graphql'),
  sql: { id: 'sql', label: 'SQL', extension: 'sql', family: 'Query', engine: 'sql', canMinify: true },
  python: wasm('python', 'Python', 'py', 'Scripting', 'ruff_fmt', 'main.py'),
  c: wasm('c', 'C', 'c', 'Systems', 'clang-format', 'main.c'),
  cpp: wasm('cpp', 'C++', 'cpp', 'Systems', 'clang-format', 'main.cpp'),
  java: wasm('java', 'Java', 'java', 'Systems', 'clang-format', 'main.java'),
  csharp: wasm('csharp', 'C#', 'cs', 'Systems', 'clang-format', 'main.cs'),
  objectivec: wasm('objectivec', 'Objective-C', 'm', 'Systems', 'clang-format', 'main.m'),
  // Swift, Kotlin, PHP and Rust have no published browser-capable formatter, so
  // they keep the built-in structural pass.
  swift: { id: 'swift', label: 'Swift', extension: 'swift', family: 'Systems', engine: 'structural', canMinify: true },
  kotlin: { id: 'kotlin', label: 'Kotlin', extension: 'kt', family: 'Systems', engine: 'structural', canMinify: true },
  php: { id: 'php', label: 'PHP', extension: 'php', family: 'Scripting', engine: 'structural', canMinify: true },
  go: wasm('go', 'Go', 'go', 'Systems', 'gofmt', 'main.go'),
  rust: { id: 'rust', label: 'Rust', extension: 'rs', family: 'Systems', engine: 'structural', canMinify: true },
  protobuf: wasm('protobuf', 'Protobuf', 'proto', 'Data', 'clang-format', 'main.proto'),
  xml: { id: 'xml', label: 'XML', extension: 'xml', family: 'Markup', engine: 'xml', canMinify: true },
  toml: { id: 'toml', label: 'TOML', extension: 'toml', family: 'Data', engine: 'toml', canMinify: false },
};

export const LANGUAGE_ORDER: LanguageId[] = [
  'javascript', 'jsx', 'typescript', 'tsx', 'json', 'css', 'scss', 'less',
  'html', 'vue', 'angular', 'markdown', 'yaml', 'graphql',
  'sql', 'python', 'c', 'cpp', 'java', 'csharp', 'objectivec', 'swift',
  'kotlin', 'php', 'go', 'rust', 'protobuf', 'xml', 'toml',
];

// ---------------------------------------------------------------------------
// Prettier (lazy-loaded so the initial bundle stays small)
// ---------------------------------------------------------------------------

const pluginLoaders: Record<PrettierPluginName, () => Promise<unknown>> = {
  babel: () => import('prettier/plugins/babel'),
  estree: () => import('prettier/plugins/estree'),
  typescript: () => import('prettier/plugins/typescript'),
  postcss: () => import('prettier/plugins/postcss'),
  html: () => import('prettier/plugins/html'),
  angular: () => import('prettier/plugins/angular'),
  markdown: () => import('prettier/plugins/markdown'),
  yaml: () => import('prettier/plugins/yaml'),
  graphql: () => import('prettier/plugins/graphql'),
};

const pluginCache = new Map<PrettierPluginName, unknown>();
let standalonePromise: Promise<typeof import('prettier/standalone')> | null = null;

function loadPlugin(name: PrettierPluginName): Promise<unknown> {
  const cached = pluginCache.get(name);
  if (cached) return Promise.resolve(cached);
  return pluginLoaders[name]().then((mod) => {
    pluginCache.set(name, mod);
    return mod;
  });
}

async function formatWithPrettier(source: string, info: LanguageInfo, options: FormatOptions): Promise<string> {
  if (!info.prettier) throw new Error(`No Prettier configuration for ${info.label}.`);
  standalonePromise ??= import('prettier/standalone');
  const [prettier, plugins] = await Promise.all([
    standalonePromise,
    Promise.all(info.prettier.plugins.map(loadPlugin)),
  ]);

  const prettierOptions: PrettierOptions = {
    parser: info.prettier.parser,
    plugins: plugins as PrettierOptions['plugins'],
    tabWidth: options.indentWidth,
    useTabs: options.useTabs,
    printWidth: options.printWidth,
    endOfLine: 'lf',
    ...(info.id === 'json' ? {} : { singleQuote: true }),
  };

  return prettier.format(source, prettierOptions);
}

// ---------------------------------------------------------------------------
// WASM formatters (real formatters, lazy-loaded one package at a time)
// ---------------------------------------------------------------------------

/** Initialised formatter, already bound to its options mapping. */
type WasmFormatFn = (source: string, options: FormatOptions, info: LanguageInfo) => string;

/** clang-format style options derived from the UI controls. */
export function clangFormatStyle(options: FormatOptions): string {
  const width = Math.max(1, options.indentWidth);
  return JSON.stringify({
    BasedOnStyle: 'LLVM',
    IndentWidth: width,
    TabWidth: width,
    UseTab: options.useTabs ? 'ForIndentation' : 'Never',
    ColumnLimit: options.printWidth,
  });
}

/** Ruff formatter configuration derived from the UI controls. */
export function ruffFormatConfig(options: FormatOptions): RuffFormatConfig {
  return {
    indent_style: options.useTabs ? 'tab' : 'space',
    indent_width: Math.max(1, options.indentWidth),
    line_width: options.printWidth,
  };
}

/**
 * The `/vite` entry points let Vite resolve each package's `.wasm` asset, so
 * they are the correct import for this app. `init()` compiles the module once;
 * the exported `format` is synchronous afterwards.
 */
const wasmLoaders: Record<WasmFormatterId, () => Promise<WasmFormatFn>> = {
  'clang-format': async () => {
    const mod = await import('@wasm-fmt/clang-format/vite');
    await mod.default();
    return (source, options, info) => mod.format(source, info.wasm?.filename, clangFormatStyle(options));
  },
  gofmt: async () => {
    const mod = await import('@wasm-fmt/gofmt/vite');
    await mod.default();
    // gofmt is opinionated and tab-indented: it takes no options and no filename.
    return (source) => mod.format(source);
  },
  ruff_fmt: async () => {
    const mod = await import('@wasm-fmt/ruff_fmt/vite');
    await mod.default();
    return (source, options) => mod.format(source, 'main.py', ruffFormatConfig(options));
  },
};

const wasmFormatterCache = new Map<WasmFormatterId, Promise<WasmFormatFn>>();

function loadWasmFormatter(id: WasmFormatterId): Promise<WasmFormatFn> {
  const cached = wasmFormatterCache.get(id);
  if (cached) return cached;
  // Drop failed loads from the cache so a transient failure (offline, WASM
  // blocked) can succeed on a later attempt.
  const pending = wasmLoaders[id]().catch((error: unknown) => {
    wasmFormatterCache.delete(id);
    throw error;
  });
  wasmFormatterCache.set(id, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

async function formatWithSqlFormatter(source: string, options: FormatOptions): Promise<string> {
  const { format } = await import('sql-formatter');
  return format(source, {
    language: 'sql',
    tabWidth: options.useTabs ? 2 : options.indentWidth,
    useTabs: options.useTabs,
    keywordCase: 'upper',
    expressionWidth: options.printWidth,
    linesBetweenQueries: 1,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function indentUnit(options: FormatOptions): string {
  return options.useTabs ? '\t' : ' '.repeat(Math.max(1, options.indentWidth));
}

function trimTrailing(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
}

/** Counts brackets outside of strings and comments, carrying block-comment state. */
class BracketScanner {
  private blockComment = false;

  scan(line: string): { opens: number; closes: number; firstClosers: number; endsOpen: number } {
    let opens = 0;
    let closes = 0;
    let firstClosers = 0;
    let sawContent = false;
    let quote: string | null = null;
    let escaped = false;
    let lineComment = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (this.blockComment) {
        if (char === '*' && line[i + 1] === '/') {
          this.blockComment = false;
          i += 1;
        }
        continue;
      }
      if (lineComment) continue;

      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }

      if (char === '/' && line[i + 1] === '/') {
        lineComment = true;
        continue;
      }
      if (char === '/' && line[i + 1] === '*') {
        this.blockComment = true;
        i += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        sawContent = true;
        continue;
      }
      if (char === '#' && !sawContent) continue; // preprocessor / shebang line

      if (char === '(' || char === '{' || char === '[') opens += 1;
      else if (char === ')' || char === '}' || char === ']') closes += 1;

      if (!sawContent && (char === ')' || char === '}' || char === ']')) firstClosers += 1;
      if (char !== ' ' && char !== '\t') sawContent = true;
    }

    return { opens, closes, firstClosers, endsOpen: opens - closes };
  }
}

// ---------------------------------------------------------------------------
// Structural indenter — the fallback for brace + semicolon languages that have
// no browser-capable formatter (Swift, Kotlin, PHP, Rust) and for any WASM
// engine that fails to load.
// ---------------------------------------------------------------------------

const LABEL_LINE = /^(case\b.*|default|(public|private|protected|internal)\b[^:(]*)\s*:$/;

/** True when the text before a `:` looks like a case/default/access label. */
function isLabelPrefix(line: string): boolean {
  return /^[ \t]*(case\b.*|default|public|private|protected|internal|package)\s*$/i.test(line);
}

/**
 * Splits brace/semicolon languages onto logical lines without touching strings
 * or comments, so single-line sources can be expanded before re-indenting.
 */
function breakStatements(source: string): string {
  let out = '';
  let parenDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;

  const peekWord = (from: number): string => {
    let index = from;
    // Skip newlines too: `}\nelse` is still an else-continuation.
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let word = '';
    while (index < source.length && /[A-Za-z]/.test(source[index])) {
      word += source[index];
      index += 1;
    }
    return word;
  };
  const currentLine = () => out.slice(out.lastIndexOf('\n') + 1);

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (blockComment) {
      out += char;
      if (char === '*' && source[index + 1] === '/') {
        out += '/';
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        out = `${out.replace(/[ \t]+$/, '')}\n`;
      } else {
        out += char;
      }
      continue;
    }
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      out += '//';
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      out += '/*';
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '(' || char === '[') parenDepth += 1;
    else if (char === ')' || char === ']') parenDepth = Math.max(0, parenDepth - 1);

    if (char === '\n' || char === '\r') {
      out += '\n';
      continue;
    }

    if (char === '{') {
      out = `${out.replace(/[ \t\n]+$/, '')} {\n`;
      continue;
    }

    if (char === '}') {
      const nextWord = peekWord(index + 1);
      const continues = /^(else|catch|finally|while|until)$/.test(nextWord);
      out = continues
        ? `${out.replace(/[ \t]+$/, '').replace(/\n+$/, '')}\n} `
        : `${out.replace(/[ \t]+$/, '').replace(/\n+$/, '')}\n}\n`;
      if (continues) {
        // We already emitted the separator space; swallow the source's own
        // whitespace so `} else {` doesn't become `}  else {`.
        while (index + 1 < source.length && /\s/.test(source[index + 1])) index += 1;
      }
      continue;
    }

    if (char === ';' && parenDepth === 0) {
      // Keep `};` glued to the closing brace it belongs to.
      const afterBlock =
        currentLine().trim() === '' && /[}\])]$/.test(out.replace(/\s+$/, ''));
      out = afterBlock
        ? `${out.replace(/\s+$/, '')};\n`
        : `${out.replace(/[ \t]+$/, '')};\n`;
      continue;
    }

    if (char === ',' && parenDepth === 0 && /[}\])]$/.test(out.replace(/\s+$/, ''))) {
      out = `${out.replace(/\s+$/, '')},\n`;
      continue;
    }

    if (char === ':' && parenDepth === 0 && isLabelPrefix(currentLine())) {
      out += ':\n';
      continue;
    }

    out += char;
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatStructural(source: string, options: FormatOptions): string {
  const unit = indentUnit(options);
  const scanner = new BracketScanner();
  const output: string[] = [];
  let depth = 0;

  for (const raw of breakStatements(source).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const metrics = scanner.scan(line);
    const isLabel = LABEL_LINE.test(line);
    const level = Math.max(0, depth - (isLabel ? 1 : metrics.firstClosers));

    output.push(unit.repeat(level) + line);
    depth = Math.max(0, depth + metrics.endsOpen);
  }

  return `${output.join('\n').trim()}\n`;
}

// ---------------------------------------------------------------------------
// Python — normalizes indentation from block structure (colon + dedent keywords)
// ---------------------------------------------------------------------------

/**
 * Normalises Python indentation while preserving block structure. Python's
 * blocks are defined by indentation itself, so the original relative depth is
 * the source of truth — we only rewrite it in the requested indent width.
 *
 * Ruff (WASM) is the primary Python formatter; this is its fallback.
 */
function formatPython(source: string, options: FormatOptions): string {
  const unit = indentUnit(options);
  const lines = trimTrailing(source);
  const indentOf = (line: string) =>
    (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length;

  // Estimate the indent unit from statement lines only: continuation lines
  // inside brackets use smaller, uneven increments and would skew it.
  const scanner = new BracketScanner();
  let open = 0;
  const statementWidths: number[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (open === 0) statementWidths.push(indentOf(line));
    open = Math.max(0, open + scanner.scan(line).endsOpen);
  }
  const positive = statementWidths.filter((width) => width > 0);
  const step = positive.length > 0 ? Math.min(...positive) : 4;

  return `${lines
    .map((line) => {
      const text = line.trim();
      if (!text) return '';
      const level = Math.max(0, Math.round(indentOf(line) / step));
      return unit.repeat(level) + text;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

// ---------------------------------------------------------------------------
// XML / TOML
// ---------------------------------------------------------------------------

function formatXml(source: string, options: FormatOptions): string {
  const unit = indentUnit(options);
  const compact = source.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, (comment) => comment.trim());
  const tokens = compact.match(/<[^>]+>|[^<]+/g) ?? [];
  const output: string[] = [];
  let depth = 0;

  for (const token of tokens) {
    if (token.startsWith('</')) depth = Math.max(0, depth - 1);
    const text = token.trim();
    if (text) output.push(unit.repeat(depth) + text);
    if (token.startsWith('<') && !token.startsWith('</') && !token.startsWith('<?') && !token.startsWith('<!') && !token.endsWith('/>')) {
      depth += 1;
    }
  }

  return `${output.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function formatToml(source: string): string {
  return `${trimTrailing(source)
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n{2,}(\[)/g, '\n\n$1')
    .trim()}\n`;
}

// ---------------------------------------------------------------------------
// Minifiers
// ---------------------------------------------------------------------------

const JS_PUNCTUATION = new Set('{}();,:='.split(''));

interface Token {
  value: string;
  kind: 'word' | 'string' | 'punct' | 'regex';
}

/** Longest first, so `>>>=` wins over `>>` and `>`. */
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

function tokenizeJsLike(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  const isWordChar = (c: string) => /[A-Za-z0-9_$\\]/.test(c);

  while (i < n) {
    const char = source[i];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
      continue;
    }

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const comment = source.slice(i, end === -1 ? n : end);
      if (comment.startsWith('//!')) tokens.push({ value: comment, kind: 'string' });
      i = end === -1 ? n : end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const comment = source.slice(i, stop);
      if (comment.startsWith('/*!')) tokens.push({ value: comment, kind: 'string' });
      i = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let j = i + 1;
      let value = char;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          value += c + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        value += c;
        j += 1;
        if (c === quote) break;
        if (quote === '`' && c === '$' && source[j] === '{') {
          // Consume a template interpolation verbatim, tracking nesting.
          let depth = 1;
          value += '{';
          j += 1;
          while (j < n && depth > 0) {
            if (source[j] === '{') depth += 1;
            else if (source[j] === '}') depth -= 1;
            value += source[j];
            j += 1;
          }
        }
      }
      tokens.push({ value, kind: 'string' });
      i = j;
      continue;
    }

    if (isWordChar(char)) {
      let j = i + 1;
      while (j < n && isWordChar(source[j])) j += 1;
      tokens.push({ value: source.slice(i, j), kind: 'word' });
      i = j;
      continue;
    }

    // Regex literal: only when a value is not expected before it.
    if (char === '/') {
      const prev = tokens[tokens.length - 1];
      const prevValue = prev?.value ?? '';
      const regexAllowed =
        !prev ||
        (prev.kind === 'punct' && !')]}'.includes(prevValue)) ||
        (prev.kind === 'word' &&
          /^(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case)$/.test(prevValue));

      if (regexAllowed && source[i + 1] !== '/' && source[i + 1] !== '*') {
        let j = i + 1;
        let value = '/';
        let inClass = false;
        let closed = false;
        while (j < n) {
          const c = source[j];
          if (c === '\\') {
            value += c + (source[j + 1] ?? '');
            j += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          value += c;
          j += 1;
          if (c === '/' && !inClass) {
            closed = true;
            break;
          }
          if (c === '\n') break;
        }
        // Flags are only collected once the literal is known to be closed, so
        // `/["']/g` stays one token instead of letting the pattern's quotes
        // open a bogus string that swallows the rest of the source.
        if (closed) {
          while (j < n && /[a-z]/.test(source[j])) {
            value += source[j];
            j += 1;
          }
          tokens.push({ value, kind: 'regex' });
          i = j;
          continue;
        }
      }
    }

    // Multi-character operators must stay intact (`i++` is not `i + +`).
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (operator) {
      tokens.push({ value: operator, kind: 'punct' });
      i += operator.length;
      continue;
    }

    tokens.push({ value: char, kind: 'punct' });
    i += 1;
  }

  return tokens;
}

function joinTokens(tokens: Token[]): string {
  let out = '';
  let previous: Token | null = null;

  for (const token of tokens) {
    if (previous) {
      const a = previous.value;
      const b = token.value;
      const bothWords = previous.kind === 'word' && token.kind === 'word';
      const bothValueLike =
        (previous.kind === 'word' || previous.kind === 'string' || previous.kind === 'regex') &&
        (token.kind === 'word' || token.kind === 'string' || token.kind === 'regex');
      const mergesOperator = /[+\-]$/.test(a) && b.startsWith(a.slice(-1));
      const commentGlue = previous.kind === 'string' && /^\/[/*]/.test(a);
      const needsSpace = bothWords || bothValueLike || mergesOperator || commentGlue;

      const stripAround = token.kind === 'punct' && JS_PUNCTUATION.has(b) && !(a.endsWith('+') || a.endsWith('-'));
      const stripBefore = previous.kind === 'punct' && JS_PUNCTUATION.has(a) && !(b.startsWith('+') || b.startsWith('-'));

      if (needsSpace && !stripAround && !stripBefore) out += ' ';
    }
    out += token.value;
    previous = token;
  }

  return out;
}

function minifyJsLike(source: string): string {
  return joinTokens(tokenizeJsLike(source));
}

/**
 * Terser is a real JS parser/printer, replacing the hand-rolled token joiner for
 * plain JavaScript.
 *
 * Options are deliberately non-lossy: `compress`/`mangle` are off so that a
 * standalone expression statement the user pasted (say `/["']/g;`) is not
 * treated as dead code and deleted, and identifiers keep their names. `/*!`
 * comments are preserved, matching the previous behaviour.
 */
async function minifyWithTerser(source: string): Promise<string> {
  const { minify: terserMinify } = await import('terser');
  const result = await terserMinify(source, {
    compress: false,
    mangle: false,
    module: /^[ \t]*(?:import|export)\b/m.test(source),
    format: { comments: /^!/ },
  });
  return result.code ?? '';
}

/**
 * Minifies the JS family. Terser's parser understands neither TypeScript nor
 * JSX syntax, so those keep the token-based pass, as does any input terser
 * rejects.
 */
async function minifyJs(source: string, info: LanguageInfo): Promise<string> {
  if (info.id === 'javascript') {
    try {
      const code = await minifyWithTerser(source);
      if (code.trim()) return code;
    } catch {
      /* fall through to the token minifier */
    }
  }
  return minifyJsLike(source);
}

/**
 * Collapses whitespace and drops comments, but never inside a string literal —
 * `.a { content: "  "; }` must keep both spaces.
 */
function minifyCssLike(source: string): string {
  const PUNCTUATION = new Set('{};:,>~+'.split(''));
  let out = '';
  let pendingSpace = false;
  let previousWasPunctuation = false;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const char = source[i];

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (/\s/.test(char)) {
      pendingSpace = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      if (pendingSpace && !previousWasPunctuation) out += ' ';
      pendingSpace = false;
      let j = i + 1;
      let value = char;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          value += c + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        value += c;
        j += 1;
        if (c === char) break;
      }
      out += value;
      previousWasPunctuation = false;
      i = j;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      pendingSpace = false;
      if (char === '}' && out.endsWith(';')) out = out.slice(0, -1);
      out += char;
      previousWasPunctuation = true;
      i += 1;
      continue;
    }

    if (pendingSpace && !previousWasPunctuation) out += ' ';
    pendingSpace = false;
    out += char;
    previousWasPunctuation = false;
    i += 1;
  }

  return out.trim();
}

/** Elements whose neighbouring whitespace is significant when inlined. */
const INLINE_ELEMENTS = new Set([
  'a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas', 'cite',
  'code', 'data', 'datalist', 'del', 'dfn', 'em', 'embed', 'i', 'iframe',
  'img', 'input', 'ins', 'kbd', 'label', 'map', 'mark', 'meter', 'noscript',
  'object', 'output', 'picture', 'progress', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'select', 'slot', 'small', 'source', 'span', 'strong', 'sub', 'sup',
  'svg', 'template', 'textarea', 'time', 'track', 'u', 'var', 'video', 'wbr',
]);

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Raw-text elements whose contents must be copied verbatim. */
const RAW_TEXT_ELEMENTS = new Set(['pre', 'textarea', 'script', 'style']);

/** Collapses whitespace inside a tag, leaving quoted attribute values alone. */
function collapseTagWhitespace(tag: string): string {
  let out = '';
  let quote: string | null = null;
  let pendingSpace = false;

  for (let i = 0; i < tag.length; i += 1) {
    const char = tag[i];
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && out !== '<' && out !== '</') out += ' ';
      pendingSpace = false;
      out += char;
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (char !== '>' && out !== '<' && out !== '</') out += ' ';
      pendingSpace = false;
    }
    out += char;
  }

  return out;
}

/**
 * `>`/`<` aware so a stray `>` inside an attribute (or `<` inside a script)
 * never desyncs the scan.
 */
function minifyMarkup(source: string): string {
  let out = '';
  let previousTag = '';
  let i = 0;
  const n = source.length;

  const readTag = (start: number) => {
    let end = start + 1;
    let quote: string | null = null;
    while (end < n) {
      const c = source[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      end += 1;
    }
    const raw = source.slice(start, Math.min(end + 1, n));
    const closing = raw.startsWith('</');
    const name = (raw.match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1] ?? '').toLowerCase();
    return {
      tag: raw,
      name,
      closing,
      selfClosing: /\/\s*>$/.test(raw) || (!closing && VOID_ELEMENTS.has(name)),
      end: end + 1,
    };
  };

  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    if (source[i] === '<') {
      const { tag, name, closing, selfClosing, end } = readTag(i);
      out += collapseTagWhitespace(tag);
      previousTag = name;
      i = end;

      if (!closing && !selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
        const rest = source.slice(i);
        const closeMatch = new RegExp(`</${name}\\s*>`, 'i').exec(rest);
        const stop = closeMatch ? closeMatch.index : rest.length;
        out += rest.slice(0, stop);
        if (closeMatch) {
          out += closeMatch[0];
          i += stop + closeMatch[0].length;
        } else {
          i = n;
        }
      }
      continue;
    }

    const nextTag = source.indexOf('<', i);
    const stop = nextTag === -1 ? n : nextTag;
    const text = source.slice(i, stop);

    if (/^\s*$/.test(text)) {
      // A lone space is real inline spacing; whitespace that spans a line is
      // only pretty-printing indentation.
      if (!text.includes('\n')) {
        out += ' ';
      } else if (previousTag && INLINE_ELEMENTS.has(previousTag)) {
        out += ' ';
      } else if (stop < n) {
        const nextName = (source.slice(stop).match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1] ?? '').toLowerCase();
        if (nextName && INLINE_ELEMENTS.has(nextName)) out += ' ';
      }
    } else {
      out += text.replace(/\s+/g, ' ');
    }

    previousTag = '';
    i = stop;
  }

  return out.trim();
}

function minifySql(source: string): string {
  return source
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function minifyPython(source: string): string {
  // Indentation is semantic in Python, so only blank lines and standalone
  // comments can be dropped safely.
  return trimTrailing(source)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .join('\n')
    .trim();
}

function minifyPlain(source: string): string {
  return trimTrailing(source)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// JSON — re-printed from tokens so number literals keep full precision
// ---------------------------------------------------------------------------

interface JsonToken {
  value: string;
  kind: 'string' | 'number' | 'literal' | 'punct';
}

/**
 * `JSON.parse` + `JSON.stringify` rounds integers past 2^53
 * (`12345678901234567890` -> `12345678901234567000`), silently corrupting ids
 * and hashes. Tokenising keeps each literal exactly as written; `JSON.parse`
 * is used only to validate.
 */
function tokenizeJson(source: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const char = source[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
      continue;
    }

    if (char === '"') {
      let j = i + 1;
      let value = '"';
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          value += c + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        value += c;
        j += 1;
        if (c === '"') break;
      }
      tokens.push({ value, kind: 'string' });
      i = j;
      continue;
    }

    if (char === '-' || (char >= '0' && char <= '9')) {
      let j = i + 1;
      while (j < n && /[0-9eE+\-.]/.test(source[j])) j += 1;
      tokens.push({ value: source.slice(i, j), kind: 'number' });
      i = j;
      continue;
    }

    if (/[A-Za-z]/.test(char)) {
      let j = i + 1;
      while (j < n && /[A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ value: source.slice(i, j), kind: 'literal' });
      i = j;
      continue;
    }

    tokens.push({ value: char, kind: 'punct' });
    i += 1;
  }

  return tokens;
}

/** Pretty-prints JSON tokens without ever re-rendering a number literal. */
function printJson(tokens: JsonToken[], unit: string): string {
  let out = '';
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.value === '{' || token.value === '[') {
      const close = token.value === '{' ? '}' : ']';
      if (tokens[i + 1]?.value === close) {
        out += token.value + close;
        i += 1;
        continue;
      }
      depth += 1;
      out += `${token.value}\n${unit.repeat(depth)}`;
      continue;
    }

    if (token.value === '}' || token.value === ']') {
      depth = Math.max(0, depth - 1);
      out += `\n${unit.repeat(depth)}${token.value}`;
      continue;
    }

    if (token.value === ',') {
      out += `,\n${unit.repeat(depth)}`;
      continue;
    }
    if (token.value === ':') {
      out += ': ';
      continue;
    }

    out += token.value;
  }

  return out;
}

function minifyJson(source: string): string {
  return tokenizeJson(source).map((token) => token.value).join('');
}

async function minify(source: string, info: LanguageInfo): Promise<string> {
  if (!info.canMinify) throw new Error(`Minify is not available for ${info.label}.`);
  switch (info.engine) {
    case 'prettier':
      if (info.id === 'json') {
        try {
          JSON.parse(source); // validate only — keeps number literals intact
          return minifyJson(source);
        } catch {
          return minifyJsLike(source);
        }
      }
      if (info.id === 'css' || info.id === 'scss' || info.id === 'less') return minifyCssLike(source);
      if (info.id === 'html' || info.id === 'vue' || info.id === 'angular') return minifyMarkup(source);
      return minifyJs(source, info);
    case 'sql':
      return minifySql(source);
    case 'xml':
      return minifyMarkup(source);
    case 'toml':
      return minifyPlain(source);
    case 'wasm':
      // WASM formatters beautify rather than shrink, so minification stays on
      // the built-in passes (Python's is indentation-preserving).
      return info.id === 'python' ? minifyPython(source) : minifyJsLike(source);
    case 'structural':
      return minifyJsLike(source);
    default:
      return minifyPlain(source);
  }
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export function detectLanguage(source: string): LanguageId {
  const text = source.trim();
  if (!text) return 'typescript';

  if ((text.startsWith('{') || text.startsWith('[')) && (text.endsWith('}') || text.endsWith(']'))) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      /* not JSON */
    }
  }
  if (/^<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text)) return 'html';
  if (text.startsWith('<?xml') || (/^<[a-z][\w:-]*(\s[^>]*)?>/i.test(text) && /<\/[a-z]/i.test(text))) {
    return /xmlns|<\?xml/i.test(text) ? 'xml' : 'html';
  }
  // React/JSX code is JavaScript that happens to contain markup; it must be
  // recognised before the CSS and generic JS heuristics below.
  const looksLikeJsx =
    (/<\/[A-Za-z][\w.:-]*\s*>/.test(text) || /<[A-Za-z][\w.:-]*(\s[^<>]*)?\/>/.test(text)) &&
    /<[A-Za-z][\w.:-]*(\s[^<>]*)?>/.test(text) &&
    /\b(const|let|var|function|class|return|import|export|default|extends|new)\b|=>/.test(text);
  if (looksLikeJsx) {
    return /\binterface\s+\w+\s*\{|\btype\s+\w+\s*=|:\s*(string|number|boolean|bigint|unknown|any|void|never|object)\b|[\w$)\]}]\s*:\s*[A-Z][\w$.<>[\]]*|\bas\s+(const|[A-Z]|\{)/.test(
      text,
    )
      ? 'tsx'
      : 'jsx';
  }
  if (/^#!.*\bpython\b|\bdef\s+\w+\s*\([^)]*\)\s*:|\bfrom\s+\w[\w.]*\s+import\b/m.test(text)) return 'python';
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+\s*\{|\btype\s+\w+\s*=|<\w+>\s*\(/m.test(text)) return 'typescript';
  if (/\b(package\s+\w+$|func\s+\w+\s*\(|:=)/m.test(text)) return 'go';
  if (/\bfn\s+\w+\s*\(|\blet\s+mut\b|\bimpl\s+\w+|->\s*\w+\s*\{/m.test(text)) return 'rust';
  if (/\b(using\s+System|namespace\s+\w+\s*[;{]|Console\.WriteLine|public\s+void)\b/.test(text)) return 'csharp';
  if (/\b(public|private|protected)\s+(static\s+)?(class|interface|void|final)\b/.test(text)) return 'java';
  if (/^syntax\s*=|^message\s+\w+\s*\{|\boptional\s+\w+\s+\w+\s*=/m.test(text)) return 'protobuf';
  if (/\bfunc\s+\w+|\bvar\s+\w+\s*=|\bguard\s+let\b/.test(text)) return 'swift';
  if (/#include\s*<|#define\s+\w+|std::|\bint\s+main\s*\(/.test(text)) {
    return /\bstd::|#include\s*<(iostream|vector|string|map|memory|algorithm)>|\btemplate\s*<|\bclass\s+\w+\s*[:{]/.test(
      text,
    )
      ? 'cpp'
      : 'c';
  }
  if (/\$\w+\s*=|<\?php|\becho\s+/.test(text)) return 'php';
  if (/\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bcreate\s+table\b|\bupdate\b[\s\S]*\bset\b/i.test(text)) return 'sql';
  if (/^---\s*$|\w[\w-]*:\s+\S/m.test(text) && !/[;{}]/.test(text)) return 'yaml';
  if (/^#{1,6}\s+\S|\*\*\w|^[-*]\s+\w/m.test(text) && !/[;{}()]/.test(text)) return 'markdown';
  // A CSS selector and its opening brace must share a line (otherwise
  // preprocessor lines such as `#include <stdio.h>` look like id selectors),
  // the selector must not be a call like `App()`, and the block must actually
  // contain a declaration — otherwise `function App(){ return 1; }` reads as
  // CSS.
  const cssAtRule = /^[ \t]*@[a-z-]+[^{}\n]*\{/im;
  const cssRule = /^[ \t]*(?:[.#][\w-]+|:root|[a-z][\w-]*)[^{}()\n]*\{/im;
  const cssDeclaration = /[\w-]+\s*:\s*[^;{}]+[;}]/;
  if ((cssAtRule.test(text) || cssRule.test(text)) && cssDeclaration.test(text)) return 'css';
  if (/^@(use|import|mixin|include|extend)|\$[\w-]+\s*:/m.test(text)) return 'scss';
  if (/\b(const|let|var|function|=>)\b|^import\s|^export\s/m.test(text)) return 'javascript';
  return 'typescript';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export class FormatError extends Error {
  readonly name = 'FormatError';
}

export async function formatCode(source: string, options: FormatOptions): Promise<string> {
  if (!source.trim()) return '';
  const info = LANGUAGES[options.language];
  const normalized = source.replace(/\r\n?/g, '\n').trim();

  try {
    if (options.mode === 'minify') return minify(normalized, info);

    // Prettier's JSON parser deliberately keeps the source's own line breaks,
    // which makes a one-line document stay one line. Beautifying JSON should
    // always expand it, so parse and re-serialise instead.
    if (info.id === 'json') {
      try {
        const indentText = options.useTabs ? '\t' : ' '.repeat(Math.max(1, options.indentWidth));
        JSON.parse(normalized); // validate only — keeps number literals intact
        return printJson(tokenizeJson(normalized), indentText);
      } catch {
        // Fall through to Prettier so the user gets a precise parse error.
      }
    }

    switch (info.engine) {
      case 'prettier':
        return (await formatWithPrettier(normalized, info, options)).trimEnd();
      case 'sql':
        return (await formatWithSqlFormatter(normalized, options)).trimEnd();
      case 'wasm': {
        // Only an unavailable engine degrades gracefully; a genuine formatter
        // error (e.g. invalid syntax) must still reach the user.
        const formatter = info.wasm
          ? await loadWasmFormatter(info.wasm.formatter).catch(() => null)
          : null;
        if (!formatter) {
          return (info.id === 'python' ? formatPython(normalized, options) : formatStructural(normalized, options)).trimEnd();
        }
        return formatter(normalized, options, info).trimEnd();
      }
      case 'xml':
        return formatXml(normalized, options).trimEnd();
      case 'toml':
        return formatToml(normalized).trimEnd();
      case 'structural':
        return formatStructural(normalized, options).trimEnd();
      default:
        return normalized;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FormatError(message);
  }
}

export function countStats(value: string): { lines: number; characters: number; bytes: number } {
  if (!value) return { lines: 0, characters: 0, bytes: 0 };
  return {
    lines: value.split('\n').length,
    characters: value.length,
    bytes: new TextEncoder().encode(value).length,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
