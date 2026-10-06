# Performance review — Code Compact / OneForAll

Measured on the current HEAD (`7519fa9`) against a **production build** (`pnpm build` →
served with `vite preview`), not the dev server, so the numbers include real chunking,
minification and gzip.

Everything below is either a **measured** number (browser `performance` entries, an A/B
run, or a micro-benchmark) or explicitly labelled **estimate**. Clean-room sizes come from
bundling the same imports with esbuild (`--bundle --minify`) and gzipping the result.

**Measurement caveats.** Sizes are gzip; Vercel serves brotli, so real-world transfer is
roughly 10–15 % smaller than the numbers here. This machine was under load (load average
~3) for part of the session, so wall-clock timings are upper bounds, and two long-running
probes hit Chromium's background-tab throttling — flagged inline where it matters.

---

## 1. Baseline: what a user actually pays

### First load (formatter route, cold cache)

| Resource | Raw | gzip | Notes |
| --- | --- | --- | --- |
| `index-*.js` (entry) | 540 kB | **167 kB** | React, wouter, lucide, **all three pages**, **Firebase SDK**, WebRTC |
| `index-*.css` | 26 kB | 6 kB | Tailwind output |
| Google Fonts CSS | 834 B | — | third-party, chained |
| Geist woff2 | 29.4 kB | — | only after the Google CSS resolves |
| Geist Mono woff2 | 23.1 kB | — | same |
| **Page-level total** | | **~180 kB + 53 kB of fonts** | first contentful paint **388 ms** on loopback |

The entry chunk was verified to contain the Firebase SDK (`firebaseio`, `identitytoolkit`,
`googleapis`) and the whole WebRTC transfer module (`RTCPeerConnection`, `shareUrl`,
`stun:`), because `App.tsx` statically imports all three pages.

Clean-room weights of the same libraries (esbuild, minify + gzip):

| Library | Raw | gzip |
| --- | --- | --- |
| firebase (`app` + `auth` + `database`, only the functions used) | 281 kB | **74 kB** |
| react + react-dom/client + wouter | 192 kB | 60 kB |
| prettier/standalone + babel + estree | 614 kB | 170 kB |

So **Firebase is ~44 % of the initial bundle** for visitors who only want the formatter.

### First format (the default JavaScript example, on mount)

The page auto-formats the sample 200 ms after mount, so every visitor also pulls
Prettier's module graph inside the worker (worker-side fetches don't show in page timing):

| Chunk | gzip |
| --- | --- |
| `main-*.js` (Prettier core, shared by all plugins) | 140 kB |
| `babel-*.js` | 82 kB |
| `estree-*.js` | 61 kB |
| **Total for one JS format** | **~284 kB** |

TypeScript instead of JavaScript costs 125 kB + 61 kB + 140 kB ≈ 326 kB.

### OCR (Text Extractor)

| Measurement | Result |
| --- | --- |
| 2560×1440 dark screenshot, engine cold (fresh mount, assets HTTP-cached) | **2,483 ms** |
| Same image, engine warm | **1,914 ms** |
| 3840×2160 (8.3 MP), warm | **2,616 ms**, with two **105 ms long tasks** |
| Assets fetched on first OCR | 3.9 MB core + 2.95 MB `eng.traineddata.gz` + 111 kB worker ≈ **7 MB** |
| Shipped but never fetched at load | 25 MB of language data (14 languages), 12 MB of WASM cores |

Recognition dominates (~1.9 s) and it is correctly off the main thread. The long tasks are
the main-thread screenshot preparation (`preparePixels`) at 8.3 MP — see F5.

### Transfer route

Opening `/transfer` adds **no extra JavaScript** (it is already in the entry chunk) but
triggers anonymous auth + the Realtime Database socket:

| Request | Duration (loopback + real Firebase) |
| --- | --- |
| `identitytoolkit …/accounts:signUp` | 1,038 ms |
| `identitytoolkit …/accounts:lookup` | 813 ms |

Previously verified in this project: 300 MB transfer → **9 MB heap growth**, integrity
verified per chunk on the receiving side (no whole-file digest pass, on either end).

### Build / test loop (developer cost)

`typecheck` 0, `test` 118/118 in 1.3 s, `build` 11.7 s, `dist` **44 MB** (36 MB of which is
the gitignored, build-generated `public/tesseract`).

---

## 2. Findings, ranked by impact

### F1 — The diff panel renders every row: the single biggest performance problem

`formatter.tsx` maps `diff.rows` straight to DOM with no windowing.

| Input | Diff rows | DOM nodes | Time to formatted output |
| --- | --- | --- | --- |
| 612 kB, **already formatted** (identical → placeholder, no rows) | 0 | **297** | **397 ms** |
| 415 kB, every line changes | ~10,000 | **245,305** | **4,806 ms** |
| 83 kB, every line changes | 7,000 | 49,305 | (see below) |

Both runs include the same 200 ms debounce, and the identical-size A/B isolates the diff:
Prettier's own work on 612 kB is only ~150–200 ms.

A micro-benchmark that builds the **same row markup** (7,000 rows / 49,000 nodes) outside
React measures the browser cost directly:

```
domBuild_ms: 237
firstLayout_ms: 1196      ← pure layout, per 7,000 rows (~170 µs/row)
total_ms: 1432
```

That is linear in output size, entirely on the main thread, and it is why the guard's
`MAX_FORMAT_BYTES = 1 MB` threshold no longer describes where the app breaks down: the
damage starts an order of magnitude earlier (~100 kB). During this session, tabs holding a
7k–14k-row diff stopped answering synchronous probes for >10 s at a time (exact wall-clock
duration not isolated here — the tab was backgrounded and the machine loaded), while an
identical 49k-node tab answered instantly.

**Fix (highest value, bounded effort).** Window the diff: render only the visible rows
(~50) inside the existing `max-h-[60vh]` scroller with a spacer for total height. That is
`245,305 → ~350` nodes for the 5k-line case and removes essentially all of the 4.4 s
difference. Cheap alternatives if windowing is too invasive: collapse the diff past N
changed regions ("show all"), or make the diff opt-in for inputs above ~50 kB.

### F2 — Route-level code splitting: Firebase ships to everyone

The entry chunk is 167 kB gzip and contains all three tools. A formatter-only visitor
downloads ~74 kB gzip of Firebase that is unreachable from the page they are on.

**Fix.** `React.lazy` the three pages in `App.tsx`, and import the Firebase modules
dynamically inside the transfer module so nothing Firebase-shaped is in the initial graph.
Expected: initial JS drops to roughly **100–110 kB gzip** (React + icons + shell + whichever
page is open), Firebase loads only on `/transfer`. Add `<link rel="modulepreload">` for the
entry to keep the split from delaying first paint.

### F3 — Prettier is fetched on first paint to format a hard-coded sample

The sample output could be a constant string, but the current flow launches the worker and
pulls ~284 kB gzip because the example is JavaScript.

**Fix.** Ship the example's formatted output as a literal so the default view needs no
engine, and load Prettier on the first real edit or file load (`requestIdleCallback`
prefetch afterwards warms it without competing with first paint).

**Related.** `format-client.ts` keeps a main-thread fallback that statically imports the
full formatter, which is why the build contains a **second copy** of Prettier core
(`main-*` 507 kB ×2) and of sql-formatter (`index-*` 293 kB ×2) — ~1.6 MB raw / ~440 kB
gzip of duplicated payload in `dist`. Only one copy is ever fetched (the worker graph), so
this is mostly deploy weight, but the fallback is also a 284 kB+ surprise for the one user
whose CSP blocks workers. Making the fallback `await import('./formatter.ts')` and refusing
to run it above a small size keeps the safety net without the weight.

### F4 — Google Fonts sit on the critical path, in an app that advertises "nothing leaves your browser"

`src/index.css` starts with `@import url('https://fonts.googleapis.com/…')`, so the chain is:
bundled CSS → `fonts.googleapis.com` → two `fonts.gstatic.com` woff2 files (~53 kB). Two
extra origins, an extra round trip after the stylesheet arrives, a third-party request on
every load, and a hard failure offline.

**Fix.** Self-host the two Geist subsets as woff2 in `public/fonts`, reference them with
`@font-face … font-display: swap`, and `<link rel="preload">` the two files that the first
screen uses. Removes ~53 kB of third-party weight, one round trip, and the privacy caveat.

### F5 — OCR screenshot preparation blocks the main thread

Measured two 105 ms long tasks on a 3.7 MP→8.3 MP frame; at the 10 MP `MAX_PREPARED_PIXELS`
cap this is ~250 ms of unresponsive main thread, plus transient allocations of ~4
array-widths of the frame (ImageData 4×N bytes + three `Uint8ClampedArray`s of N).

**Fix.** Move `preparePixels` into a worker driven by `OffscreenCanvas`, transferring the
`ImageData` buffer instead of copying it. Also consider `createImageBitmap(blob, {
resizeWidth, resizeHeight })` so the 2× upscale happens in the decoder and the full-size
frame is never materialised.

### F6 — OCR assets: correct loading strategy, weak cache policy

3.9 MB core + ~1–3 MB traineddata are fetched once per language and reused, which is the
right design. But `worker.min.js`, `core/*.js` and `lang/*.traineddata.gz` are **unhashed
and unversioned** in `public/tesseract`, so a CDN cannot cache them immutably without the
risk of a stale worker after a library upgrade.

**Fix.** Add a version segment or query to the vendored paths (e.g.
`/tesseract/v7/…`, derived from the installed `tesseract.js` version) and declare
`Cache-Control: public, max-age=31536000, immutable` for `/tesseract/core/*` and
`/tesseract/lang/*` in `vercel.json`. Without this, a returning OCR user can re-download
megabytes. Two smaller wins: pre-warm the selected language on idle, and reconsider
shipping all 14 languages (25 MB) by default.

### F7 — Transfer protocol: both upgrades landed

* **Verification no longer re-reads the payload.** `DiskSink.digest()` and the sender's
  up-front `sha256File(file)` are both gone. Each 64 KiB chunk is digested inside the sender's
  read-ahead window and the digest rides in the frame header, so the receiver checks the chunk
  it is about to store and never hashes the finished file. The sender no longer reads its whole
  file before the share link appears, and a failure names one byte offset instead of rejecting
  "the file". Cost: 32 bytes per 64 KiB chunk (0.05%), and a resume re-sends a digest with its
  chunk for free. A Merkle root over the chunk digests was considered and dropped — nothing
  needs a whole-file commitment, since the digest travels with the bytes it describes.
* **Backpressure polling.** Settled: the sender sets `bufferedAmountLowThreshold` and waits on
  `bufferedamountlow`, with the 20 ms poll kept only as a safety net and as the drop detector on
  channels that do not expose the event.

### F8 — Guardrails so this does not regress

There is no bundle budget and no automated performance check. Add
`rollup-plugin-visualizer` (or `vite-bundle-visualizer`) plus a `size-limit` entry for the
entry chunk, and a Lighthouse CI run — F2/F3 will otherwise silently regress. Note also that
`pnpm build` downloads 25 MB from jsDelivr when `public/tesseract` is absent, so builds are
network-dependent by design (fine for Vercel, worth knowing for offline work).

### F9 — Small items

* `index.html` sets `maximum-scale=1`, which blocks pinch-zoom (WCAG 1.4.4). Drop it.
* Title/description/OG tags describe only the formatter; update them per route (the SPA
  never changes `document.title`).
* Preconnect to the Realtime Database host when the user opens `/transfer`, rather than on
  every page.
* `robots.txt` exists but there is no `sitemap.xml`.

---

## 3. What else this project could add

Ordered by (value ÷ effort), with the performance work above folded in.

**Transfer (finish the roadmap already chosen)**
1. **Resume / retransmit (#3)** — receiver reports missing offsets, sender resends. Pair it
   with the Merkle-per-chunk verification from F7 so retransmits are provably correct.
2. **TURN diagnostics (#4)** — show candidate types, whether a relay was used, RTT and
   throughput, and surface a clear "your networks block direct connections" message.
3. **QR code for the share link** — the link is meant for a second device; typing it is the
   real friction on mobile.
4. **Speed + ETA** in the progress UI (bytes are already counted).
5. **Compression before sending** (`CompressionStream('gzip')`) for text-like payloads —
   meaningful for code, which is exactly what this app produces.
6. **Send the formatter's output straight to a peer** — a "Send to device" button that opens
   the transfer flow with the formatted text as the payload. It ties the three tools into
   one story instead of three separate pages.
7. **Multi-file / folder transfer** (a manifest + per-file framing fits the current
   protocol), and a "copy link again" recovery affordance on both sides.

**Formatter**
8. **Virtualized editors with line numbers** — the diff fix (F1) and windowed input/output
   rendering are the same problem; solving it once helps all three panels.
9. **Shareable permalink** — LZ-compress the source into the URL hash; no server involved,
   consistent with the local-first promise.
10. **Recent snippets** in `localStorage`, plus a format-on-paste toggle for people who paste
    multi-hundred-kilobyte files and do not want an automatic run.
11. **Native fast paths for the common cases** (JSON, CSS): the hand-rolled printers already
    exist and are ~10× cheaper than loading a 76–140 kB Prettier plugin for a one-line JSON.

**Extractor**
12. **Multiple languages at once** (Tesseract supports `eng+hin`), and **PDF input** via
    pdf.js with per-page OCR in parallel workers.
13. **Region crop** before recognition, and **table → Markdown/CSV** output.
14. **Batch queue** of images with a single copy step, and a one-click "send to formatter".

**Platform**
15. **Installable PWA** — offline shell, `Cache Storage` for the OCR packs and worker
    chunks, so the "works offline" claim survives a reload without network.
16. **Bundle-budget + Lighthouse CI** (F8) and an **opt-in error/telemetry** channel that
    respects the local-first promise.
17. **i18n** and an accessibility pass (zoom, focus order, `aria-live` for OCR/transfer
    progress).
18. **Playwright coverage for the browser-only paths** — `DiskSink` (OPFS) and the two-tab
    transfer have no automated tests today, which is exactly how two live-transfer bugs
    escaped the 118-test suite.

---

## 4. Suggested order of work

| # | Item | Why first | Rough size |
| --- | --- | --- | --- |
| 1 | Window the diff (F1) | Removes second-scale main-thread stalls at ~100 kB inputs | one component |
| 2 | Route splitting + lazy Firebase (F2) | ~40 % off the initial bundle for every visitor | small |
| 3 | Don't format the sample on mount (F3) | Removes ~284 kB gzip from first paint | small |
| 4 | Self-host fonts (F4) | One round trip, two origins, offline-safe | small |
| 5 | Cache headers + versioned OCR assets (F6) | Prevents megabyte re-downloads | config |
| 6 | OffscreenCanvas OCR prep (F5) | Removes ~250 ms of main-thread blocking | medium |
| 7 | Merkle chunks + resume (F7, then #3) | Fixes verification cost and the last protocol gap | medium |
| 8 | Budgets in CI (F8) | Locks in 1–4 | small |
