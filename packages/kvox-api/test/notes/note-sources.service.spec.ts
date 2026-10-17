import { NotFoundException } from '@nestjs/common';

import type { KvoxObjectInfo } from '../../src/ports/index.js';
import { NoteSourcesService } from '../../src/notes/note-sources.service.js';
import { EXTRACTION_METADATA_KEY } from '../../src/notes/source-metadata.js';

const OWNER = 'owner-1';
const OBJECT_ID = '11111111-2222-4333-8444-555555555555';

const info = (overrides: Partial<KvoxObjectInfo> = {}): KvoxObjectInfo =>
  ({
    id: OBJECT_ID,
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    size: 10,
    state: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerId: OWNER,
    managedBy: 'notes',
    metadata: null,
    ...overrides,
  }) as KvoxObjectInfo;

describe('NoteSourcesService.documentStatus (#596)', () => {
  const describeMock = jest.fn();
  let service: NoteSourcesService;

  beforeEach(() => {
    describeMock.mockReset();
    service = new NoteSourcesService(
      { describe: describeMock } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('maps the extraction metadata for the owner', async () => {
    describeMock.mockResolvedValue(
      info({ metadata: { [EXTRACTION_METADATA_KEY]: { status: 'extracted', message: 'ok', characters: 321 } } }),
    );

    await expect(service.documentStatus(OBJECT_ID, OWNER)).resolves.toEqual({
      objectId: OBJECT_ID,
      status: 'extracted',
      message: 'ok',
      characters: 321,
    });
    expect(describeMock).toHaveBeenCalledWith(OBJECT_ID);
  });

  it('is extracting for an owner whose object has no result yet', async () => {
    describeMock.mockResolvedValue(info());

    await expect(service.documentStatus(OBJECT_ID, OWNER)).resolves.toEqual({
      objectId: OBJECT_ID,
      status: 'extracting',
      message: null,
      characters: null,
    });
  });

  it.each([
    ['missing', null],
    ['owned by another user', info({ ownerId: 'someone-else' })],
    ['managed by another module', info({ managedBy: 'transcripts' })],
    ['managed by no module', info({ managedBy: null })],
  ])('is the same 404 for an object that is %s', async (_label, object) => {
    describeMock.mockResolvedValue(object);

    const error = await service.documentStatus(OBJECT_ID, OWNER).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe('Source document not found');
  });
});
