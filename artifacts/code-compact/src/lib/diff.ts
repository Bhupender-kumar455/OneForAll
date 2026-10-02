/**
 * Line diffing for the side-by-side view.
 *
 * Formatter output shares long runs with its input, so the common prefix and
 * suffix are trimmed first and the exact LCS only runs on what actually
 * changed. That keeps real diffs small. The quadratic step is additionally
 * capped so a pathological input can never lock up the main thread — past the
 * cap the middle is reported as one replaced block, which is what a diff of
 * "every line changed" looks like anyway.
 */

export type DiffKind = 'equal' | 'added' | 'removed' | 'changed';

export interface DiffRow {
  kind: DiffKind;
  /** 1-based line number in the input, or null when the row only exists on the right. */
  leftNumber: number | null;
  left: string | null;
  rightNumber: number | null;
  right: string | null;
}

export interface DiffResult {
  rows: DiffRow[];
  /** Lines only present in the output. */
  added: number;
  /** Lines only present in the input. */
  removed: number;
  /** Rows where both sides exist but differ. */
  changed: number;
  /** Rows where both sides are identical. */
  unchanged: number;
  identical: boolean;
  /** True when the middle was too large to align exactly. */
  approximate: boolean;
}

/** Cells (n × m) allowed in the LCS table before falling back to a block diff. */
const MAX_LCS_CELLS = 1_000_000;

type Op =
  | { type: 'equal'; left: number; right: number }
  | { type: 'delete'; left: number }
  | { type: 'insert'; right: number };

/** Splits into lines, treating a single trailing newline as a terminator. */
function toLines(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n?/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n');
}

/** Longest-common-subsequence edit script over two line arrays. */
function lcsScript(left: string[], right: string[]): Op[] {
  const n = left.length;
  const m = right.length;
  const stride = m + 1;
  // table[i * stride + j] = LCS length of left[i..] and right[j..]
  const table = new Int32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * stride + j] =
        left[i] === right[j]
          ? table[(i + 1) * stride + (j + 1)] + 1
          : Math.max(table[(i + 1) * stride + j], table[i * stride + (j + 1)]);
    }
  }

  const script: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      script.push({ type: 'equal', left: i, right: j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * stride + j] >= table[i * stride + (j + 1)]) {
      script.push({ type: 'delete', left: i });
      i += 1;
    } else {
      script.push({ type: 'insert', right: j });
      j += 1;
    }
  }
  while (i < n) {
    script.push({ type: 'delete', left: i });
    i += 1;
  }
  while (j < m) {
    script.push({ type: 'insert', right: j });
    j += 1;
  }
  return script;
}

/** Fallback for oversized middles: every old line replaced by the new ones. */
function blockScript(left: string[], right: string[]): Op[] {
  const script: Op[] = [];
  for (let i = 0; i < left.length; i += 1) script.push({ type: 'delete', left: i });
  for (let j = 0; j < right.length; j += 1) script.push({ type: 'insert', right: j });
  return script;
}

/**
 * Turns an edit script into aligned rows. Runs of deletions and insertions are
 * paired positionally so a rewritten block reads as N changed rows rather than
 * a wall of removals followed by a wall of additions.
 */
function rowsFromScript(
  script: Op[],
  left: string[],
  right: string[],
  leftOffset: number,
  rightOffset: number,
): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;

  while (index < script.length) {
    const op = script[index];

    if (op.type === 'equal') {
      rows.push({
        kind: 'equal',
        leftNumber: leftOffset + op.left + 1,
        left: left[op.left],
        rightNumber: rightOffset + op.right + 1,
        right: right[op.right],
      });
      index += 1;
      continue;
    }

    const deletes: number[] = [];
    const inserts: number[] = [];
    while (index < script.length && script[index].type !== 'equal') {
      const current = script[index];
      if (current.type === 'delete') deletes.push(current.left);
      else if (current.type === 'insert') inserts.push(current.right);
      index += 1;
    }

    const pairs = Math.min(deletes.length, inserts.length);
    for (let p = 0; p < pairs; p += 1) {
      rows.push({
        kind: 'changed',
        leftNumber: leftOffset + deletes[p] + 1,
        left: left[deletes[p]],
        rightNumber: rightOffset + inserts[p] + 1,
        right: right[inserts[p]],
      });
    }
    for (let p = pairs; p < deletes.length; p += 1) {
      rows.push({
        kind: 'removed',
        leftNumber: leftOffset + deletes[p] + 1,
        left: left[deletes[p]],
        rightNumber: null,
        right: null,
      });
    }
    for (let p = pairs; p < inserts.length; p += 1) {
      rows.push({
        kind: 'added',
        leftNumber: null,
        left: null,
        rightNumber: rightOffset + inserts[p] + 1,
        right: right[inserts[p]],
      });
    }
  }

  return rows;
}

/** Diffs two documents line by line into side-by-side rows. */
export function diffLines(before: string, after: string): DiffResult {
  const left = toLines(before);
  const right = toLines(after);

  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;

  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }

  const middleLeft = left.slice(start, endLeft);
  const middleRight = right.slice(start, endRight);
  const exact = middleLeft.length * middleRight.length <= MAX_LCS_CELLS;

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) {
    rows.push({ kind: 'equal', leftNumber: i + 1, left: left[i], rightNumber: i + 1, right: right[i] });
  }

  rows.push(
    ...rowsFromScript(
      exact ? lcsScript(middleLeft, middleRight) : blockScript(middleLeft, middleRight),
      middleLeft,
      middleRight,
      start,
      start,
    ),
  );

  const suffix = left.length - endLeft;
  for (let i = 0; i < suffix; i += 1) {
    const l = endLeft + i;
    const r = endRight + i;
    rows.push({ kind: 'equal', leftNumber: l + 1, left: left[l], rightNumber: r + 1, right: right[r] });
  }

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  for (const row of rows) {
    if (row.kind === 'equal') unchanged += 1;
    else if (row.kind === 'added') added += 1;
    else if (row.kind === 'removed') removed += 1;
    else changed += 1;
  }

  return {
    rows,
    added,
    removed,
    changed,
    unchanged,
    identical: added === 0 && removed === 0 && changed === 0,
    approximate: !exact,
  };
}
