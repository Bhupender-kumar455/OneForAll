import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_DECODED_PIXELS,
  MAX_PREPARED_PIXELS,
  backgroundRadiusFor,
  planScale,
  preparePixels,
  shouldPrepare,
  type PixelBuffer,
} from './ocr-image.ts';

/**
 * Regression tests for screenshot preparation. They pin the failure this module
 * exists for: Tesseract's single global threshold turns a syntax-highlighting
 * box into a block of ink, so the glyphs inside it are read as noise. Everything
 * here works on synthetic frames, which is the only way to assert *pixels* and
 * not just "some text came back".
 *
 * Run with `pnpm test` from this package.
 */

/** Fills a frame with `level` everywhere, then lets `paint` draw into it. */
function frame(
  width: number,
  height: number,
  level: number,
  paint?: (set: (x: number, y: number, level: number) => void) => void,
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = level;
    data[index * 4 + 1] = level;
    data[index * 4 + 2] = level;
    data[index * 4 + 3] = 255;
  }
  const image = { data, width, height };
  paint?.((x, y, value) => {
    const offset = (y * width + x) * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
  });
  return image;
}

const grey = (image: PixelBuffer, x: number, y: number) =>
  image.data[(y * image.width + x) * 4];

/** Mean level of a horizontal run, used to compare regions rather than pixels. */
function mean(image: PixelBuffer, y: number, fromX: number, toX: number): number {
  let total = 0;
  for (let x = fromX; x < toX; x += 1) total += grey(image, x, y);
  return total / (toX - fromX);
}

/** Vertical strokes of light text on a dark page. */
const strokes = (columns: number[]) => (set: (x: number, y: number, v: number) => void) => {
  for (let y = 4; y < 10; y += 1) {
    for (const x of columns) set(x, y, 210);
  }
};

describe('planScale', () => {
  it('doubles a frame that fits the budget', () => {
    assert.equal(planScale(900, 260), 2);
    assert.equal(planScale(1920, 1080), 2);
    assert.equal(planScale(120, 40), 2);
  });

  it('leaves a frame alone once doubling would not fit', () => {
    assert.equal(planScale(3840, 2160), 1);
    assert.equal(planScale(2560, 1440), 1);
  });

  it('treats the budget as the exact cutoff', () => {
    const width = 2500;
    const height = MAX_PREPARED_PIXELS / 4 / width;
    assert.equal(planScale(width, height), 2);
    assert.equal(planScale(width + 1, height), 1);
  });

  it('survives degenerate sizes', () => {
    assert.equal(planScale(0, 100), 1);
    assert.equal(planScale(100, 0), 1);
    assert.equal(planScale(-4, -4), 1);
  });
});

describe('shouldPrepare', () => {
  it('prepares anything up to the decoded ceiling', () => {
    assert.equal(shouldPrepare(1920, 1080), true);
    assert.equal(shouldPrepare(8000, 5000), true);
  });

  it('refuses frames whose normalisation would cost more than it buys', () => {
    assert.equal(shouldPrepare(10000, 10000), false);
    assert.equal(shouldPrepare(3100, 10, 30_000), false);
  });

  it('refuses degenerate frames', () => {
    assert.equal(shouldPrepare(0, 10), false);
    assert.equal(shouldPrepare(10, -1), false);
  });
});

describe('backgroundRadiusFor', () => {
  it('grows with the upscale so it keeps clearing a stroke', () => {
    assert.equal(backgroundRadiusFor(1), 2);
    assert.equal(backgroundRadiusFor(2), 3);
    assert.equal(backgroundRadiusFor(4), 6);
  });
});

describe('preparePixels', () => {
  it('turns light text on a dark page into ink on paper', () => {
    const image = frame(40, 14, 20, strokes([10, 11, 20, 21, 22]));
    preparePixels(image, { backgroundRadius: 2 });

    assert.ok(mean(image, 7, 10, 12) < 64, 'strokes stay ink');
    assert.ok(mean(image, 1, 4, 36) > 96, 'the page stays paper');
  });

  it('does not turn a highlight box into ink', () => {
    // The reported bug: grey box, coloured text inside it, on a black page.
    const image = frame(60, 16, 20, (set) => {
      for (let y = 4; y < 14; y += 1) {
        for (let x = 12; x < 34; x += 1) set(x, y, 90);
      }
      for (let y = 6; y < 12; y += 1) {
        for (const x of [15, 16, 22, 23, 29, 30]) set(x, y, 150);
      }
    });
    preparePixels(image, { backgroundRadius: 2 });

    const box = mean(image, 8, 12, 34);
    const glyph = mean(image, 8, 15, 17);
    assert.ok(box > 96, `the box reads as background, not ink (got ${box})`);
    assert.ok(glyph < 64, `the text inside the box stays ink (got ${glyph})`);
    assert.ok(box > glyph, 'the box must not be darker than the text it holds');
  });

  it('keeps soft, blurred ink readable', () => {
    // A resized or out-of-focus screenshot: the stroke never reaches full ink.
    const image = frame(40, 14, 240, (set) => {
      for (let y = 4; y < 10; y += 1) {
        for (let x = 17; x < 23; x += 1) {
          const depth = 240 - (1 - Math.abs(x - 19.5) / 3) * 70;
          set(x, y, Math.round(depth));
        }
      }
    });
    preparePixels(image, { backgroundRadius: 2 });

    assert.ok(mean(image, 7, 18, 22) < 96, 'the faint stroke survives as ink');
    assert.ok(mean(image, 1, 4, 36) > 96, 'the paper stays paper');
  });

  it('stays finite when only some options are given', () => {
    // Guards a real bug: a spread of `{ ...defaults, ...options }` let an
    // explicitly undefined knob reach the arithmetic, which wrote black.
    const image = frame(20, 8, 200, strokes([5, 6]));
    preparePixels(image, { backgroundRadius: 2 });

    for (let index = 0; index < image.width * image.height; index += 1) {
      const value = image.data[index * 4];
      assert.ok(Number.isFinite(value), 'every output value is a number');
    }
    assert.ok(mean(image, 1, 0, 20) > 96, 'a defaulted gain still leaves paper');
  });

  it('leaves a frame with nothing on it alone', () => {
    const image = frame(24, 10, 245);
    preparePixels(image, { backgroundRadius: 2 });

    for (let index = 0; index < image.width * image.height; index += 1) {
      assert.equal(image.data[index * 4], 128, 'flat paper maps to the midpoint');
      assert.equal(image.data[index * 4 + 3], 255, 'output stays opaque');
    }
  });

  it('ignores degenerate frames instead of throwing', () => {
    const empty = { data: new Uint8ClampedArray(0), width: 0, height: 0 };
    assert.equal(preparePixels(empty), empty);

    const zeroWidth = { data: new Uint8ClampedArray(4), width: 0, height: 1 };
    assert.equal(preparePixels(zeroWidth), zeroWidth);
  });
});
