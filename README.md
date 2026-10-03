# Code Compact

A local-first toolbox with three tools that share one shell:

- **Code Formatter & Beautifier** — paste code, pick a language, get clean,
  consistently formatted output, with an optional Minify mode.
- **Text Extractor** — drop a screenshot or paste an image to read the text
  inside it, using OCR (Tesseract) compiled to WebAssembly.
- **Transfer** — send a file directly to another browser over WebRTC. The
  bytes never touch a server; Firebase only coordinates the connection.

Everything runs in the browser. No source and no image is ever uploaded, and
the OCR engine's own assets are self-hosted so recognition works fully offline.

Formatting runs in a Web Worker, so the editor keeps responding while a document
is rewritten, and a newer edit cancels the work in flight instead of queueing
behind it. Pastes larger than 1 MB are held back until you confirm, so one
enormous document cannot tie up the tab. The output sits above a side-by-side
diff of the input and output, so it is obvious what moved.

## Requirements

- **Node.js** 22.18+ (the tests use Node's built-in runner with native
  TypeScript type stripping) — 24 recommended
- **pnpm** 10+ — `npm install -g pnpm` (this repo refuses to install via npm/yarn)

## Commands

```bash
pnpm install          # install dependencies and generate public/tesseract
pnpm dev              # dev server            -> http://localhost:23084
pnpm build            # vendor OCR assets, then build to dist/
pnpm serve            # preview the built app -> http://localhost:23084
pnpm typecheck        # tsc --noEmit
pnpm test             # formatter, diff and OCR preparation tests
pnpm vendor:ocr       # re-download the OCR runtime (pnpm vendor:ocr deu … for a subset)
```

`PORT` and `BASE_PATH` are injected by the host (Replit, Vercel) and are both
optional: locally the app falls back to port `23084` and base `/`. Override them
the usual way, e.g. `PORT=4000 pnpm dev`.

## Layout

```
index.html                 Vite entry document
vite.config.ts             dev server, build output, aliases
vercel.json                deployment: builds `pnpm build`, serves `dist/`
scripts/
  vendor-tesseract.mjs     copies the OCR worker + WASM cores and downloads
                           language data into public/tesseract (gitignored)
public/
  tesseract/               generated OCR runtime: worker, WASM cores, traineddata
src/
  main.tsx                 mounts the app
  App.tsx                  routes only: /, /extract, 404
  index.css                theme tokens and base styles (Tailwind v4)
  components/
    site-header.tsx        tabs, theme toggle
    panel.tsx              the shared panel chrome used by every panel
    error-boundary.tsx     render-error boundary, resettable per route
  pages/
    formatter.tsx          the formatter + beautifier page
    text-extractor.tsx     the screenshot OCR page
    transfer.tsx           the P2P file transfer page
    not-found.tsx          404
  firebase/
    config.ts              app init + isConfigured() (env-driven, optional)
    auth.ts                anonymous sign-in
    database.ts            signaling records + candidate/offer/answer writes
  webrtc/
    types.ts               shared transfer types
    protocol.ts            chunk framing + reassembly (unit-tested)
    peer.ts                RTCPeerConnection wrapper
    sender.ts              file -> DataChannel with backpressure
    receiver.ts            DataChannel -> reassembled Blob
    signaling.ts           sender/receiver orchestration over Firebase
  lib/
    bytes.ts               line/character/byte metrics
    styles.ts              shared button class string
    utils.ts               cn()
    format/
      formatter.ts         language registry + Prettier/WASM/sql-formatter/terser
      format-client.ts     main-thread client for the formatting worker
      format-worker.ts     the worker itself
      diff.ts              line diff used by the diff panel
    ocr/
      ocr.ts               Tesseract client (lazy worker, reused per language)
      ocr-image.ts         screenshot preparation before recognition
```

## Formatting engines

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

## Text extraction

Screenshots are prepared before they reach the engine (`src/lib/ocr/ocr-image.ts`):
small captures are upscaled, dark frames are inverted to ink-on-paper, and a
morphological closing estimates the local background and subtracts it. That last
step is what keeps syntax highlighting from being read as ink — without it,
writing inside a highlighted box comes back as `|` while the surrounding prose
reads perfectly.

Fourteen languages ship with the app (English by default). Images up to 25 MB are
accepted; frames above ~2.5M pixels skip the upscale, and above 40M pixels are
passed to the engine untouched to keep memory bounded.

## Tests

`pnpm test` runs everything under `src/**/*.test.ts` with Node's built-in test
runner: formatter regressions per language, the line diff, the OCR image
preparation, and the transfer protocol — chunk framing, reassembly, and an
end-to-end sender → receiver transfer over a loopback channel.

## Deployment

`vercel.json` builds with `pnpm build` and serves `dist/`, rewriting every path
to `index.html` so client-side routes work. The same settings are mirrored in
`.replit-artifact/artifact.toml` for a Replit deploy.

## Transfer

The **Transfer** tab sends a file browser-to-browser. The sender picks a file
and gets a `…/transfer?t=<id>` link; the receiver opens it and the file streams
over a WebRTC DataChannel. Firebase Realtime Database carries only the
signaling (offer, answer, ICE candidates) and a small session record; the file
bytes never leave the two peers.

A file is sliced into 64 KiB chunks. Each chunk is sent as a binary frame with
an 8-byte offset header, so out-of-order delivery still reassembles correctly
and no bytes take a base64 or JSON detour. Sending pauses when the channel's
buffered amount exceeds 256 KiB (backpressure), progress is reported as bytes
transferred, and either side can cancel mid-flight.

### Setting up Firebase

Transfers are disabled until a Firebase project is wired up. Everything else
in the app works without one. Takes about five minutes:

**1. Create the project.** Go to the [Firebase console](https://console.firebase.google.com/),
click **Add project**, give it a name, and finish the wizard (Analytics is
optional).

**2. Add a web app.** On the project home page click the **Web** icon (`</>`).
Register the app with a nickname — do *not* tick Firebase Hosting, this app
hosts itself. Firebase then shows a `firebaseConfig` block; keep this tab open,
you need its values in step 6.

**3. Turn on Anonymous sign-in.** **Build → Authentication → Get started →
Sign-in method → Anonymous → Enable → Save.** Transfers rely on each browser
getting a throwaway UID; no one has to make an account.

**4. Create the Realtime Database.** **Build → Realtime Database → Create
Database.** Pick a location near you, and start in **locked mode** — the rules
in step 5 open just what is needed. Copy the URL shown above the data tree
(it looks like `https://<project-id>-default-rtdb.firebaseio.com`, and may
carry a region such as `europe-west1`).

**5. Paste in the security rules.** Open the **Rules** tab and replace the
contents with this, then **Publish**:

```json
{
  "rules": {
    "transfers": {
      ".read": "auth != null",
      ".write": "auth != null",
      "$transferId": {
        ".validate": "newData.hasChildren(['ownerUid', 'file', 'status', 'createdAt', 'expiresAt'])"
      }
    }
  }
}
```

This requires a signed-in (anonymous counts) browser and rejects records that
are missing the fields the app writes. It is deliberately permissive about
*which* transfer a signed-in user can touch — the transfer ID is an
unguessable UUID, but anyone holding a link can read it. That is the MVP
trade-off for having no accounts.

**6. Put the values in `.env`.** Copy the template and fill it in:

```bash
cp .env.example .env
```

```bash
VITE_FIREBASE_API_KEY=…                 # from firebaseConfig
VITE_FIREBASE_AUTH_DOMAIN=…             # from firebaseConfig
VITE_FIREBASE_PROJECT_ID=…              # from firebaseConfig
VITE_FIREBASE_DATABASE_URL=…            # the URL you copied in step 4
VITE_FIREBASE_STORAGE_BUCKET=…          # from firebaseConfig
VITE_FIREBASE_MESSAGING_SENDER_ID=…     # from firebaseConfig
VITE_FIREBASE_APP_ID=…                  # from firebaseConfig
```

`.env` is gitignored; `.env.example` documents the keys. Only `VITE_`-prefixed
names reach the browser — that is expected, these values are public. Your
**security rules** are what protect the data, never the API key.

`VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_DATABASE_URL` are the two the app
really cannot run without. The database URL is **not** inferred from the
project ID by the SDK, so an empty or wrong value means every read and write
fails to connect; if you leave it blank the app falls back to
`https://<project-id>-default-rtdb.firebaseio.com`, which is wrong for
non-default regions.

**7. Restart the dev server.** Vite inlines `VITE_*` variables at startup, so
`.env` changes need a fresh `pnpm dev` (and a fresh `pnpm build` for deploys).

**8. Test it.** Open `/transfer`, send `?t=` link to yourself, e.g. from
`localhost:23084` to `127.0.0.1:23084` — WebRTC needs HTTPS or `localhost`,
and two tabs of the same build work fine. Pick a file, copy the share link,
open it in the second tab, and the download starts on its own. If transfers
report as disabled, check the browser console: an unconfigured or invalid
project logs the reason there.

Optional `VITE_WEBRTC_STUN`, `VITE_WEBRTC_TURN_URL`,
`VITE_WEBRTC_TURN_USERNAME` and `VITE_WEBRTC_TURN_CREDENTIAL` override the
default Google STUN server and add a TURN relay. A TURN relay is only needed
when both peers sit behind symmetric NATs and cannot connect directly.
