import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffLines, type DiffRow } from './diff.ts';

/** Same normalisation the module applies, so expectations line up exactly. */
function toLines(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n?/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n');
}

function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

/** Deterministic PRNG so the randomised cases reproduce exactly. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const shape = (rows: DiffRow[]) => rows.map((row) => `${row.kind}:${row.leftNumber ?? ''}:${row.rightNumber ?? ''}`);

describe('line diff', () => {
  it('reports identical documents as unchanged', () => {
    const result = diffLines('const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 2;');

    assert.equal(result.identical, true);
    assert.equal(result.rows.length, 2);
    assert.equal(result.changed, 0);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.unchanged, 2);
    assert.equal(result.approximate, false);
  });

  it('ignores a difference that is only a trailing newline', () => {
    assert.equal(diffLines('a\n', 'a').identical, true);
    assert.equal(diffLines('a', 'a\n').identical, true);
  });

  it('pairs a rewritten line instead of showing a removal and an addition', () => {
    const result = diffLines('a\nb\nc', 'a\nx\nc');

    assert.deepEqual(shape(result.rows), ['equal:1:1', 'changed:2:2', 'equal:3:3']);
    assert.equal(result.changed, 1);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.identical, false);
  });

  it('aligns pure insertions on the right', () => {
    const result = diffLines('a\nb', 'a\nb\nc');

    assert.deepEqual(shape(result.rows), ['equal:1:1', 'equal:2:2', 'added::3']);
    assert.equal(result.added, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.changed, 0);
  });

  it('aligns pure removals on the left', () => {
    const result = diffLines('a\nb\nc', 'a\nc');

    assert.deepEqual(shape(result.rows), ['equal:1:1', 'removed:2:', 'equal:3:2']);
    assert.equal(result.removed, 1);
    assert.equal(result.added, 0);
    assert.equal(result.rows[1].right, null);
    assert.equal(result.rows[1].left, 'b');
  });

  it('pairs surplus deletions and additions after the common rows', () => {
    const result = diffLines('a\nb\nc', 'a\nx\ny\nz');

    // 'a' matches; then the whole tail is replaced. Three insertions are paired
    // with the two deletions, leaving one pure addition.
    assert.deepEqual(shape(result.rows), [
      'equal:1:1',
      'changed:2:2',
      'changed:3:3',
      'added::4',
    ]);
    assert.equal(result.added, 1);
    assert.equal(result.changed, 2);
    assert.equal(result.removed, 0);
  });

  it('handles empty inputs', () => {
    assert.equal(diffLines('', '').identical, true);
    assert.equal(diffLines('', 'a\nb').added, 2);
    assert.equal(diffLines('a\nb', '').removed, 2);
    assert.deepEqual(shape(diffLines('', 'a').rows), ['added::1']);
    assert.deepEqual(shape(diffLines('a', '').rows), ['removed:1:']);
  });

  it('normalises CRLF line endings', () => {
    const result = diffLines('a\r\nb\r\n', 'a\nb');

    assert.equal(result.identical, true);
    assert.equal(result.rows.length, 2);
  });

  it('only diffs the middle when a long prefix and suffix match', () => {
    const shared = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const result = diffLines(`${shared}\nold`, `${shared}\nnew`);

    assert.equal(result.unchanged, 50);
    assert.equal(result.changed, 1);
    assert.equal(result.rows.length, 51);
  });

  it('flags an oversized middle and still pairs it as a replaced block', () => {
    // 1001 × 1001 cells exceeds the 1,000,000-cell cap for exact alignment.
    const before = Array.from({ length: 1001 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 1001 }, (_, i) => `new ${i}`).join('\n');
    const result = diffLines(before, after);

    assert.equal(result.approximate, true);
    assert.equal(result.changed, 1001);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.rows.length, 1001);
  });

  it('stays exact for a large document with only a few changes', () => {
    // The formatter case: many shared lines, small real difference.
    const before = Array.from({ length: 900 }, (_, i) => `line ${i};`).join('\n');
    const after = before.replace('line 400;', 'line 400 ;').replace('line 700;', 'line 700 ;');
    const result = diffLines(before, after);

    assert.equal(result.approximate, false);
    assert.equal(result.changed, 2);
    assert.equal(result.unchanged, 898);
  });

  it('is faithful and minimal across randomised inputs', () => {
    const random = rng(20261001);
    const alphabet = ['a', 'b', 'c', '    x = 1;', '', '}'];

    for (let trial = 0; trial < 300; trial += 1) {
      const beforeText = Array.from({ length: Math.floor(random() * 7) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('\n');
      const afterText = Array.from({ length: Math.floor(random() * 7) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('\n');
      const label = JSON.stringify([beforeText, afterText]);

      const expectedLeft = toLines(beforeText);
      const expectedRight = toLines(afterText);
      const result = diffLines(beforeText, afterText);

      // Nothing may be lost, duplicated or reordered on either side.
      assert.deepEqual(result.rows.filter((r) => r.left !== null).map((r) => r.left), expectedLeft, `left rebuilt for ${label}`);
      assert.deepEqual(result.rows.filter((r) => r.right !== null).map((r) => r.right), expectedRight, `right rebuilt for ${label}`);

      // And the row counts must add up to a minimal edit script.
      const deletions = result.removed + result.changed;
      const insertions = result.added + result.changed;
      const minimal = expectedLeft.length + expectedRight.length - 2 * lcsLength(expectedLeft, expectedRight);
      assert.equal(deletions + insertions, minimal, `minimal for ${label}`);

      // Line numbers must stay 1-based and contiguous on each side.
      const leftNumbers = result.rows.filter((r) => r.leftNumber !== null).map((r) => r.leftNumber);
      const rightNumbers = result.rows.filter((r) => r.rightNumber !== null).map((r) => r.rightNumber);
      assert.deepEqual(leftNumbers, expectedLeft.map((_, i) => i + 1), `left numbering for ${label}`);
      assert.deepEqual(rightNumbers, expectedRight.map((_, i) => i + 1), `right numbering for ${label}`);
    }
  });
});
