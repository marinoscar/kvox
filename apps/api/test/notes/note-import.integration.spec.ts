import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { mockPrismaTransaction, prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { NoteImportService, NoteObjectsService, NotesService } from '@marinoscar/kvox-api/notes';
import { SearchIndexService } from '@marinoscar/kvox-api/search';

// =============================================================================
// POST /api/notes/import over the wire (issue #585)
// =============================================================================
//
// The REAL `AppModule` (guards, multipart parsing, the envelope) with `PrismaService`
// mocked and the storage writer spied. Pins the HTTP contract: 401, 403 without
// `notes:write`, 400 for a body that is not multipart or has no `file`, the typed
// `details.reason` of a refused file, 413 over the size limit, and 201 with the new
// note. The parse and the write shape are the package's specs
// (`packages/kvox-api/test/notes/import/note-import.service.spec.ts`).
// =============================================================================

const IMPORT = '/api/notes/import';
const OBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A synthetic note Markdown export, as the exporter writes it. */
const EXPORT = [
  '---',
  'schema: "kvox.note/v1"',
  'title: "Imported over HTTP"',
  'bodyFormat: "markdown"',
  'noteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
  'version: 2',
  'exportedAt: "2026-09-14T04:37:11.000Z"',
  'template: null',
  '---',
  '',
  '# Imported over HTTP',
  '',
  '> **Source:** Weekly Sync (transcript)',
  '',
  '## Decisions',
  '',
  '- Ship it',
  '',
].join('\n');

describe('POST /api/notes/import (integration)', () => {
  let context: TestContext;
  let put: jest.SpyInstance;
  let remove: jest.SpyInstance;
  let index: jest.SpyInstance;
  let detail: jest.SpyInstance;
  let importFile: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();

    for (const spy of [put, remove, index, detail, importFile]) spy?.mockRestore();

    const objects = context.app.get(NoteObjectsService);

    put = jest.spyOn(objects, 'put').mockResolvedValue({ id: OBJECT_ID, size: 10 } as never);
    remove = jest.spyOn(objects, 'deleteIfPresent').mockResolvedValue(true as never);
    index = jest.spyOn(context.app.get(SearchIndexService), 'enqueue').mockResolvedValue(undefined as never);
    importFile = jest.spyOn(context.app.get(NoteImportService), 'importFile');
    // The 201 answers `GET /api/notes/:id`'s shape; that projection is the notes specs' subject.
    detail = jest
      .spyOn(context.app.get(NotesService), 'detail')
      .mockImplementation((async (id: string) => ({ id, title: 'Imported over HTTP', status: 'ready', currentVersion: 1 })) as never);

    prismaMock.note.create.mockImplementation((async (args: { data: Record<string, unknown> }) => ({
      id: NOTE_ID,
      ...args.data,
    })) as never);
    prismaMock.noteVersion.create.mockResolvedValue({} as never);
    prismaMock.job.create.mockResolvedValue({ id: 'job-1', type: 'note.source.extract' } as never);
  });

  const upload = (token: string | undefined, body: Buffer, filename = 'note.md', field = 'file') => {
    const req = request(context.app.getHttpServer()).post(IMPORT);

    return (token ? req.set(authHeader(token)) : req).attach(field, body, { filename, contentType: 'text/markdown' });
  };

  it('is 401 without a session', async () => {
    await upload(undefined, Buffer.from(EXPORT)).expect(401);
    expect(importFile).not.toHaveBeenCalled();
  });

  it('is 403 without notes:write, before anything is stored', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const original = prismaMock.user.findUnique.getMockImplementation();

    prismaMock.user.findUnique.mockImplementation((async (args: never) => {
      const found = (await original?.(args)) as
        | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
        | null;

      if (!found || found.id !== user.id || !found.userRoles) return found as never;

      return {
        ...found,
        userRoles: found.userRoles.map((userRole) => ({
          ...userRole,
          role: {
            ...userRole.role,
            rolePermissions: userRole.role.rolePermissions.filter((rp) => rp.permission.name !== 'notes:write'),
          },
        })),
      } as never;
    }) as never);

    await upload(user.accessToken, Buffer.from(EXPORT)).expect(403);
    expect(importFile).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('imports the file and answers 201 with the new note', async () => {
    const user = await createMockTestUser(context);

    const response = await upload(user.accessToken, Buffer.from(EXPORT)).expect(201);

    expect(response.body.data).toMatchObject({ id: NOTE_ID, title: 'Imported over HTTP', status: 'ready' });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: expect.stringMatching(/^notes\/sources\/uploads\/[0-9a-f-]{36}\/source\.md$/),
        name: 'note.md',
        mimeType: 'text/markdown',
        ownerId: user.id,
      }),
    );
    expect(prismaMock.note.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: user.id,
        title: 'Imported over HTTP',
        titleSource: 'user',
        body: '## Decisions\n\n- Ship it',
        status: 'ready',
        currentVersion: 1,
        sourceType: 'document',
        sourceObjectId: OBJECT_ID,
      }),
    });
    expect(prismaMock.noteVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ noteId: NOTE_ID, version: 1, kind: 'edit', authorId: user.id }),
    });
    expect(index).toHaveBeenCalledWith('note', NOTE_ID);
    expect(detail).toHaveBeenCalledWith(NOTE_ID, expect.objectContaining({ id: user.id }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('is 400 when the body is not multipart', async () => {
    const user = await createMockTestUser(context);

    await request(context.app.getHttpServer()).post(IMPORT).set(authHeader(user.accessToken)).send({ x: 1 }).expect(400);
    expect(put).not.toHaveBeenCalled();
  });

  it('is 400 when the file is not in the "file" field', async () => {
    const user = await createMockTestUser(context);

    await upload(user.accessToken, Buffer.from(EXPORT), 'note.md', 'upload').expect(400);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ['not_text', Buffer.from([0xff, 0xfe, 0x00, 0x41])],
    ['invalid_front_matter', Buffer.from('---\ntitle: "x"\n')],
    ['unsupported_note_format', Buffer.from('---\nschema: "kvox.note/v2"\n---\nBody\n')],
    ['empty_note', Buffer.from('# Only a title\n')],
  ])('is 400 %s for a refused file, and stores nothing', async (reason, body) => {
    const user = await createMockTestUser(context);
    const response = await upload(user.accessToken, body).expect(400);

    expect(response.body.details).toMatchObject({ reason });
    expect(put).not.toHaveBeenCalled();
    expect(prismaMock.note.create).not.toHaveBeenCalled();
  });

  it('is 413 over the 5 MiB import limit, before anything is stored', async () => {
    const user = await createMockTestUser(context);
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);

    await upload(user.accessToken, tooBig).expect(413);
    expect(put).not.toHaveBeenCalled();
    expect(importFile).not.toHaveBeenCalled();
  });
});
