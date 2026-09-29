# Code Compact

A local-first browser formatter that turns verbose pasted code into compact, readable output.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/code-compact/src/App.tsx` — single-page formatter UI, language detection, compact formatting logic, copy, and download actions
- `artifacts/code-compact/src/index.css` — theme tokens, responsive layout, code editor styling, and motion
- `artifacts/code-compact/.replit-artifact/artifact.toml` — artifact routing and managed web workflow

## Architecture decisions

- Formatting runs entirely in the browser; pasted source is not uploaded.
- Short expressions, calls, and object literals are compacted, while control-flow and function blocks keep readable line breaks.
- The formatter is dependency-light and supports common scripting, markup, styling, and query languages with local heuristics.

## Product

- Paste code into an editable source panel and see the compact result live.
- Choose or detect a language, tune compactness, swap examples, copy output, download output, and toggle dark mode.
- Show before/after token counts and a savings summary.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
