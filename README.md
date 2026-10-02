# Code Formatter

A local-first code formatter and beautifier: paste code on the left, pick a
language, and get clean, consistently formatted output on the right. A Minify
mode is available too. Everything runs in the browser — pasted source is never
uploaded.

Formatting runs in a Web Worker, so the editor keeps responding while a document
is rewritten, and a newer edit cancels the work in flight instead of queueing
behind it. Pastes larger than 1 MB are held back until you confirm, so one
enormous document cannot tie up the tab. The output sits above a side-by-side
diff of the input and output, so it is obvious what moved.

Formatting engines:

- **Prettier** (standalone, lazy-loaded per language) for JavaScript, JSX,
  TypeScript, TSX, JSON, CSS, SCSS, Less, HTML, Vue, Angular, Markdown, YAML
  and GraphQL.
- **Real formatters compiled to WebAssembly**, lazy-loaded one package per
  language so only the language you actually use is downloaded:
  - [`@wasm-fmt/clang-format`](https://github.com/wasm-fmt/clang-format) for
    C, C++, Java, C#, Objective-C and Protobuf (the dialect comes from the
    language, and indentation/column limit from the toolbar)
  - [`@wasm-fmt/gofmt`](https://github.com/wasm-fmt/gofmt) for Go
  - [`@wasm-fmt/ruff_fmt`](https://github.com/wasm-fmt/ruff_fmt) for Python
- **sql-formatter** for SQL.
- **Built-in structural passes** for Swift, Kotlin, PHP and Rust — no
  browser-capable formatter is published for these, so they expand single-line
  code and re-indent it — plus XML/TOML handling and an indentation-preserving
  Python pass that also serves as the WASM fallback.

Minify uses **terser** for plain JavaScript and the built-in token pass for
TypeScript and JSX, which terser's parser does not understand. Terser runs
non-lossy (`compress` and `mangle` off): comments and whitespace go, but your
identifiers and statements are never renamed or deleted. Markdown, YAML and
TOML are format-only because collapsing them safely is not possible.

This is a [pnpm](https://pnpm.io) workspace monorepo containing:

| Package | Path | What it is |
| --- | --- | --- |
| `@workspace/code-compact` | `artifacts/code-compact` | The web formatter + beautifier (React + Vite) — the main app |
| `@workspace/api-server` | `artifacts/api-server` | Express API (`/api`) |
| `@workspace/mockup-sandbox` | `artifacts/mockup-sandbox` | Component preview canvas |
| `@workspace/db` | `lib/db` | Drizzle schema + Postgres client |
| `@workspace/api-zod` | `lib/api-zod` | Zod schemas generated from the OpenAPI spec |
| `@workspace/api-client-react` | `lib/api-client-react` | Generated React Query client |
| `@workspace/api-spec` | `lib/api-spec` | OpenAPI spec + Orval codegen |
| `@workspace/scripts` | `scripts` | Utility scripts |

## Requirements

- **Node.js** 20.11+ (24 recommended)
- **pnpm** 10+ — `npm install -g pnpm` (this repo refuses to install via npm/yarn)

## Commands

```bash
pnpm install          # install all workspace dependencies

pnpm dev              # start the web formatter  -> http://localhost:23084
pnpm dev:api          # start the API server     -> http://localhost:8080/api/healthz
pnpm dev:mockup       # start the component canvas -> http://localhost:8081/__mockup

pnpm run typecheck    # typecheck every package
pnpm run build        # typecheck + build every package
pnpm test             # run the formatter engine regression tests
```

The formatter tests (`artifacts/code-compact/src/lib/*.test.ts`) use Node's
built-in test runner with native TypeScript type stripping, so they need no
extra dependencies but require **Node.js 22.18+**.


Run a single package's scripts directly with a filter, e.g.:

```bash
pnpm --filter @workspace/code-compact run dev
pnpm --filter @workspace/api-server run dev
```

### Database (optional)

The API server does not need a database to boot: `/api/healthz` works with no
configuration. Only the DB helper needs one.

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/db"
pnpm --filter @workspace/db run push   # push the Drizzle schema
```

## Configuration

`PORT` and `BASE_PATH` are injected automatically on Replit. Locally they are
optional — each app falls back to a sensible default (shown above). Override
them the usual way, e.g. `PORT=4000 pnpm dev`.

## Regenerating the API client

```bash
pnpm --filter @workspace/api-spec run codegen
```

This reads `lib/api-spec/openapi.yaml` and regenerates `lib/api-zod` and
`lib/api-client-react`. Always run it after editing the spec.
