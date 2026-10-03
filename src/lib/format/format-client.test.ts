import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FormatterClient,
  MAX_FORMAT_BYTES,
  exceedsFormatLimit,
  sourceByteLength,
} from './format-client.ts';
import type { FormatOptions } from './formatter.ts';

const options = (language: FormatOptions['language'] = 'json'): FormatOptions => ({
  language,
  mode: 'format',
  indentWidth: 2,
  useTabs: false,
  printWidth: 80,
});

describe('large-input guard', () => {
  it('measures the input in UTF-8 bytes', () => {
    assert.equal(sourceByteLength(''), 0);
    assert.equal(sourceByteLength('abc'), 3);
    assert.equal(sourceByteLength('é'), 2);
    assert.equal(sourceByteLength('日本'), 6);
  });

  it('trips only above the limit', () => {
    assert.equal(MAX_FORMAT_BYTES, 1_000_000);
    assert.equal(exceedsFormatLimit(0), false);
    assert.equal(exceedsFormatLimit(MAX_FORMAT_BYTES), false);
    assert.equal(exceedsFormatLimit(MAX_FORMAT_BYTES + 1), true);
    // An explicit limit is respected, which keeps the policy testable.
    assert.equal(exceedsFormatLimit(10, 10), false);
    assert.equal(exceedsFormatLimit(11, 10), true);
  });
});

describe('FormatterClient', () => {
  it('skips oversized input unless forced', async () => {
    const client = new FormatterClient();
    const huge = 'x'.repeat(MAX_FORMAT_BYTES + 1);

    const outcome = await client.run(huge, options());

    assert.equal(outcome.status, 'too-large');
    assert.equal(outcome.bytes, MAX_FORMAT_BYTES + 1);
    assert.equal(outcome.output, '');
    client.dispose();
  });

  it('formats oversized input when the user forces it', async () => {
    // A tiny limit stands in for a megabyte so the escape hatch stays cheap to test.
    const client = new FormatterClient(4);

    const skipped = await client.run('{"a":1}', options());
    assert.equal(skipped.status, 'too-large');

    const forced = await client.run('{"a":1}', options(), true);
    assert.equal(forced.status, 'done');
    assert.equal(forced.output, '{\n  "a": 1\n}');
    client.dispose();
  });

  it('formats on the main thread when workers are unavailable', async () => {
    // Node has no Worker global, which is exactly the blocked-worker case.
    const client = new FormatterClient();

    const outcome = await client.run('{"a":1}', options());

    assert.equal(outcome.status, 'done');
    assert.equal(outcome.via, 'main');
    assert.equal(outcome.output, '{\n  "a": 1\n}');
    client.dispose();
  });

  it('cancels the in-flight job when a newer run supersedes it', async () => {
    const client = new FormatterClient();

    const first = client.run('{"a":1}', options());
    const second = client.run('{"b":2}', options());

    assert.equal((await first).status, 'cancelled');

    const outcome = await second;
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.output, '{\n  "b": 2\n}');
    client.dispose();
  });

  it('settles a pending run as cancelled when disposed', async () => {
    const client = new FormatterClient();

    const pending = client.run('{"a":1}', options());
    client.dispose();

    assert.equal((await pending).status, 'cancelled');
  });

  it('reports formatter failures instead of hanging', async () => {
    const client = new FormatterClient();

    const outcome = await client.run('{not valid json', options());

    assert.equal(outcome.status, 'error');
    assert.ok(outcome.error);
    client.dispose();
  });
});
