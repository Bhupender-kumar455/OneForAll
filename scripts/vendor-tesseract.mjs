/**
 * Vendors the Tesseract OCR runtime into `public/tesseract` so recognition works
 * with no network access.
 *
 * Everything Tesseract needs is copied out of the installed packages (the worker
 * and the WASM cores, which must match the library version) except the language
 * data, which is not shipped on npm and is downloaded from jsDelivr once.
 *
 * Usage:
 *   node scripts/vendor-tesseract.mjs                # every supported language
 *   node scripts/vendor-tesseract.mjs eng deu        # only these languages
 *
 * Re-running is safe: existing files are left alone unless --force is passed.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, '..', 'public', 'tesseract');

/** Languages offered by the UI. Keep in sync with `OCR_LANGUAGES`. */
const DEFAULT_LANGUAGES = [
  'eng', 'spa', 'fra', 'deu', 'ita', 'por', 'nld',
  'rus', 'ara', 'hin', 'chi_sim', 'chi_tra', 'jpn', 'kor',
];

/**
 * The OCR engine runs in LSTM-only mode, so only the three `-lstm` core builds
 * are needed. Tesseract picks one at runtime based on the browser's SIMD
 * support, so all three are shipped.
 */
const CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
];

/** jsDelivr path for a language's LSTM-only traineddata. */
const languageUrl = (lang) =>
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;

const force = process.argv.includes('--force');
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const languages = requested.length > 0 ? requested : DEFAULT_LANGUAGES;

const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function copyIfNeeded(source, destination) {
  const existing = await sizeOf(destination);
  if (existing !== null && !force) return existing;
  await copyFile(source, destination);
  return (await stat(destination)).size;
}

async function downloadIfNeeded(url, destination, label) {
  const existing = await sizeOf(destination);
  if (existing !== null && !force) return existing;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${response.status})`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  const size = (await stat(destination)).size;
  console.log(`  downloaded ${label} (${formatMb(size)})`);
  return size;
}

async function main() {
  const tesseractRoot = dirname(require.resolve('tesseract.js/package.json'));
  const coreRoot = dirname(
    require.resolve('tesseract.js-core/package.json', { paths: [tesseractRoot] }),
  );

  await mkdir(join(outputDir, 'core'), { recursive: true });
  await mkdir(join(outputDir, 'lang'), { recursive: true });

  let total = 0;

  console.log('Worker:');
  total += await copyIfNeeded(
    join(tesseractRoot, 'dist', 'worker.min.js'),
    join(outputDir, 'worker.min.js'),
  );

  console.log('WASM cores:');
  for (const file of CORE_FILES) {
    const size = await copyIfNeeded(
      join(coreRoot, file),
      join(outputDir, 'core', file),
    );
    total += size;
    console.log(`  ${file} (${formatMb(size)})`);
  }

  console.log(`Language data (${languages.length}):`);
  for (const lang of languages) {
    total += await downloadIfNeeded(
      languageUrl(lang),
      join(outputDir, 'lang', `${lang}.traineddata.gz`),
      `${lang}.traineddata.gz`,
    );
  }

  console.log(`\nVendored into public/tesseract — ${formatMb(total)} total.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
