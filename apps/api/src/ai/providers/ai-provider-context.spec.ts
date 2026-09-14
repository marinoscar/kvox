import { createProviderContext } from './ai-provider.interface';

// =============================================================================
// The provider context must not leak the key (issue #47, epic #45)
// =============================================================================
//
// ⚠ THE KEY THIS OBJECT CARRIES BELONGS TO AN INDIVIDUAL USER, not to the
// deployment. Every other credential in this application is something an
// administrator configured; this one is somebody's personal provider account,
// with their own billing attached. That raises the stakes of the ordinary
// accident these tests exist to make harmless: a context reaching
// `JSON.stringify` through a log serialiser, an error's `cause`, or a job
// payload.
//
// EVERY TEST BELOW IS WRITTEN TO FAIL IF `toJSON` IS MADE ENUMERABLE, which is
// the specific regression `createProviderContext` is defending against and the
// one an ordinary "does it redact?" test would sail straight past. The spread
// case is why: a spread COPIES enumerable properties, so an enumerable `toJSON`
// would produce an object carrying BOTH the raw `apiKey` AND a `toJSON` that
// claims it is redacted — serialising to `[redacted]` while the plaintext sits
// in memory for any other reader. A non-enumerable one is simply absent from
// the copy, so the copy has no redaction and no false claim of one.
// =============================================================================

const SECRET = 'sk-test-DO-NOT-LOG-4f9a2c7e';

describe('createProviderContext', () => {
  it('exposes the key to a direct reader — the one caller that needs it', () => {
    const ctx = createProviderContext(SECRET, { baseUrl: 'https://x/v1' });

    // The provider itself must still be able to build an Authorization header.
    // A context that redacted the key from ITS OWN consumer would be safe and
    // useless.
    expect(ctx.apiKey).toBe(SECRET);
    expect(ctx.settings).toEqual({ baseUrl: 'https://x/v1' });
  });

  it('redacts the key under JSON.stringify', () => {
    const ctx = createProviderContext(SECRET, { baseUrl: 'https://x/v1' });

    const serialized = JSON.stringify(ctx);

    expect(serialized).not.toContain(SECRET);
    expect(JSON.parse(serialized)).toEqual({
      apiKey: '[redacted]',
      settings: { baseUrl: 'https://x/v1' },
    });
  });

  it('redacts the key when a thrown error carrying it is serialized', () => {
    const ctx = createProviderContext(SECRET, { region: 'us' });

    // The realistic shape of this accident: something attaches the context to
    // an error for "debuggability", and the error is then logged as JSON.
    const err = Object.assign(new Error('provider call failed'), {
      context: ctx,
    });

    const serialized = JSON.stringify({
      message: err.message,
      context: (err as { context: unknown }).context,
    });

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[redacted]');
  });

  it('does not carry the key into a spread copy', () => {
    const ctx = createProviderContext(SECRET, { region: 'us' });

    const copy = { ...ctx };

    // ⚠ THE ASSERTION THAT FAILS IF `toJSON` BECOMES ENUMERABLE. An enumerable
    // `toJSON` would be copied here, and `JSON.stringify(copy)` would then say
    // `[redacted]` while `copy.apiKey` still held the plaintext — a redaction
    // that is a lie is worse than no redaction, because it stops anyone
    // looking.
    expect(Object.keys(copy)).toEqual(['apiKey', 'settings']);
    expect('toJSON' in copy).toBe(false);
  });

  it('keeps toJSON off every enumeration — keys, entries, for-in and the spread', () => {
    const ctx = createProviderContext(SECRET, { region: 'us' });

    // Four independent enumerations, because each is a different way a
    // serialiser might walk the object and they do not all agree by default:
    // `for…in` walks the prototype chain, `Object.keys` does not, and a spread
    // copies own enumerable string keys only.
    expect(Object.keys(ctx)).not.toContain('toJSON');
    expect(Object.entries(ctx).map(([key]) => key)).not.toContain('toJSON');

    const forInKeys: string[] = [];
    for (const key in ctx) forInKeys.push(key);
    expect(forInKeys).not.toContain('toJSON');

    // And the descriptor itself, stated directly — so a failure names the
    // actual mistake rather than leaving it to be inferred from four
    // consequences of it.
    const descriptor = Object.getOwnPropertyDescriptor(ctx, 'toJSON');
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(false);
  });

  it('is frozen, so a caller cannot strip the redaction or overwrite the key', () => {
    const ctx = createProviderContext(SECRET, { region: 'us' });

    expect(Object.isFrozen(ctx)).toBe(true);

    // Non-strict assignment to a frozen object is a silent no-op rather than a
    // throw in some contexts, so the assertion is about the OUTCOME: whatever
    // the attempt does, the object is unchanged.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (ctx as any).toJSON;
    }).toThrow();

    expect(JSON.stringify(ctx)).not.toContain(SECRET);
  });

  it('redacts even when the settings block is itself nested and chatty', () => {
    const ctx = createProviderContext(SECRET, {
      baseUrl: 'https://api.openai.com/v1',
      allowedModels: ['gpt-4o', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o',
    });

    const serialized = JSON.stringify({ wrapper: { deep: [ctx] } });

    // Nested inside two levels and an array, because that is how a context
    // actually reaches a serialiser in practice — as a field of something else,
    // never as the top-level argument.
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('gpt-4o-mini');
  });
});
