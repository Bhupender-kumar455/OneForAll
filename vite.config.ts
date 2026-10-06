import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';

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
const EXECUTE_HANDLER_PATH = './api/execute.ts' as const;

/**
 * The handler is imported lazily, inside the plugin factory, so the Vite config
 * file never carries a top-level import of a Vercel Function. A static reference
 * to `api/execute.ts` at module-evaluation time is what confused Vercel's
 * build into skipping emission on that file.
 */
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
      server.middlewares.use('/api/execute', async (req, res, _next) => {
        // Lazy import so the function is only loaded in a running dev/preview
        // server, never at config-evaluation time.
        const { default: executeHandler } = await import(EXECUTE_HANDLER_PATH);

        const nodeRes = res as {
          setHeader(name: string, value: string): void;
          statusCode: number;
          end(body?: string): void;
        };

        // Connect hands us Node's request and response, not Vercel's. Give the
        // handler the three methods it uses and let it write straight through;
        // it reads the body from the stream when nothing has parsed it.
        const response = {
          setHeader: (name: string, value: string) => nodeRes.setHeader(name, value),
          status: (code: number) => {
            nodeRes.statusCode = code;
            return response;
          },
          json: (body: unknown) => {
            nodeRes.setHeader('Content-Type', 'application/json');
            nodeRes.end(JSON.stringify(body));
          },
        };

        await executeHandler(req as Parameters<typeof executeHandler>[0], response);
      });
    },
    configurePreviewServer(server) {
      applyEnv(server.config.mode);
      server.middlewares.use('/api/execute', async (req, res, _next) => {
        const { default: executeHandler } = await import(EXECUTE_HANDLER_PATH);

        const nodeRes = res as {
          setHeader(name: string, value: string): void;
          statusCode: number;
          end(body?: string): void;
        };

        const response = {
          setHeader: (name: string, value: string) => nodeRes.setHeader(name, value),
          status: (code: number) => {
            nodeRes.statusCode = code;
            return response;
          },
          json: (body: unknown) => {
            nodeRes.setHeader('Content-Type', 'application/json');
            nodeRes.end(JSON.stringify(body));
          },
        };

        await executeHandler(req as Parameters<typeof executeHandler>[0], response);
      });
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
