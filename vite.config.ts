import type { ServerResponse } from 'node:http';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

/**
 * The Code Runner's execution endpoint is a Vercel Function (`api/execute.ts`),
 * which production runs and Vite knows nothing about. Without this, the tab's
 * Run button would find no endpoint in `pnpm dev` or `pnpm serve` and disable
 * itself — correct behaviour, but useless for actually trying the thing.
 *
 * Mounting the same handler keeps one implementation of the validation, limits
 * and provider call across local and deployed, so what runs here is what ships.
 * It answers only on `/api/execute`; Vercel's function takes over in production.
 */
/**
 * Where the execution handler lives, as an absolute URL.
 *
 * Vite bundles this config before running it, so a *relative* specifier in a
 * lazy `import()` resolves against the bundle in `node_modules/.vite-temp`
 * rather than against the project. That import throws ERR_MODULE_NOT_FOUND, and
 * nothing awaits the rejection, so the whole dev server exits — after which
 * every request, the editor's own module included, fails with an empty reply.
 * Vite rewrites `import.meta.url` to the real config location, so resolving
 * against it gives the handler's true path in dev, preview and build alike.
 */
const EXECUTE_HANDLER_URL = new URL('./api/execute.ts', import.meta.url).href;

/**
 * The handler's shape, restated here rather than imported from `api/execute.ts`:
 * a static reference to a Vercel Function at config-evaluation time is what made
 * Vercel's build skip emitting it.
 */
type ExecuteRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ExecuteResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ExecuteResponse;
  json(body: unknown): void;
};

type ExecuteHandler = (req: ExecuteRequest, res: ExecuteResponse) => Promise<void>;

/** Loaded on the first request and then reused, so the handler's limiter stays warm. */
let executeHandlerPromise: Promise<ExecuteHandler> | undefined;

function loadExecuteHandler(): Promise<ExecuteHandler> {
  executeHandlerPromise ??= import(EXECUTE_HANDLER_URL).then(
    (module) => module.default as ExecuteHandler,
    (error: unknown) => {
      // Forgetting a failure is deliberate: the next request tries again, so a
      // fixed handler is picked up without restarting the dev server.
      executeHandlerPromise = undefined;
      throw error;
    },
  );
  return executeHandlerPromise;
}

/**
 * Connect hands us Node's request and response, not Vercel's. Give the handler
 * the three methods it uses and let it write straight through; it reads the body
 * from the stream when nothing has parsed it.
 */
function toExecuteResponse(res: ServerResponse): ExecuteResponse {
  const response: ExecuteResponse = {
    setHeader: (name, value) => res.setHeader(name, value),
    status: (code) => {
      res.statusCode = code;
      return response;
    },
    json: (body) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    },
  };
  return response;
}

/**
 * Serve one execution request.
 *
 * Nothing is allowed to reject out of here: an unhandled rejection takes the
 * Node process down with it, which would turn one bad request into a dead
 * server for every later one.
 */
async function serveExecute(req: Connect.IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const executeHandler = await loadExecuteHandler();
    await executeHandler(req, toExecuteResponse(res));
  } catch (error) {
    console.error('[code-runner-api] request failed:', error);
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The local execution endpoint failed. See the dev server log.' }));
  }
}

/** Mount the same handler on both the dev and the preview server. */
function mountExecuteHandler(middlewares: Connect.Server): void {
  middlewares.use('/api/execute', (req, res, _next) => {
    void serveExecute(req, res);
  });
}

function runnerApi(): Plugin {
  /**
   * Hand the handler the runner's own settings from `.env`.
   *
   * Vite exposes `VITE_`-prefixed names to the app and nothing else, but the
   * runner's settings are deliberately server-side (`JUDGE0_*`, `RUNNER_*`), so
   * a deployed function would see them and a local one would not. Reading them
   * here keeps the two the same; anything already in the shell environment
   * still wins, which is how the host injects its own values.
   */
  const applyEnv = (mode: string): void => {
    const files = loadEnv(mode, path.resolve(import.meta.dirname), '');
    for (const [key, value] of Object.entries(files)) {
      if (!key.startsWith('VITE_') && process.env[key] === undefined) process.env[key] = value;
    }
  };

  return {
    name: 'code-runner-api',
    configureServer(server) {
      applyEnv(server.config.mode);
      mountExecuteHandler(server.middlewares);
    },
    configurePreviewServer(server) {
      applyEnv(server.config.mode);
      mountExecuteHandler(server.middlewares);
    },
  };
}

// Replit injects PORT/BASE_PATH; fall back to safe defaults so the app also
// runs locally with a plain `pnpm dev` and no environment setup. An unset,
// empty, or `0` PORT (common in dev/CI shells) means "use the default".
const configuredPort = process.env.PORT;
const rawPort =
  configuredPort === undefined || configuredPort === '' || configuredPort === '0'
    ? '23084'
    : configuredPort;
const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runnerApi(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' && process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  // The formatting worker lazily imports Prettier, the WASM formatters and
  // terser, so it needs a code-splitting (ES module) output rather than the
  // default IIFE that cannot be split.
  worker: {
    format: 'es',
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
