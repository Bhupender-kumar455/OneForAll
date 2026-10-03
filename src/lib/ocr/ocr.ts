/**
 * Main-thread client for the Tesseract.js OCR engine.
 *
 * Shaped like `FormatterClient` on purpose: the heavy engine (Tesseract
 * compiled to WebAssembly) is created lazily, reused across images while the
 * language is unchanged, and torn down explicitly. Tesseract spawns and owns
 * its own Web Worker, so recognition never blocks the UI thread.
 *
 * Privacy note: the image itself is never uploaded. The engine's own assets
 * (worker script, WASM core, per-language traineddata) are self-hosted under
 * `public/tesseract` — see `scripts/vendor-tesseract.mjs` — so recognition runs
 * without contacting any third party and works fully offline.
 */
import * as Tesseract from 'tesseract.js';

import {
  backgroundRadiusFor,
  MAX_PREPARED_PIXELS,
  planScale,
  preparePixels,
  shouldPrepare,
} from './ocr-image';

/**
 * Where the vendored Tesseract runtime lives. Prefixed with Vite's base URL so
 * it resolves correctly when the app is served from a sub-path.
 */
const TESSERACT_ASSETS = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/tesseract`;
const assetPath = (path: string): string => `${TESSERACT_ASSETS}/${path}`;

/** A stage of recognition, reported for progress display. */
export interface OcrProgress {
  /** Raw Tesseract stage name, e.g. `"recognizing text"`. */
  status: string;
  /** Completion of the current stage, 0..1. */
  progress: number;
}

export interface OcrResult {
  text: string;
  /** Mean confidence across recognized words, 0..100. */
  confidence: number;
}

/**
 * Decodes the image, then upscales and normalises it into a canvas the engine
 * can actually read — see `preparePixels` for why that is necessary.
 *
 * Returns `null` when the frame cannot be prepared (no 2D context, or a decode
 * or size failure), so the caller can hand the original image over instead of
 * failing a recognition that might still work.
 */
async function prepareCanvas(image: Blob | File): Promise<HTMLCanvasElement | null> {
  let source: ImageBitmap | HTMLImageElement | null = null;
  try {
    source = await createImageBitmap(image);
  } catch {
    source = null;
  }

  let objectUrl: string | null = null;
  if (!source) {
    try {
      objectUrl = URL.createObjectURL(image);
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Image could not be decoded'));
        element.src = objectUrl as string;
      });
    } catch {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return null;
    }
  }

  try {
    if (!shouldPrepare(source.width, source.height)) return null;
    const scale = planScale(source.width, source.height, MAX_PREPARED_PIXELS);
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);

    // `preparePixels` rewrites the frame in place, so the ImageData read here is
    // also what gets written back — no second multi-megabyte allocation.
    const frame = context.getImageData(0, 0, width, height);
    preparePixels(frame, { backgroundRadius: backgroundRadiusFor(scale) });
    context.putImageData(frame, 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    if (source && 'close' in source) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export class OcrClient {
  private worker: Tesseract.Worker | null = null;
  private language: string | null = null;
  private onProgress: ((progress: OcrProgress) => void) | undefined;

  /** Registers the callback invoked as each recognition stage advances. */
  setProgressHandler(handler: ((progress: OcrProgress) => void) | undefined): void {
    this.onProgress = handler;
  }

  /**
   * Returns a worker for `language`, reusing the existing one when the language
   * has not changed. Switching language terminates the old worker, which frees
   * the previously loaded traineddata rather than keeping both resident.
   */
  private async ensureWorker(language: string): Promise<Tesseract.Worker> {
    if (this.worker && this.language === language) return this.worker;

    await this.dispose();
    this.language = language;

    const worker = await Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, {
      workerPath: assetPath('worker.min.js'),
      // A directory, not a file: Tesseract appends the core build matching the
      // browser's SIMD support. All three LSTM variants are vendored.
      corePath: assetPath('core'),
      langPath: assetPath('lang'),
      // Same-origin script, so spawn it directly rather than through a blob URL,
      // which also keeps it working under a strict Content-Security-Policy.
      workerBlobURL: false,
      logger: (message) => {
        this.onProgress?.({ status: message.status, progress: message.progress });
      },
    });

    // Keeping inter-word spacing is what preserves indentation in screenshots
    // of code, which matters more here than for prose.
    await worker.setParameters({ preserve_interword_spaces: '1' });

    this.worker = worker;
    return worker;
  }

  async recognize(image: Blob | File, language: string): Promise<OcrResult> {
    const worker = await this.ensureWorker(language);
    const prepared = await prepareCanvas(image);
    const { data } = await worker.recognize(prepared ?? image);
    return { text: data.text, confidence: data.confidence };
  }

  /** Releases the worker and the memory its language data occupies. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.language = null;
    if (worker) await worker.terminate();
  }
}
