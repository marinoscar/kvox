// readNoteSourceText and the loader's use of it (#789). Every name is invented.

import { Readable } from 'node:stream';

import { GraphOntologyService } from '../../graph/index.js';
import { IDS, schemaFor } from '../testing/extraction-fixtures.js';
import { ExtractionInputLoader } from './extraction-input.loader.js';
import { MAX_SOURCE_TEXT_CHARS, readNoteSourceText, type NoteSourceFields } from './source-text.js';

const OWNER = IDS.owner;
const UPLOADED = '3c000000-0000-4000-8000-000000000001';
const EXTRACTED = '3c000000-0000-4000-8000-000000000002';
const TEXT = 'Person K1 leads Project P1 for Org Alpha.\n\nPerson K2 leads Project P2 for Org Alpha.';

const generated: NoteSourceFields = { sourceType: 'document', sourceObjectId: UPLOADED, provider: 'openai' };

function store(over: { extractedOwner?: string | null; managedBy?: string | null; size?: number; text?: string; metadata?: unknown; missing?: boolean } = {}) {
  const info = {
    describe: jest.fn(async (ids: readonly string[]) => {
      const out = new Map<string, unknown>();
      if (ids.includes(UPLOADED)) out.set(UPLOADED, { id: UPLOADED, metadata: over.metadata === undefined ? { extractedObjectId: EXTRACTED } : over.metadata });
      if (ids.includes(EXTRACTED) && !over.missing) {
        out.set(EXTRACTED, {
          id: EXTRACTED,
          ownerId: over.extractedOwner === undefined ? OWNER : over.extractedOwner,
          managedBy: over.managedBy === undefined ? 'notes' : over.managedBy,
          size: over.size ?? 100,
        });
      }
      return out;
    }),
    openRead: jest.fn(async () => Readable.from([Buffer.from(over.text ?? TEXT, 'utf8')])),
  };
  return info as never;
}

describe('readNoteSourceText (#789)', () => {
  it('reads the extracted text of the document an AI-generated note was made from', async () => {
    await expect(readNoteSourceText(store(), generated, OWNER)).resolves.toEqual({ objectId: EXTRACTED, text: TEXT });
  });

  it.each([
    ['a transcript note', { ...generated, sourceType: 'transcript' }],
    ['a note made from another note', { ...generated, sourceType: 'note' }],
    ['a document note with no source object', { ...generated, sourceObjectId: null }],
    // An IMPORTED note has no provider: its body already is the document.
    ['an imported note (no provider)', { ...generated, provider: null }],
  ])('offers nothing for %s, and reads nothing', async (_name, note) => {
    const s = store();
    await expect(readNoteSourceText(s, note, OWNER)).resolves.toBeNull();
    expect((s as unknown as { describe: jest.Mock }).describe).not.toHaveBeenCalled();
  });

  it('offers nothing when no extraction recorded a text, or the text object is gone', async () => {
    await expect(readNoteSourceText(store({ metadata: {} }), generated, OWNER)).resolves.toBeNull();
    await expect(readNoteSourceText(store({ metadata: null }), generated, OWNER)).resolves.toBeNull();
    await expect(readNoteSourceText(store({ missing: true }), generated, OWNER)).resolves.toBeNull();
  });

  it("never offers somebody else's object or one no module manages", async () => {
    await expect(readNoteSourceText(store({ extractedOwner: 'someone-else' }), generated, OWNER)).resolves.toBeNull();
    await expect(readNoteSourceText(store({ managedBy: null }), generated, OWNER)).resolves.toBeNull();
  });

  it('offers nothing for a blank text, and says why for an oversized or unreadable one', async () => {
    const skips: string[] = [];
    await expect(readNoteSourceText(store({ text: '  \n ' }), generated, OWNER, (r) => skips.push(r))).resolves.toBeNull();
    expect(skips).toEqual([]);

    await expect(readNoteSourceText(store({ size: MAX_SOURCE_TEXT_CHARS * 4 + 1 }), generated, OWNER, (r) => skips.push(r))).resolves.toBeNull();
    await expect(
      readNoteSourceText(store({ text: 'x'.repeat(MAX_SOURCE_TEXT_CHARS + 1), size: MAX_SOURCE_TEXT_CHARS + 1 }), generated, OWNER, (r) => skips.push(r)),
    ).resolves.toBeNull();
    expect(skips).toEqual(['too_large', 'too_large']);

    const broken = { describe: jest.fn(async () => { throw new Error('store down: secret-path'); }), openRead: jest.fn() } as never;
    await expect(readNoteSourceText(broken, generated, OWNER, (r) => skips.push(r))).resolves.toBeNull();
    expect(skips[2]).toBe('unreadable');
  });
});

describe('ExtractionInputLoader.load: the source text (#789)', () => {
  function loader(note: Record<string, unknown>, objectStore?: unknown) {
    const prisma = {
      note: { findUnique: jest.fn(async () => note) },
      noteVersion: { findUnique: jest.fn(async () => ({ body: 'Plan summary body.' })) },
      transcript: { findUnique: jest.fn() },
      kgRelation: { findMany: jest.fn(async () => []) },
      kgMention: { groupBy: jest.fn(async () => []) },
      kgEntity: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    };
    const origin = { resolve: jest.fn(async () => null) };
    const ontology = { effectiveSchemaFor: jest.fn(async () => schemaFor()) } as unknown as GraphOntologyService;
    return new ExtractionInputLoader(prisma as never, origin as never, ontology, undefined, undefined, objectStore as never);
  }
  const noteRow = {
    id: IDS.note,
    ownerId: OWNER,
    title: 'Plan',
    deletedAt: null,
    status: 'ready',
    currentVersion: 2,
    body: 'Plan summary body.',
    contextText: null,
    createdAt: new Date('2026-03-04T09:00:00.000Z'),
    sourceType: 'document',
    sourceObjectId: UPLOADED,
    provider: 'openai',
  };
  const args = { userId: OWNER, noteId: IDS.note, guidance: null };

  it('carries the text object and text beside the generated note body', async () => {
    const input = await loader(noteRow, store()).load(args);
    expect(input.sourceText).toEqual({ objectId: EXTRACTED, text: TEXT });
    expect(input.note.bodyAtVersion).toBe('Plan summary body.');
  });

  it('carries none for an imported note, so its body stays the input', async () => {
    const input = await loader({ ...noteRow, provider: null }, store()).load(args);
    expect(input.sourceText).toBeNull();
  });

  it('carries none when the host binds no object store', async () => {
    const input = await loader(noteRow).load(args);
    expect(input.sourceText).toBeNull();
  });
});
