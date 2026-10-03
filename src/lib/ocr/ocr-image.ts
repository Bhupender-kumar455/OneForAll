/**
 * Screenshot preparation for the OCR engine.
 *
 * Tesseract expects a scanned page: dark ink on light, evenly lit paper.
 * Screenshots are the opposite — light text on a dark canvas, plus syntax
 * highlighting drawn as mid-grey boxes behind coloured text. Its global Otsu
 * binariser splits the whole frame at one threshold, so a highlight box is
 * darker than the glyphs inside it and the *box* becomes ink: `Code` inside a
 * highlighted span comes back as `|`, file names as noise, while the mean
 * confidence stays around 85% because the rest of the frame read cleanly.
 *
 * Two local steps fix that, so one highlight box can never affect the rest of
 * the frame:
 *
 *  1. Polarity — a dark frame is inverted, so ink is dark and paper is light.
 *  2. Flat-field — a piecewise-constant background is estimated and subtracted,
 *     which collapses a box's grey and the page's black to the same level and
 *     leaves only the glyphs as contrast. A gain then stretches that deviation.
 *
 * The background comes from a morphological closing (dilate then erode), the
 * document-scanning "rolling ball": it fills in thin dark strokes, so what is
 * left is the paper — the page's black outside a box, the box's grey inside it.
 * A blur would be easier to write, but averaging a box together with the page
 * around it produces a halo along the box's edge and washes out its interior;
 * Tesseract then reads that halo as a `|` and the glyphs as noise. Closing has
 * no such halo: the box keeps its own level right up to its edge.
 *
 * Its radius only has to clear a glyph stroke, so it stays anchored to stroke
 * width rather than to image or box size, and the same radius keeps working
 * whether the screenshot holds 8px or 13px text. It also has to stay well below
 * the height of a highlight box, or the closing erases the box as well and the
 * box turns back into a block of ink.
 *
 * Output stays greyscale instead of hard-thresholded: Tesseract's own binariser
 * handles a clean bimodal histogram better than an early lossy threshold, and
 * anti-aliased edges keep thin glyphs readable.
 */

/** Structural subset of `ImageData`, so this module also runs under Node tests. */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PrepareOptions {
  /**
   * Contrast multiplier applied to the deviation from the local background.
   * 1 leaves the image as-is; higher values separate faint text from its
   * background at the cost of amplifying noise.
   */
  gain?: number;
  /**
   * Radius of the closing used to estimate the background, in pixels: wide
   * enough to erase a glyph stroke, and narrow enough to leave a highlight box
   * standing as background.
   */
  backgroundRadius?: number;
  /** Below this mean luminance (0..255) the frame is treated as inverted. */
  darkThreshold?: number;
}

export interface ResolvedPrepareOptions {
  gain: number;
  backgroundRadius: number;
  darkThreshold: number;
}

export const PREPARE_DEFAULTS: ResolvedPrepareOptions = {
  gain: 1.6,
  // About 1.5× a glyph stroke: enough to erase it, and far below the height of
  // the highlight boxes that have to survive as background.
  backgroundRadius: 4,
  darkThreshold: 128,
};

/**
 * Largest frame worth preparing. 2× a 1920×1080 screenshot lands just under it,
 * which covers the common case; larger captures go through at 1× instead of
 * spending seconds and hundreds of megabytes on preparation.
 */
export const MAX_PREPARED_PIXELS = 10_000_000;

/**
 * Frames bigger than this are handed to the engine untouched. They are camera
 * photos far more often than screenshots, they already hold text far larger
 * than Tesseract's comfort zone, and normalising one would allocate hundreds of
 * megabytes for no accuracy gain.
 */
export const MAX_DECODED_PIXELS = 40_000_000;

/** Whether a frame is small enough to be worth preparing. */
export function shouldPrepare(
  width: number,
  height: number,
  maxPixels: number = MAX_DECODED_PIXELS,
): boolean {
  return width > 0 && height > 0 && width * height <= maxPixels;
}

/**
 * How much to upscale before recognition. Tesseract's LSTM is trained on glyphs
 * around 30px tall, while screenshot text is 8–13px, so doubling is where the
 * accuracy comes from — it was worth 9/9 correct key tokens against 2/9 in the
 * screenshots this was measured on. Tripling measured no better and sometimes
 * worse, so the budget either allows the double or leaves the frame alone.
 */
export function planScale(
  width: number,
  height: number,
  maxPixels: number = MAX_PREPARED_PIXELS,
): number {
  if (width <= 0 || height <= 0) return 1;
  return width * 2 * height * 2 <= maxPixels ? 2 : 1;
}

/**
 * Background radius for a frame upscaled by `scale`. Strokes grow with the
 * upscale — a 13px glyph has ~1.5px strokes, and 2× puts them near 3px — so the
 * radius that clears them grows with it too.
 */
export function backgroundRadiusFor(scale: number): number {
  return Math.max(2, Math.round(1.5 * scale));
}

/** Rec. 601 luma, the weights Tesseract itself uses for greyscale. */
function luminance(data: Uint8ClampedArray, index: number): number {
  return (77 * data[index] + 150 * data[index + 1] + 29 * data[index + 2]) >> 8;
}

/**
 * Sliding-window maximum (or minimum) along one axis, edge-clamped, in O(1) per
 * pixel via a monotonic deque. Both passes of the closing are this same routine.
 */
function slidingExtreme(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  peak: boolean,
): void {
  const lineLength = horizontal ? width : height;
  const lineCount = horizontal ? height : width;
  const step = horizontal ? 1 : width;
  const lineStep = horizontal ? width : 1;
  const deque = new Int32Array(lineLength);

  for (let line = 0; line < lineCount; line += 1) {
    const base = line * lineStep;
    let head = 0;
    let tail = 0;
    let pushed = -1;

    for (let position = 0; position < lineLength; position += 1) {
      const entering = Math.min(lineLength - 1, position + radius);
      if (entering > pushed) {
        const value = source[base + entering * step];
        while (tail > head) {
          const last = source[base + deque[tail - 1] * step];
          if (peak ? last < value : last > value) tail -= 1;
          else break;
        }
        deque[tail] = entering;
        tail += 1;
        pushed = entering;
      }

      if (head < tail && deque[head] < position - radius) head += 1;
      target[base + position * step] = source[base + deque[head] * step];
    }
  }
}

/**
 * Morphological closing of `gray` — the level a document scanner would call
 * paper: strokes are filled in, highlight boxes and page backgrounds are not.
 * The two buffers are ping-ponged so a multi-megapixel frame costs two arrays
 * rather than four.
 */
function backgroundLevels(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const scratch = new Uint8ClampedArray(gray.length);
  const closed = new Uint8ClampedArray(gray.length);

  slidingExtreme(gray, closed, width, height, radius, true, true);
  slidingExtreme(closed, scratch, width, height, radius, false, true);
  slidingExtreme(scratch, closed, width, height, radius, true, false);
  slidingExtreme(closed, scratch, width, height, radius, false, false);
  return scratch;
}

/** Mean luminance, sampled sparsely — polarity needs no precision. */
function meanLuminance(data: Uint8ClampedArray, pixels: number): number {
  const step = pixels > 250_000 ? 7 : 1;
  let sum = 0;
  let seen = 0;
  for (let index = 0; index < pixels; index += step) {
    sum += luminance(data, index * 4);
    seen += 1;
  }
  return seen === 0 ? 0 : sum / seen;
}

/**
 * Rewrites a screenshot as evenly lit, ink-on-paper greyscale. The buffer is
 * rewritten in place, so a multi-megapixel frame is never copied twice.
 */
export function preparePixels(
  image: PixelBuffer,
  options: PrepareOptions = {},
): PixelBuffer {
  // Resolved individually: a caller that passes only one knob must not wipe the
  // others (a spread would, and an explicit `undefined` would poison the maths).
  const gain = options.gain ?? PREPARE_DEFAULTS.gain;
  const backgroundRadius =
    options.backgroundRadius ?? PREPARE_DEFAULTS.backgroundRadius;
  const darkThreshold =
    options.darkThreshold ?? PREPARE_DEFAULTS.darkThreshold;
  const { width, height } = image;
  const pixels = width * height;
  if (pixels <= 0) return image;

  const gray = new Uint8ClampedArray(pixels);
  const invert = meanLuminance(image.data, pixels) < darkThreshold;
  for (let index = 0; index < pixels; index += 1) {
    const value = luminance(image.data, index * 4);
    gray[index] = invert ? 255 - value : value;
  }

  const radius = Math.max(
    1,
    Math.min(
      Math.round(backgroundRadius),
      Math.floor(Math.min(width, height) / 3),
    ),
  );
  const background = backgroundLevels(gray, width, height, radius);

  const data = image.data;
  for (let index = 0; index < pixels; index += 1) {
    const value = 128 + gain * (gray[index] - background[index]);
    const clamped = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
    const offset = index * 4;
    data[offset] = clamped;
    data[offset + 1] = clamped;
    data[offset + 2] = clamped;
    data[offset + 3] = 255;
  }
  return image;
}
