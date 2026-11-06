import { describe, it, expect } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import {
  MAX_CONTEXT_ATTACHMENTS,
  checkContextAttachmentFile,
  contextAttachmentErrorMessage,
  contextAttachmentIds,
  contextAttachmentLimitMessage,
  contextAttachmentsBlockingReason,
  noteContextAttachmentKind,
  withContextAttachmentMediaType,
} from '../../src/notes/headless/utils/contextAttachments.js';
import type { ContextAttachmentItem } from '../../src/notes/headless/utils/contextAttachments.js';
import { buildRegenerateInput } from '../../src/notes/headless/utils/regenerateInput.js';
import type { RegenerateNoteFields } from '../../src/notes/headless/utils/regenerateInput.js';

/**
 * Context attachments, the pure half (#810): type checks, the per-row helpers, the error
 * sentences, and the keep / replace / clear rule of the regenerate body.
 */

function apiError(status: number, reason?: string): KvoxApiError {
  return new KvoxApiError('raw server message', status, undefined, reason ? { reason } : undefined);
}

function item(overrides: Partial<ContextAttachmentItem> = {}): ContextAttachmentItem {
  return {
    key: 'k1',
    filename: 'agenda.pdf',
    kind: 'document',
    objectId: 'obj-1',
    status: 'ready',
    error: null,
    characters: null,
    ...overrides,
  };
}

describe('noteContextAttachmentKind', () => {
  it('reads the media type when the browser gave one', () => {
    expect(noteContextAttachmentKind({ name: 'x', type: 'image/png' })).toBe('image');
    expect(noteContextAttachmentKind({ name: 'x', type: 'application/pdf' })).toBe('document');
  });

  it('falls back to the extension for a missing or generic type', () => {
    expect(noteContextAttachmentKind({ name: 'notes.md', type: '' })).toBe('document');
    expect(noteContextAttachmentKind({ name: 'notes.markdown', type: '' })).toBe('document');
    expect(noteContextAttachmentKind({ name: 'slides.pptx', type: 'application/octet-stream' })).toBe('document');
    expect(noteContextAttachmentKind({ name: 'board.JPG', type: '' })).toBe('image');
  });

  it('refuses a type the route does not read', () => {
    expect(noteContextAttachmentKind({ name: 'clip.mp4', type: 'video/mp4' })).toBeNull();
    expect(noteContextAttachmentKind({ name: 'sheet.xlsx', type: '' })).toBeNull();
    expect(noteContextAttachmentKind({ name: 'vector.svg', type: 'image/svg+xml' })).toBeNull();
  });
});

describe('withContextAttachmentMediaType', () => {
  it('adds the media type the extension names', () => {
    const file = withContextAttachmentMediaType(new File(['# hi'], 'notes.md'));
    expect(file.type).toBe('text/markdown');
    expect(file.name).toBe('notes.md');
  });

  it('keeps a file that already has a specific type', () => {
    const original = new File(['x'], 'a.png', { type: 'image/png' });
    expect(withContextAttachmentMediaType(original)).toBe(original);
  });
});

describe('checkContextAttachmentFile', () => {
  it('accepts a supported, non-empty file', () => {
    expect(checkContextAttachmentFile({ name: 'a.txt', type: 'text/plain', size: 3 })).toBeNull();
  });

  it('refuses an unsupported type, an empty file and one over a known limit', () => {
    expect(checkContextAttachmentFile({ name: 'a.exe', type: '', size: 3 })).toMatch(/cannot be attached/);
    expect(checkContextAttachmentFile({ name: 'a.txt', type: 'text/plain', size: 0 })).toBe('This file is empty.');
    expect(checkContextAttachmentFile({ name: 'a.txt', type: 'text/plain', size: 2_000_000 }, 1_000_000)).toMatch(
      /over the 1\.0 MB limit/,
    );
  });

  it('leaves size to the server when no limit is known', () => {
    expect(checkContextAttachmentFile({ name: 'a.pdf', type: 'application/pdf', size: 500_000_000 })).toBeNull();
  });
});

describe('contextAttachmentErrorMessage', () => {
  it('maps every context-attachment reason to a sentence, never the raw message', () => {
    for (const [status, reason, pattern] of [
      [409, 'context_attachment_not_ready', /not ready yet/],
      [400, 'context_attachment_unsupported_type', /cannot be attached/],
      [400, 'context_attachment_limit', new RegExp(`at most ${MAX_CONTEXT_ATTACHMENTS}`)],
      [409, 'ai_model_no_vision', /cannot read images/],
    ] as const) {
      const message = contextAttachmentErrorMessage(apiError(status, reason));
      expect(message).toMatch(pattern);
      expect(message).not.toContain('raw server message');
    }
  });

  it('maps a 413 to a size sentence', () => {
    expect(contextAttachmentErrorMessage(apiError(413))).toMatch(/larger than this deployment accepts/);
  });

  it('answers null for anything else', () => {
    expect(contextAttachmentErrorMessage(apiError(409, 'ai_key_missing'))).toBeNull();
    expect(contextAttachmentErrorMessage(new Error('boom'))).toBeNull();
  });
});

describe('the row helpers', () => {
  it('lists only ready rows’ ids, in order', () => {
    expect(
      contextAttachmentIds([
        item({ key: 'a', objectId: 'o1' }),
        item({ key: 'b', objectId: 'o2', status: 'extracting' }),
        item({ key: 'c', objectId: 'o3' }),
        item({ key: 'd', objectId: null, status: 'failed', error: 'no' }),
      ]),
    ).toEqual(['o1', 'o3']);
  });

  it('blocks on a failed row first, then on one still working, else not at all', () => {
    expect(contextAttachmentsBlockingReason([])).toBeNull();
    expect(contextAttachmentsBlockingReason([item()])).toBeNull();
    expect(contextAttachmentsBlockingReason([item({ status: 'uploading' })])).toMatch(/Wait/);
    expect(contextAttachmentsBlockingReason([item({ status: 'uploading' }), item({ status: 'failed' })])).toMatch(
      /Remove/,
    );
  });

  it('says how many files the limit refused', () => {
    expect(contextAttachmentLimitMessage(1)).toMatch(/1 file was not added/);
    expect(contextAttachmentLimitMessage(3)).toMatch(/3 files were not added/);
  });
});

describe('buildRegenerateInput — context attachments keep / replace / clear', () => {
  const attached = [
    { objectId: 'o1', kind: 'document' as const, filename: 'agenda.pdf', mimeType: 'application/pdf' },
    { objectId: 'o2', kind: 'image' as const, filename: 'board.png', mimeType: 'image/png' },
  ];
  const note: RegenerateNoteFields = {
    templateId: 'tpl-1',
    contextText: null,
    model: 'gpt-4o-mini',
    contextAttachments: attached,
  };
  const form = { templateId: 'tpl-1', contextText: '', model: 'gpt-4o-mini' };

  it('omits the field when the dialog offered no attachment control', () => {
    expect(buildRegenerateInput(note, form)).toEqual({});
  });

  it('omits the field when the list is unchanged (keep)', () => {
    expect(buildRegenerateInput(note, { ...form, contextAttachmentIds: ['o1', 'o2'] })).toEqual({});
  });

  it('sends the new list when one was added or removed (replace)', () => {
    expect(buildRegenerateInput(note, { ...form, contextAttachmentIds: ['o1'] })).toEqual({
      contextAttachmentIds: ['o1'],
    });
    expect(buildRegenerateInput(note, { ...form, contextAttachmentIds: ['o1', 'o2', 'o3'] })).toEqual({
      contextAttachmentIds: ['o1', 'o2', 'o3'],
    });
  });

  it('treats a reorder as a change: the order is what the model sees', () => {
    expect(buildRegenerateInput(note, { ...form, contextAttachmentIds: ['o2', 'o1'] })).toEqual({
      contextAttachmentIds: ['o2', 'o1'],
    });
  });

  it('sends an explicit null when every attachment was removed (clear)', () => {
    expect(buildRegenerateInput(note, { ...form, contextAttachmentIds: [] })).toEqual({ contextAttachmentIds: null });
  });

  it('sends nothing for an empty list on a note that had none (older server: field absent)', () => {
    const { contextAttachments: _ignored, ...older } = note;
    expect(buildRegenerateInput(older, { ...form, contextAttachmentIds: [] })).toEqual({});
  });
});
