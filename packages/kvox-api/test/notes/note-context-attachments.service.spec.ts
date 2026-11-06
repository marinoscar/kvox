import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';

import type { KvoxObjectInfo } from '../../src/ports/index.js';
import { NoteContextAttachmentsService } from '../../src/notes/note-context-attachments.service.js';
import { EXTRACTION_METADATA_KEY } from '../../src/notes/source-metadata.js';
import { normalizeImageMimeType, sniffImageType } from '../../src/notes/context-attachment-image.js';
import { createInMemoryNotesDb } from '../../src/notes/testing/in-memory-notes-db.js';

// =============================================================================
// NoteContextAttachmentsService (issue #810): the upload door and the id validation
// =============================================================================

const OWNER = 'owner-1';
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const info = (overrides: Partial<KvoxObjectInfo> = {}): KvoxObjectInfo =>
  ({
    id: ID(1),
    name: 'brief.md',
    mimeType: 'text/markdown',
    size: 10,
    state: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: OWNER,
    managedBy: 'notes',
    metadata: null,
    ...overrides,
  }) as KvoxObjectInfo;

const extracted = { [EXTRACTION_METADATA_KEY]: { status: 'extracted', characters: 12 } };

function build(options: { objects?: KvoxObjectInfo[]; maxBytes?: number } = {}) {
  const byId = new Map((options.objects ?? []).map((o) => [o.id, o]));
  const objects = {
    put: jest.fn().mockResolvedValue({ id: ID(9), size: 12 }),
    describe: jest.fn(async (id: string) => byId.get(id) ?? null),
  };
  const sources = {
    maxDocumentBytes: jest.fn().mockResolvedValue(options.maxBytes ?? 1_000),
    uploadDocument: jest.fn().mockResolvedValue({
      objectId: ID(5),
      filename: 'brief.md',
      mimeType: 'text/markdown',
      size: 7,
      jobId: 'job-1',
      status: 'extracting',
    }),
    safeDisplayName: (raw: string, fallback: string) => raw.trim() || fallback,
  };
  const store = { describe: jest.fn(async (ids: string[]) => new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!]] : [])))) };
  const memory = createInMemoryNotesDb();
  const service = new NoteContextAttachmentsService(objects as never, sources as never, store as never, memory.db);

  return { service, objects, sources, memory };
}

describe('image sniffing', () => {
  it('names the four accepted types from their leading bytes and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<html></html>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('folds the usual spellings and ignores parameters', () => {
    expect(normalizeImageMimeType('IMAGE/JPG')).toBe('image/jpeg');
    expect(normalizeImageMimeType('image/png; foo=bar')).toBe('image/png');
    expect(normalizeImageMimeType('image/svg+xml')).toBeNull();
  });
});

describe('NoteContextAttachmentsService.upload', () => {
  it('sends a document down the existing extraction path', async () => {
    const { service, sources, objects } = build();

    const out = await service.upload({ filename: 'brief.md', mimeType: 'text/markdown', body: Buffer.from('# hi') }, OWNER);

    expect(sources.uploadDocument).toHaveBeenCalledTimes(1);
    expect(objects.put).not.toHaveBeenCalled();
    expect(out).toMatchObject({ objectId: ID(5), kind: 'document', status: 'extracting', jobId: 'job-1' });
  });

  it('stores an image as ready at once, owned by the uploader, with no job', async () => {
    const { service, objects } = build();

    const out = await service.upload({ filename: 'board.png', mimeType: 'image/png', body: PNG }, OWNER);

    expect(objects.put).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/png', ownerId: OWNER, name: 'board.png', body: PNG }),
    );
    // The key is generated, never the filename.
    expect(objects.put.mock.calls[0][0].storageKey).toMatch(/^notes\/context\/[0-9a-f-]{36}\/image\.png$/);
    expect(out).toEqual({
      objectId: ID(9),
      kind: 'image',
      filename: 'board.png',
      mimeType: 'image/png',
      size: PNG.byteLength,
      status: 'ready',
      jobId: null,
    });
  });

  it('refuses a type that is neither a document nor an image, naming the accepted list and the reason', async () => {
    const { service, objects } = build();

    const failure = await service
      .upload({ filename: 'a.exe', mimeType: 'application/octet-stream', body: Buffer.from('x') }, OWNER)
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toMatchObject({
      details: { reason: 'context_attachment_unsupported_type' },
    });
    expect(JSON.stringify((failure as BadRequestException).getResponse())).toContain('image/png');
    expect(objects.put).not.toHaveBeenCalled();
  });

  it('refuses an image whose bytes are not that image', async () => {
    const { service, objects } = build();

    await expect(
      service.upload({ filename: 'fake.png', mimeType: 'image/png', body: Buffer.from('<html>') }, OWNER),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.upload({ filename: 'mismatch.png', mimeType: 'image/png', body: JPEG }, OWNER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(objects.put).not.toHaveBeenCalled();
  });

  it('refuses an empty image and one over the document ceiling', async () => {
    const { service, objects } = build({ maxBytes: 8 });

    await expect(service.upload({ filename: 'e.png', mimeType: 'image/png', body: Buffer.alloc(0) }, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.upload({ filename: 'big.png', mimeType: 'image/png', body: PNG }, OWNER)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(objects.put).not.toHaveBeenCalled();
  });
});

describe('NoteContextAttachmentsService.status', () => {
  it('reports an image ready and a document by its extraction', async () => {
    const { service } = build({
      objects: [
        info({ id: ID(1), name: 'a.png', mimeType: 'image/png' }),
        info({ id: ID(2), metadata: extracted }),
        info({ id: ID(3), metadata: { [EXTRACTION_METADATA_KEY]: { status: 'unextractable', message: 'Scanned PDF.' } } }),
        info({ id: ID(4) }),
      ],
    });

    await expect(service.status(ID(1), OWNER)).resolves.toMatchObject({ kind: 'image', status: 'ready' });
    await expect(service.status(ID(2), OWNER)).resolves.toMatchObject({ kind: 'document', status: 'ready', characters: 12 });
    await expect(service.status(ID(3), OWNER)).resolves.toMatchObject({ status: 'unextractable', message: 'Scanned PDF.' });
    await expect(service.status(ID(4), OWNER)).resolves.toMatchObject({ status: 'extracting' });
  });

  it('answers 404 for another user\'s object, another module\'s object and a missing id', async () => {
    const { service } = build({
      objects: [info({ id: ID(1), ownerId: 'someone-else' }), info({ id: ID(2), managedBy: 'transcripts' as never })],
    });

    for (const id of [ID(1), ID(2), ID(3)]) {
      await expect(service.status(id, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

describe('NoteContextAttachmentsService.resolve', () => {
  const objects = [
    info({ id: ID(1), name: 'agenda.md', metadata: extracted }),
    info({ id: ID(2), name: 'board.png', mimeType: 'image/png' }),
    info({ id: ID(3), name: 'pending.md' }),
    info({ id: ID(4), name: 'scan.pdf', mimeType: 'application/pdf', metadata: { [EXTRACTION_METADATA_KEY]: { status: 'unextractable', message: 'No text.' } } }),
    info({ id: ID(5), ownerId: 'someone-else', metadata: extracted }),
    info({ id: ID(6), name: 'a.zip', mimeType: 'application/zip' }),
  ];

  it('returns ready attachments in the order given', async () => {
    const { service } = build({ objects });

    await expect(service.resolve([ID(2), ID(1)], OWNER)).resolves.toEqual([
      { objectId: ID(2), kind: 'image', filename: 'board.png', mimeType: 'image/png' },
      { objectId: ID(1), kind: 'document', filename: 'agenda.md', mimeType: 'text/markdown' },
    ]);
    await expect(service.resolve([], OWNER)).resolves.toEqual([]);
  });

  it('is a 404 for another user\'s object or a missing id', async () => {
    const { service } = build({ objects });

    await expect(service.resolve([ID(5)], OWNER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resolve([ID(99)], OWNER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 409 not-ready for a document still extracting or one with no text', async () => {
    const { service } = build({ objects });

    for (const id of [ID(3), ID(4)]) {
      const failure = await service.resolve([id], OWNER).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'context_attachment_not_ready' },
      });
    }
  });

  it('is a 400 for a type that cannot be context, and for more than ten', async () => {
    const { service } = build({ objects });

    await expect(service.resolve([ID(6)], OWNER)).rejects.toBeInstanceOf(BadRequestException);

    const limit = await service.resolve(Array.from({ length: 11 }, (_, i) => ID(i + 100)), OWNER).catch((e: unknown) => e);
    expect(limit).toBeInstanceOf(BadRequestException);
    expect((limit as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'context_attachment_limit' } });
  });
});

describe('NoteContextAttachmentsService.forNote', () => {
  it('reads the note\'s attachments in ordinal order', async () => {
    const { service, memory } = build();
    memory.attachments.push(
      { id: 'a', noteId: 'n1', objectId: ID(2), kind: 'image', filename: 'b.png', mimeType: 'image/png', ordinal: 1, createdAt: new Date() },
      { id: 'b', noteId: 'n1', objectId: ID(1), kind: 'document', filename: 'a.md', mimeType: 'text/markdown', ordinal: 0, createdAt: new Date() },
      { id: 'c', noteId: 'other', objectId: ID(3), kind: 'document', filename: 'c.md', mimeType: 'text/markdown', ordinal: 0, createdAt: new Date() },
    );

    await expect(service.forNote('n1')).resolves.toEqual([
      { objectId: ID(1), kind: 'document', filename: 'a.md', mimeType: 'text/markdown' },
      { objectId: ID(2), kind: 'image', filename: 'b.png', mimeType: 'image/png' },
    ]);
  });
});
