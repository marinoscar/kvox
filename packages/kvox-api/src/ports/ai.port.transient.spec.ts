import { KvoxAiError, transientFailureOf } from './ai.port.js';

describe('transientFailureOf (#759)', () => {
  const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });
  const wrapped = (inner: unknown) => Object.assign(new TypeError('fetch failed'), { cause: inner });

  it.each(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH'])('%s anywhere in the cause chain is unreachable', (code) => {
    expect(transientFailureOf(withCode(code))).toBe('unreachable');
    expect(transientFailureOf(wrapped(wrapped(withCode(code))))).toBe('unreachable');
  });

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])('%s is a broken connection (not safe to retry)', (code) => {
    expect(transientFailureOf(wrapped(withCode(code)))).toBe('network');
  });

  it.each(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])('%s is a timeout', (code) => {
    expect(transientFailureOf(withCode(code))).toBe('timeout');
  });

  it('a DNS failure wins over a later reset in the same chain', () => {
    expect(transientFailureOf(withCode('ECONNRESET'))).toBe('network');
    expect(transientFailureOf(Object.assign(withCode('ECONNRESET'), { cause: withCode('EAI_AGAIN') }))).toBe('unreachable');
  });

  it('falls back to the well-known transport sentences, and nothing else', () => {
    expect(transientFailureOf(new Error('socket hang up'))).toBe('network');
    expect(transientFailureOf(new TypeError('fetch failed'))).toBe('network');
    expect(transientFailureOf(new Error('the model said no'))).toBeUndefined();
  });

  it('is total: odd values and cyclic causes do not throw or loop', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    for (const value of [undefined, null, 'EAI_AGAIN', 42, {}, cyclic]) {
      expect(() => transientFailureOf(value)).not.toThrow();
    }
    expect(transientFailureOf('EAI_AGAIN')).toBeUndefined();
  });

  it('KvoxAiError carries the reason only when given', () => {
    expect(new KvoxAiError('other', 'm').transient).toBeUndefined();
    expect(new KvoxAiError('other', 'm', undefined, undefined, 'network').transient).toBe('network');
  });
});
