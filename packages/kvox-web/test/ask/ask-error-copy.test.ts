import { describe, expect, it } from 'vitest';

import {
  ASK_CONFLICT_REASONS,
  ASK_ERROR_CLASSES,
  ASK_FINISH_REASONS,
} from '@marinoscar/kvox-contract/ask';

import { KvoxApiError } from '../../src/core/headless/index.js';
import {
  ASK_CONFLICT_COPY,
  ASK_ERROR_CLASS_COPY,
  ASK_MODEL_NOT_PERMITTED_COPY,
  ASK_SEND_FALLBACK_COPY,
  askErrorClassCopy,
  askFinishReasonCopy,
  askSendErrorCopy,
} from '../../src/ask/headless/index.js';

/**
 * Copy completeness (#504): every value the wire can carry has a sentence, so a
 * new value added to the contract fails here instead of rendering `undefined`.
 */

describe('Ask error copy is complete', () => {
  it('has copy for every 409 reason POST …/messages can answer', () => {
    for (const reason of ASK_CONFLICT_REASONS) {
      expect(ASK_CONFLICT_COPY[reason], reason).toBeTruthy();
      const copy = askSendErrorCopy(
        new KvoxApiError('Conflict', 409, 'CONFLICT', { reason }),
      );
      expect(copy.message, reason).toBe(ASK_CONFLICT_COPY[reason]);
    }
  });

  it('has copy for every stored error class', () => {
    for (const errorClass of ASK_ERROR_CLASSES) {
      expect(askErrorClassCopy(errorClass), errorClass).toBe(ASK_ERROR_CLASS_COPY[errorClass]);
      expect(ASK_ERROR_CLASS_COPY[errorClass].length, errorClass).toBeGreaterThan(0);
    }
  });

  it('has copy for the wire-only gone and for the reader giving up (timeout)', () => {
    expect(askErrorClassCopy('gone')).toBe('This conversation is no longer available.');
    // `timeout` with reason `stream_duration_cap` is the READER giving up; the hook re-attaches
    // and the stored message is shown. A stored `timeout` reads as the generic failure.
    expect(askErrorClassCopy('timeout')).toBeTruthy();
  });

  it('reads an unknown or missing class as the generic failure, never undefined', () => {
    expect(askErrorClassCopy(null)).toBe(ASK_ERROR_CLASS_COPY.other);
    expect(askErrorClassCopy(undefined)).toBe(ASK_ERROR_CLASS_COPY.other);
    expect(askErrorClassCopy('meteor' as never)).toBe(ASK_ERROR_CLASS_COPY.other);
  });

  it('captions every finish reason but stop as stopped early', () => {
    for (const reason of ASK_FINISH_REASONS) {
      const caption = askFinishReasonCopy(reason);
      if (reason === 'stop') {
        expect(caption, reason).toBeNull();
      } else {
        expect(caption, reason).toMatch(/^Stopped early/);
      }
    }
  });

  it('answers a refused model, a missing conversation, a plain 4xx and everything else', () => {
    expect(
      askSendErrorCopy(new KvoxApiError('Bad', 400, 'BAD_REQUEST', { reason: 'model_not_permitted' })).message,
    ).toBe(ASK_MODEL_NOT_PERMITTED_COPY);
    expect(askSendErrorCopy(new KvoxApiError('Gone', 404)).message).toBe("This conversation doesn't exist any more.");
    expect(askSendErrorCopy(new KvoxApiError('Too long', 422)).message).toBe('Too long');
    expect(askSendErrorCopy(new KvoxApiError('Boom', 500)).message).toBe(ASK_SEND_FALLBACK_COPY);
    expect(askSendErrorCopy(new Error('offline')).message).toBe(ASK_SEND_FALLBACK_COPY);
  });

  it('links the missing-key conflict to where the fix is', () => {
    const copy = askSendErrorCopy(new KvoxApiError('Conflict', 409, 'CONFLICT', { reason: 'ai_key_missing' }));
    expect(copy.link).toEqual({ to: '/settings/ai', label: 'Open Settings → AI' });
  });
});
