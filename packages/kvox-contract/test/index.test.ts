import { describe, expect, it } from 'vitest';

import { ASK_CONTENT_MAX_CHARS, askMessageSchema } from '../src/ask/index.js';
import { KVOX_ERROR_CODES } from '../src/errors/index.js';
import { createNoteSchema } from '../src/notes/index.js';
import { ONTOLOGY_VERSION } from '../src/ontology/index.js';
import { KVOX_CONTRACT_PACKAGE } from '../src/index.js';
import { transcriptListItemSchema } from '../src/transcripts/index.js';

describe('@marinoscar/kvox-contract entry points', () => {
  it('the root exports its package name', () => {
    expect(KVOX_CONTRACT_PACKAGE).toBe('@marinoscar/kvox-contract');
  });

  it('each slice entry point exports its schemas', () => {
    expect(ASK_CONTENT_MAX_CHARS).toBe(4000);
    expect(KVOX_ERROR_CODES.ai_not_configured.status).toBe(409);
    expect(ONTOLOGY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof askMessageSchema.parse).toBe('function');
    expect(typeof createNoteSchema.parse).toBe('function');
    expect(typeof transcriptListItemSchema.parse).toBe('function');
  });
});
