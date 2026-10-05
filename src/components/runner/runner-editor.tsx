import { useEffect, useRef } from 'react';

import { RUNNER_LANGUAGES } from '@/lib/runner/data/languages';
import {
  LANGUAGE_IMPORTS,
  LANGUAGE_INTELLISENSE,
  MONACO_WORKER_LANGUAGES,
  type ImportCatalog,
} from '@/lib/runner/language-intellisense';

/* ── Monaco, assembled by hand ────────────────────────────────────────────────
 *
 * `monaco-editor`'s export map sends dot-js to the esm/vs directory, so a
 * specifier below names a real file in node_modules without repeating the
 * package's own `esm/vs` segment — `monaco-editor/esm/vs/` would be doubled
 * and unresolved.
 * Three groups, each on purpose:
 *
 *   editor.api.js             the editor itself, rather than Monaco's own index,
 *                             which would also register ~70 grammars this tab
 *                             can never show.
 *   features/register.all.js  the editing features — find, multi-cursor, comment,
 *                             bracket matching, folding — registered exactly the
 *                             way Monaco's entry point registers them.
 *   definitions/<lang>/register    only the grammars the runner offers, one per entry
 *                             in RUNNER_LANGUAGES; each lazy-loads its tokenizer
 *                             the first time that language is used.
 *
 * The worker is *imported* rather than referenced by URL: the backtick in
 * `new URL(...)` is resolved relative to this file, where no such path
 * exists. Vite turns the import into a bundled, hashed worker asset.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';

/* ── Language contributions: grammar + worker-backed features ──────────────
 *
 * `languages/definitions/<lang>/register.js` only register tokenizers (syntax
 * highlighting). The `/language/` contributions below add the features that
 * need a worker — completions, hover, signature help, diagnostics — for the
 * languages Monaco actually ships a worker for: TypeScript, JavaScript and
 * JSON. The runner's other languages (Python, C, Java, …) have no Monaco worker
 * and so can't get type-aware IntelliSense; instead, `registerLanguageIntellisense`
 * below turns the catalogue in `lib/runner/language-intellisense` into
 * completions, snippets, member access after `.`, hover and signature help.
 */
import 'monaco-editor/language/typescript/monaco.contribution.js';
import 'monaco-editor/language/json/monaco.contribution.js';

import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/csharp/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/ruby/register.js';
import 'monaco-editor/languages/definitions/kotlin/register.js';
import 'monaco-editor/languages/definitions/swift/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';

import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TSWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import JSONWorker from 'monaco-editor/language/json/json.worker.js?worker';

/** The editor's own type, so the code below stays declarative. */
type MonacoApi = typeof monaco;

/** Point Monaco at its own worker. Vite bundles this as a separate asset. */
function configureEnvironment(): void {
  const scope = globalThis as {
    MonacoEnvironment?: { getWorker?: (moduleId: string, label: string) => Worker };
  };
  if (scope.MonacoEnvironment?.getWorker) return;
  scope.MonacoEnvironment = {
    // Route each language to the worker it speaks. TypeScript, JavaScript and
    // JSON get Monaco's built-in language workers — those supply completions,
    // hover and diagnostics. Every other language falls back to the generic
    // editor worker (which supports features like find and multi-cursor, but
    // not language-aware ones, since no worker exists for them here).
    getWorker: (_moduleId: string, label: string) => {
      if (label === 'typescript' || label === 'javascript' || label === 'typescriptreact' || label === 'javascriptreact') {
        return new TSWorker();
      }
      if (label === 'json' || label === 'jsonc') {
        return new JSONWorker();
      }
      return new EditorWorker();
    },
  };
}

/**
 * A grammar missing from the import list above is not an error anyone sees: the
 * model simply tokenizes as plain text. The catalogue and the registrations are
 * two lists that have to agree, so say so out loud while developing.
 */
function warnAboutMissingGrammars(api: MonacoApi): void {
  if (!import.meta.env.DEV) return;
  const registered = new Set(api.languages.getLanguages().map((language) => language.id));
  const missing = RUNNER_LANGUAGES.filter((language) => !registered.has(language.monaco));
  if (missing.length > 0) {
    console.warn(
      `[runner] no Monaco grammar registered for ${missing
        .map((language) => `${language.short} (${language.monaco})`)
        .join(', ')} — highlighting for it will be plain text.`,
    );
  }
}

let loading: Promise<MonacoApi> | null = null;

/** A `"name(params)"` catalogue entry, split into the two halves Monaco wants. */
function parseCallable(spec: string): { label: string; signature: string } {
  const open = spec.indexOf('(');
  if (open === -1) return { label: spec.trim(), signature: '' };
  return { label: spec.slice(0, open).trim(), signature: spec.slice(open).trim() };
}

/** The parameter list of a signature, split on the commas that are not nested. */
function splitParameters(signature: string): string[] {
  const inner = signature.replace(/^\(/, '').replace(/\)$/, '').trim();
  if (inner === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '(' || char === '[' || char === '<') depth++;
    else if (char === ')' || char === ']' || char === '>') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * A language's import catalogue, compiled once into the regexes the provider
 * asks on every keystroke.
 */
type ImportPlan = {
  trigger: RegExp;
  from: RegExp | null;
  separator: string;
  token: RegExp;
  paths: readonly string[];
  areTypes: boolean;
};

function createImportPlan(catalogue: ImportCatalog | undefined): ImportPlan | null {
  if (!catalogue) return null;
  const separator = catalogue.separator ?? '.';
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The run of characters forming the path being typed, ending at the cursor:
  // `a.b.c` when there is a separator, a single atom (a C header) when not.
  const token =
    separator === ''
      ? /[A-Za-z0-9_.+/-]*$/
      : new RegExp(`[A-Za-z0-9_$](?:[A-Za-z0-9_$]|${escaped})*$`);
  return {
    trigger: new RegExp(catalogue.trigger),
    from: catalogue.fromTrigger ? new RegExp(catalogue.fromTrigger) : null,
    separator,
    token,
    paths: catalogue.paths,
    areTypes: catalogue.types ?? false,
  };
}

/**
 * Where the import path under the cursor begins, or null when the line is not
 * an import. `parent` is everything up to and including the last separator —
 * the scope whose next segment is in play — and `start` is the 0-based offset
 * of the segment Monaco should replace.
 */
function importPrefix(
  plan: ImportPlan,
  line: string,
  column: number,
): { parent: string; start: number } | null {
  const before = line.slice(0, column - 1);
  const token = plan.token.exec(before)?.[0] ?? '';
  const start = before.length - token.length;

  // `from X import Y` names a scope that never appears on the same path.
  const from = plan.from?.exec(before);
  if (from) return { parent: `${from[1]}${plan.separator}`, start };

  if (!plan.trigger.test(before)) return null;
  if (plan.separator === '') return { parent: '', start };

  const head = token.split(plan.separator).slice(0, -1).join(plan.separator);
  const parent = head === '' ? '' : head + plan.separator;
  return { parent, start: start + parent.length };
}

/** The next segment of every import path beneath `parent`, deduplicated. */
function importCompletions(plan: ImportPlan, parent: string): { label: string; detail: string }[] {
  const seen = new Set<string>();
  const out: { label: string; detail: string }[] = [];
  for (const path of plan.paths) {
    if (parent !== '' && !path.startsWith(parent)) continue;
    const after = path.slice(parent.length);
    if (after === '') continue;
    const cut = plan.separator === '' ? -1 : after.indexOf(plan.separator);
    const segment = cut === -1 ? after : after.slice(0, cut);
    if (segment === '' || seen.has(segment)) continue;
    seen.add(segment);
    out.push({
      label: segment,
      detail: cut === -1 ? (plan.areTypes ? 'class' : 'module') : 'package',
    });
  }
  return out;
}

/** How many top-level commas precede the cursor, i.e. which argument is active. */
function activeParameter(tail: string): number {
  let depth = 0;
  let index = 0;
  for (const char of tail) {
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === ',' && depth === 0) index++;
  }
  return index;
}

/**
 * Turn the catalogue into Monaco providers for every language Monaco has no
 * worker for — Python, C, C++, Java, etc. TypeScript, JavaScript and JSON are
 * skipped: their workers already supply far better completions and snippet
 * expansion, and a second provider would only duplicate them.
 *
 * What each language gets:
 *   - snippets, ranked first, so `for` + Enter expands instead of inserting a
 *     bare keyword;
 *   - keywords, types and constants;
 *   - built-ins with their signatures, inserted with a `$1` tab stop inside the
 *     parentheses;
 *   - members after a `.`, offered as methods;
 *   - hover and signature help built from the same signatures.
 */
function registerLanguageIntellisense(api: MonacoApi): void {
  const { CompletionItemKind, CompletionItemInsertTextRule } = api.languages;
  const asSnippet = CompletionItemInsertTextRule.InsertAsSnippet;

  for (const [languageId, catalogue] of Object.entries(LANGUAGE_INTELLISENSE)) {
    // Worker-backed languages already get real IntelliSense; don't shadow it.
    if (MONACO_WORKER_LANGUAGES.has(languageId)) continue;

    const importPlan = createImportPlan(LANGUAGE_IMPORTS[languageId]);
    const snippets = catalogue.snippets ?? [];
    const functions = (catalogue.functions ?? []).map(parseCallable);
    const members = (catalogue.members ?? []).map(parseCallable);

    // One entry per name. A snippet beats a bare keyword of the same name — a
    // template is strictly more useful than the word alone — and a callable
    // beats a plain type, because `int` reads better as `int(x, base=10)` than
    // as a bare type. `taken` carries the names already spoken for.
    const taken = new Set(snippets.map((snippet) => snippet.label));
    for (const builtin of functions) taken.add(builtin.label);
    const keywords = catalogue.keywords.filter((word) => !taken.has(word));
    for (const word of keywords) taken.add(word);
    const types = (catalogue.types ?? []).filter((type) => !taken.has(type));
    for (const type of types) taken.add(type);
    const constants = (catalogue.constants ?? []).filter((constant) => !taken.has(constant));

    // Signature help and hover read from the same callables the completions use.
    const signatureText = new Map<string, string>();
    const parameters = new Map<string, string[]>();
    for (const callable of [...functions, ...members]) {
      if (callable.signature === '') continue;
      const params = splitParameters(callable.signature);
      signatureText.set(callable.label, callable.signature);
      parameters.set(callable.label, params);
      // `System.out.printf` is one label, but the cursor sits next to the word
      // `printf`; the last dotted segment has to answer too.
      const last = callable.label.slice(callable.label.lastIndexOf('.') + 1);
      if (!signatureText.has(last)) {
        signatureText.set(last, callable.signature);
        parameters.set(last, params);
      }
    }

    api.languages.registerCompletionItemProvider(languageId, {
      // A dot is the one unambiguous trigger: it always means "pick a member".
      triggerCharacters: ['.'],
      provideCompletionItems: (model, position) => {
        const line = model.getLineContent(position.lineNumber);

        // An import line is a package tree, not an expression: answer with the
        // next segment (`import java.` → `util`, `io`, `lang`, …) rather than
        // letting the dot below offer methods.
        if (importPlan) {
          const prefix = importPrefix(importPlan, line, position.column);
          if (prefix) {
            const suggestions: monaco.languages.CompletionItem[] = [];
            for (const entry of importCompletions(importPlan, prefix.parent)) {
              suggestions.push({
                label: entry.label,
                kind:
                  entry.detail === 'class' ? CompletionItemKind.Class : CompletionItemKind.Module,
                detail: entry.detail,
                insertText: entry.label,
                range: {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: prefix.start + 1,
                  endColumn: position.column,
                },
                sortText: `0_${entry.label}`,
              });
            }
            return { suggestions };
          }
        }

        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const suggestions: monaco.languages.CompletionItem[] = [];

        // A dot (optionally spaced) right before the word means the user is
        // reaching for a member, not starting a new word.
        const beforeWord = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: word.startColumn,
        });
        if (/\.\s*$/.test(beforeWord)) {
          for (const member of members) {
            suggestions.push({
              label: member.label,
              kind: CompletionItemKind.Method,
              detail: member.signature === '' ? 'member' : member.signature,
              insertText: member.signature === '' ? member.label : `${member.label}($1)`,
              insertTextRules: asSnippet,
              range,
              sortText: `0_${member.label}`,
            });
          }
          return { suggestions };
        }

        // Snippets rank above everything: they are the ones worth pressing
        // Enter on.
        snippets.forEach((snippet, index) => {
          suggestions.push({
            label: snippet.label,
            kind: CompletionItemKind.Snippet,
            detail: snippet.detail ?? 'snippet',
            documentation: { value: `\`\`\`\n${snippet.body.replace(/\$\{\d+:?([^}]*)\}/g, '$1')}\n\`\`\`` },
            insertText: snippet.body,
            insertTextRules: asSnippet,
            range,
            sortText: `0${index}_${snippet.label}`,
          });
        });

        for (const keyword of keywords) {
          suggestions.push({
            label: keyword,
            kind: CompletionItemKind.Keyword,
            detail: 'keyword',
            insertText: keyword,
            range,
            sortText: `1_${keyword}`,
          });
        }

        for (const type of types) {
          suggestions.push({
            label: type,
            kind: CompletionItemKind.Class,
            detail: 'type',
            insertText: type,
            range,
            sortText: `2_${type}`,
          });
        }

        for (const constant of constants) {
          suggestions.push({
            label: constant,
            kind: CompletionItemKind.Constant,
            detail: 'constant',
            insertText: constant,
            range,
            sortText: `2_${constant}`,
          });
        }

        for (const builtin of functions) {
          suggestions.push({
            label: builtin.label,
            kind: CompletionItemKind.Function,
            detail: builtin.signature === '' ? 'built-in' : builtin.signature,
            insertText: builtin.signature === '' ? builtin.label : `${builtin.label}($1)`,
            insertTextRules: asSnippet,
            range,
            sortText: `3_${builtin.label}`,
          });
        }

        return { suggestions };
      },
    });

    // Hover shows the signature of whatever built-in is under the pointer.
    api.languages.registerHoverProvider(languageId, {
      provideHover: (model, position) => {
        const word = model.getWordAtPosition(position);
        const signature = word ? signatureText.get(word.word) : undefined;
        if (!word || signature === undefined) return null;
        const params = parameters.get(word.word) ?? [];
        return {
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          },
          contents: [
            { value: `\`\`\`\n${word.word}${signature}\n\`\`\`` },
            { value: params.length === 0 ? 'No parameters.' : params.map((p) => `* \`${p}\``).join('\n') },
          ],
        };
      },
    });

    // Signature help: inside a call, show its parameters and highlight the one
    // the cursor is sitting in.
    api.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: (model, position) => {
        const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        // Walk back to the innermost unclosed '('.
        let depth = 0;
        let open = -1;
        for (let i = line.length - 1; i >= 0; i--) {
          const char = line[i];
          if (char === ')') depth++;
          else if (char === '(') {
            if (depth === 0) {
              open = i;
              break;
            }
            depth--;
          }
        }
        if (open === -1) return null;

        const named = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line.slice(0, open));
        const params = named ? parameters.get(named[1]) : undefined;
        const signature = named ? signatureText.get(named[1]) : undefined;
        if (!named || !params || signature === undefined) return null;

        return {
          value: {
            signatures: [
              {
                label: `${named[1]}${signature}`,
                parameters: params.map((param) => ({ label: param })),
              },
            ],
            activeSignature: 0,
            activeParameter: Math.min(activeParameter(line.slice(open + 1)), Math.max(0, params.length - 1)),
          },
          dispose: () => {},
        };
      },
    });
  }
}

/**
 * Hand back the editor API, configuring its worker the first time.
 *
 * The whole module is already behind the page's `lazy()` boundary, so this is
 * synchronous work wrapped in a promise: it keeps one call site for the editor
 * rather than spreading imports through the component.
 */
export function loadMonaco(): Promise<MonacoApi> {
  if (!loading) {
    configureEnvironment();
    warnAboutMissingGrammars(monaco);
    registerLanguageIntellisense(monaco);
    loading = Promise.resolve(monaco);
  }
  return loading;
}

/** The subset of the editor instance the page needs. */
export type EditorHandle = {
  getValue: () => string;
  setValue: (value: string) => void;
};

type Theme = 'light' | 'dark';

function themeName(theme: Theme): string {
  return theme === 'dark' ? 'vs-dark' : 'vs';
}

/** Whether the current language gets autocomplete support in the editor. */
export function hasIntellisense(language: string): boolean {
  // Worker-backed languages get full IntelliSense from Monaco's built-in
  // language workers; non-worker languages get the catalogue above.
  return MONACO_WORKER_LANGUAGES.has(language) || language in LANGUAGE_INTELLISENSE;
}

export function RunnerEditor({
  value,
  language,
  theme,
  onChange,
  onReady,
  onRun,
}: {
  value: string;
  language: string;
  theme: Theme;
  onChange: (value: string) => void;
  onReady: (handle: EditorHandle | null) => void;
  onRun: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const api = useRef<MonacoApi | null>(null);
  const latest = useRef({ onChange, onRun, theme });
  // The instance is built asynchronously, so it reads its props through this ref
  // rather than from the render that started it: a theme switch while the chunk
  // is loading would otherwise be baked in as the light theme.
  latest.current = { onChange, onRun, theme };

  // The editor is created once; every later prop is applied as a change rather
  // than by re-creating it, so typing is never interrupted.
  useEffect(() => {
    let cancelled = false;
    const node = host.current;
    if (!node) return;

    void loadMonaco().then((monaco) => {
      if (cancelled || !node.isConnected) return;

      const instance = monaco.editor.create(node, {
        value,
        language,
        theme: themeName(latest.current.theme),
        minimap: { enabled: false },
        lineNumbers: 'on',
        fontSize: 13,
        fontFamily: 'var(--app-font-mono)',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        quickSuggestions: true,
        wordBasedSuggestions: 'allDocuments',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        padding: { top: 12, bottom: 12 },
        tabSize: 4,
        wordWrap: 'off',
      });

      editor.current = instance;
      api.current = monaco;
      instance.onDidChangeModelContent(() => latest.current.onChange(instance.getValue()));

      // Ctrl/Cmd+Enter runs: the shortcut every online judge trains people to use.
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
        latest.current.onRun(),
      );

      onReady({
        getValue: () => instance.getValue(),
        setValue: (next) => instance.setValue(next),
      });
    });

    return () => {
      cancelled = true;
      onReady(null);
      editor.current?.dispose();
      editor.current = null;
      api.current = null;
    };
    // Intentionally created once: value/language/theme are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching language replaces the sample code. Only push a value in when the
  // editor does not already hold it, otherwise every keystroke would reset the
  // cursor to the end of the document.
  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (instance && model) api.current?.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    api.current?.editor.setTheme(themeName(theme));
  }, [theme]);

  return <div ref={host} className="h-full w-full" data-testid="runner-editor" />;
}
