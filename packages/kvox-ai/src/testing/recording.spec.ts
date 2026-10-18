import { z } from 'zod';

import { collect, textAnswer } from './scripted-events.js';
import { createScriptedRuntime } from './scripted-runtime.js';
import {
  createRecordedValueNormalizer,
  createRecordingAdapter,
  createRecordingRuntime,
  normalizeRecordedValue,
  withRecordedFeatures,
} from './recording.js';

// =============================================================================
// The recorders of the harness-parity check (issue #580)
// =============================================================================

const U1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const U2 = 'a1b2c3d4-0000-4000-8000-000000000002';

describe('normalizeRecordedValue', () => {
  it('numbers UUIDs by first appearance, so equal ids map equal and different ids differ', () => {
    const out = normalizeRecordedValue({ a: U2, b: [U1, U2], c: `see ${U1} and ${U2}` });
    expect(out).toEqual({ a: '<uuid:1>', b: ['<uuid:2>', '<uuid:1>'], c: 'see <uuid:2> and <uuid:1>' });
  });

  it('replaces ISO timestamps and Dates, and keeps a date without a time', () => {
    const out = normalizeRecordedValue({ at: '2026-01-02T03:04:05.678Z', same: '2026-01-02T03:04:05.678Z', when: new Date('2026-05-06T00:00:00Z'), day: '2026-01-02' });
    expect(out).toEqual({ at: '<timestamp:1>', same: '<timestamp:1>', when: '<timestamp:2>', day: '2026-01-02' });
  });

  it('replaces requestId-like fields whatever the value, and nothing else', () => {
    const out = normalizeRecordedValue({ requestId: 'req-9', nested: { request_id: 'req-9', other: 'req-9' }, traceId: 't-1' });
    expect(out).toEqual({ nested: { other: 'req-9', request_id: '<requestId:1>' }, requestId: '<requestId:1>', traceId: '<requestId:2>' });
  });

  it('does not drop fields: two values that differ in one character stay different', () => {
    expect(normalizeRecordedValue({ system: 'You are a note writer.' })).not.toEqual(normalizeRecordedValue({ system: 'You are a note writer!' }));
  });

  it('sorts object keys, so key order never decides equality', () => {
    expect(JSON.stringify(normalizeRecordedValue({ b: 1, a: { d: 2, c: 3 } }))).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('turns a Zod schema into its JSON Schema', () => {
    const out = normalizeRecordedValue({ schema: z.object({ name: z.string() }) }) as { schema: { type: string; properties: Record<string, unknown> } };
    expect(out.schema.type).toBe('object');
    expect(Object.keys(out.schema.properties)).toEqual(['name']);
  });

  it('keeps one numbering across calls of a shared normalizer', () => {
    const normalize = createRecordedValueNormalizer();
    expect(normalize({ id: U1 })).toEqual({ id: '<uuid:1>' });
    expect(normalize({ id: U2, again: U1 })).toEqual({ again: '<uuid:1>', id: '<uuid:2>' });
  });
});

describe('createRecordingRuntime', () => {
  it('records each round trip in order, without user, organization, job or signal, and forwards it', async () => {
    const inner = createScriptedRuntime();
    inner.queueStream({ events: textAnswer('hi') });
    const recording = createRecordingRuntime(inner);
    const call = { userId: 'u1', orgId: 'o1', jobId: 'j1', feature: 'note_generate' as const, provider: 'openai', model: 'gpt-x', signal: new AbortController().signal };

    const events = await collect(recording.stream(call, { instructions: 'sys', input: 'hello', maxOutputTokens: 5 }));
    await recording.create({ ...call, feature: 'graph_extract' }, { input: `ref ${U1}` });
    await recording.embed!({ ...call, feature: 'search_embed' }, { input: ['a'], dimensions: 4 });

    expect(events.map((e) => e.type)).toEqual(['output_text.delta', 'response.completed']);
    expect(recording.requests()).toEqual([
      { method: 'stream', feature: 'note_generate', provider: 'openai', model: 'gpt-x', request: { input: 'hello', instructions: 'sys', maxOutputTokens: 5 } },
      { method: 'create', feature: 'graph_extract', provider: 'openai', model: 'gpt-x', request: { input: 'ref <uuid:1>' } },
      { method: 'embed', feature: 'search_embed', provider: 'openai', model: 'gpt-x', request: { dimensions: 4, input: ['a'] } },
    ]);
    const json = JSON.stringify(recording.requests());
    for (const forbidden of ['u1', 'o1', 'j1', 'signal']) expect(json).not.toContain(`"${forbidden}"`);
    expect(inner.calls.map((c) => c.kind)).toEqual(['stream', 'create', 'embed']);
  });

  it('leaves embed off when the inner runtime has none, and resets', async () => {
    const recording = createRecordingRuntime(createScriptedRuntime({ embeddings: false }));
    expect(recording.embed).toBeUndefined();
    await recording.create({ userId: 'u', feature: 'note_generate' }, { input: 'x' });
    expect(recording.requests()).toHaveLength(1);
    recording.reset();
    expect(recording.requests()).toEqual([]);
  });

  it('answers readiness from the inner runtime', async () => {
    const inner = createScriptedRuntime({ hasKey: false });
    const recording = createRecordingRuntime(inner);
    await expect(recording.readiness({ userId: 'u', feature: 'note_generate', provider: 'openai' })).resolves.toEqual({ hasKey: false });
  });
});

describe('createRecordingAdapter', () => {
  it('refuses to join records that do not line up', () => {
    const adapter = createRecordingAdapter();
    expect(() => withRecordedFeatures(adapter.requests(), [{ method: 'stream', feature: 'note_generate', request: {} }])).toThrow(/recorded 0 round trips/);
  });

  it('resets its records and counters', async () => {
    const seen: number[] = [];
    const adapter = createRecordingAdapter({ stream: (_r, i) => (seen.push(i), textAnswer('x')) });
    const ctx = { apiKey: 'k', requestId: 'r' };
    await collect(adapter.responses!.stream({ model: 'm', input: 'a' }, ctx));
    adapter.reset();
    await collect(adapter.responses!.stream({ model: 'm', input: 'a' }, ctx));
    expect(seen).toEqual([0, 0]);
    expect(adapter.requests()).toHaveLength(1);
  });
});
