import { describe, expect, it } from 'vitest';

import {
  MAX_CONTEXT_ATTACHMENTS,
  contextAttachmentIdsSchema,
  createNoteSchema,
  regenerateNoteSchema,
} from '../src/notes/index.js';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('contextAttachmentIds', () => {
  it('accepts up to the limit and refuses more', () => {
    const ids = Array.from({ length: MAX_CONTEXT_ATTACHMENTS }, (_, i) => id(i));
    expect(contextAttachmentIdsSchema.safeParse(ids).success).toBe(true);
    expect(contextAttachmentIdsSchema.safeParse([...ids, id(99)]).success).toBe(false);
  });

  it('refuses duplicates and non-uuids', () => {
    expect(contextAttachmentIdsSchema.safeParse([id(1), id(1)]).success).toBe(false);
    expect(contextAttachmentIdsSchema.safeParse(['nope']).success).toBe(false);
  });

  it('is optional on create and keep/replace/clear on regenerate', () => {
    const source = { type: 'transcript', transcriptId: id(5) };
    const base = { templateId: id(2), source };
    expect(createNoteSchema.safeParse(base).success).toBe(true);
    expect(createNoteSchema.safeParse({ ...base, contextAttachmentIds: [id(1)] }).success).toBe(true);
    expect(regenerateNoteSchema.parse({}).contextAttachmentIds).toBeUndefined();
    expect(regenerateNoteSchema.parse({ contextAttachmentIds: null }).contextAttachmentIds).toBeNull();
    expect(regenerateNoteSchema.parse({ contextAttachmentIds: [id(1)] }).contextAttachmentIds).toEqual([id(1)]);
  });
});
