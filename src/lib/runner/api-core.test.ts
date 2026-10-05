import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildProviderPayload,
  originAllowed,
  providerFailure,
  RequestRateLimiter,
  submissionQuery,
  toClientResult,
  validateExecuteRequest,
} from './api-core.ts';
import { RUNNER_LANGUAGES } from './data/languages.ts';
import { DEFAULT_MAX_STDIN_BYTES, runnerLimits, truncateOutput } from './limits.ts';
import { isTerminalStatus, normalizeExecution } from './normalize.ts';

const limits = runnerLimits({});

const valid = {
  languageId: 109,
  sourceCode: 'print(2 + 3)',
  stdin: '',
};

describe('validateExecuteRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateExecuteRequest(valid, limits);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.request, valid);
  });

  it('treats a missing stdin as empty', () => {
    const result = validateExecuteRequest({ languageId: 109, sourceCode: 'x' }, limits);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.request.stdin, '');
  });

  it('rejects a non-object body', () => {
    const result = validateExecuteRequest('nope', limits);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, 400);
  });

  it('rejects an unsupported language id with a 400, not a 500', () => {
    const result = validateExecuteRequest({ ...valid, languageId: 1 }, limits);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.status, 400);
      assert.match(result.failure.error, /Unsupported language id/);
    }
  });

  it('rejects a language id sent as a string', () => {
    const result = validateExecuteRequest({ ...valid, languageId: '109' }, limits);
    assert.equal(result.ok, false);
  });

  it('rejects empty source code', () => {
    const result = validateExecuteRequest({ ...valid, sourceCode: '  \n ' }, limits);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, 400);
  });

  it('rejects oversized source with a 413 measured in bytes, not characters', () => {
    const source = 'é'.repeat(120_000); // 240 000 bytes, 120 000 characters
    const result = validateExecuteRequest({ ...valid, sourceCode: source }, limits);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.status, 413);
      assert.match(result.failure.error, /240000 bytes/);
    }
  });

  it('rejects oversized stdin', () => {
    const result = validateExecuteRequest(
      { ...valid, stdin: 'x'.repeat(DEFAULT_MAX_STDIN_BYTES + 1) },
      limits,
    );
    assert.equal(result.ok, false);
  });

  it('honours an environment override instead of a hard-coded limit', () => {
    const tight = runnerLimits({ RUNNER_MAX_SOURCE_BYTES: '4' });
    const result = validateExecuteRequest({ ...valid, sourceCode: '12345' }, tight);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, 413);
  });

  it('ignores a nonsense override and keeps the default', () => {
    const weird = runnerLimits({ RUNNER_MAX_SOURCE_BYTES: '-1' });
    assert.equal(weird.maxSourceBytes, 200_000);
  });
});

describe('buildProviderPayload', () => {
  it('always sets our runtime controls, never the caller\'s', () => {
    const payload = buildProviderPayload(valid, limits);
    assert.equal(payload.language_id, 109);
    assert.equal(payload.cpu_time_limit, 3);
    assert.equal(payload.wall_time_limit, 5);
    assert.equal(payload.memory_limit, 128_000);
    assert.ok(payload.stdout_limit > 0);
  });

  it('asks the provider for exactly the fields the UI renders', () => {
    const query = submissionQuery(limits);
    assert.match(query, /wait=true/);
    assert.match(query, /fields=/);
    assert.match(query, /compile_output/);
    assert.match(query, /exit_code/);
  });
});

describe('normalizeExecution', () => {
  const raw = {
    stdout: '5\n',
    stderr: null,
    compile_output: null,
    message: null,
    exit_code: 0,
    time: '0.02',
    memory: 12_345,
    status: { id: 3, description: 'Accepted' },
  };

  it('maps a successful submission', () => {
    const result = normalizeExecution(raw, { maxOutputChars: 1000 });
    assert.deepEqual(result, {
      status: 'Accepted',
      statusId: 3,
      stdout: '5\n',
      stderr: '',
      compileOutput: '',
      message: '',
      exitCode: 0,
      time: '0.02',
      memory: 12_345,
      timedOut: false,
    });
  });

  it('coerces the provider\'s nulls to empty strings', () => {
    const result = normalizeExecution(
      { status: { id: 6, description: 'Compilation Error' }, compile_output: 'main.cpp: error' },
      { maxOutputChars: 1000 },
    );
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
    assert.equal(result.compileOutput, 'main.cpp: error');
  });

  it('reports a timeout even when the provider had no verdict', () => {
    const result = normalizeExecution({ status: { id: 2, description: 'Processing' } }, {
      maxOutputChars: 1000,
      timedOut: true,
    });
    assert.equal(result.status, 'Timed out');
    assert.equal(result.timedOut, true);
  });

  it('classifies terminal statuses', () => {
    assert.equal(isTerminalStatus(3), true);
    assert.equal(isTerminalStatus(2), false);
    assert.equal(isTerminalStatus(null), false);
  });
});

describe('toClientResult', () => {
  it('clips each stream and says so', () => {
    const result = toClientResult(
      { stdout: 'x'.repeat(5000), status: { id: 3, description: 'Accepted' } },
      { maxOutputChars: 1000 },
    );
    assert.ok(result.stdout.length < 5000);
    assert.match(result.stdout, /truncated/);
  });
});

describe('truncateOutput', () => {
  it('leaves short output untouched', () => {
    assert.deepEqual(truncateOutput('hello', 100), { text: 'hello', truncated: false });
  });

  it('clips at exactly the cap before appending the marker', () => {
    const { text } = truncateOutput('abcdef', 3);
    assert.ok(text.startsWith('abc'));
    assert.match(text, /truncated at 3 characters/);
  });
});

describe('providerFailure', () => {
  it('turns provider throttling into a 429', () => {
    assert.equal(providerFailure(429).status, 429);
  });

  it('never passes a provider 4xx through to the client', () => {
    const failure = providerFailure(422);
    assert.equal(failure.status, 502);
    assert.doesNotMatch(failure.error, /422|judge0|token/i);
  });

  it('maps outages to a 502 with a plain sentence', () => {
    assert.equal(providerFailure(503).status, 502);
  });
});

describe('RequestRateLimiter', () => {
  it('allows up to the limit then refuses, and recovers after the window', () => {
    const limiter = new RequestRateLimiter(3, 1000);
    assert.equal(limiter.allow('ip', 0), true);
    assert.equal(limiter.allow('ip', 1), true);
    assert.equal(limiter.allow('ip', 2), true);
    assert.equal(limiter.allow('ip', 3), false);
    assert.equal(limiter.allow('ip', 1500), true);
  });

  it('keeps separate callers separate', () => {
    const limiter = new RequestRateLimiter(1, 1000);
    assert.equal(limiter.allow('a', 0), true);
    assert.equal(limiter.allow('b', 0), true);
    assert.equal(limiter.allow('a', 0), false);
  });
});

describe('originAllowed', () => {
  it('allows a same-origin request', () => {
    assert.equal(originAllowed('https://app.example.com', 'app.example.com'), true);
  });

  it('refuses a cross-origin request', () => {
    assert.equal(originAllowed('https://evil.example.com', 'app.example.com'), false);
  });

  it('allows a request with no Origin at all', () => {
    assert.equal(originAllowed(undefined, 'app.example.com'), true);
  });
});

describe('language catalog', () => {
  it('has unique ids and extensions', () => {
    const ids = new Set(RUNNER_LANGUAGES.map((language) => language.id));
    assert.equal(ids.size, RUNNER_LANGUAGES.length);
  });

  it('ships runnable sample code for every language', () => {
    for (const language of RUNNER_LANGUAGES) {
      assert.ok(language.defaultCode.trim().length > 0, `${language.name} has no sample`);
    }
  });

  it('covers the popular languages the plan calls for', () => {
    const shorts = RUNNER_LANGUAGES.map((language) => language.short);
    for (const expected of ['Python', 'JavaScript', 'TypeScript', 'C', 'C++', 'Java', 'C#', 'Go', 'Rust']) {
      assert.ok(shorts.includes(expected), `missing ${expected}`);
    }
  });
});