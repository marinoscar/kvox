import { ForbiddenException } from '@nestjs/common';

import { expectNoUuid, makeCtx, uid } from '../testing/ask-tool-fakes.js';
import { SearchTool, snippetToText } from './search.tool.js';

// =============================================================================
// `search` (#377): both legs always run, null → defaults, handle registration,
// plain-text excerpts, the recording date, and a uuid-free result.
// =============================================================================

const KAPPA = uid(1);
const SARAH = uid(2);
const T1 = uid(3);
const N1 = uid(4);

function build(opts: { entities?: object[]; results?: object[]; searchError?: Error } = {}) {
  const graphRead = {
    listEntities: jest.fn(async () => ({ items: opts.entities ?? [], nextCursor: null })),
  };
  const search = {
    search: jest.fn(async () => {
      if (opts.searchError) throw opts.searchError;
      return { results: opts.results ?? [], nextCursor: null };
    }),
  };
  const prisma = {
    note: { findMany: jest.fn(async () => [{ id: N1, createdAt: new Date('2026-05-06T10:00:00Z') }]) },
  };
  // The host's rule for which transcripts the caller may see (owned, or shared with them in the web
  // edition): the dates come from a statement run in the viewer's scope.
  const transcriptRows = [{ id: T1, recordedAt: new Date('2026-03-04T10:00:00Z') }];
  const queryRaw = jest.fn(async () => transcriptRows);
  const visibility = {
    viewerFor: jest.fn(async (userId: string) => ({ userId })),
    transcriptVisibleSql: jest.fn(() => ({ strings: ['true'], values: [] })),
    run: jest.fn(async (_viewer: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: queryRaw })),
  };
  return { tool: new SearchTool(graphRead as never, search as never, prisma as never, visibility as never), graphRead, search, prisma, visibility, queryRaw };
}

const entity = (id: string, label: string, type = 'Organization') => ({ id, type, label, aliases: ['KAPPA Corp'], mentionCount: 2, lastSeenAt: null });
const transcriptHit = {
  type: 'transcript',
  id: T1,
  title: 'Weekly sync',
  score: 0.03,
  updatedAt: '2026-09-01T00:00:00.000Z',
  status: 'ready',
  snippets: [
    { html: 'Weekly <mark>sync</mark>', startMs: null, field: 'title' },
    { html: 'we signed with <mark>Kappa</mark> &amp; co &lt;3', startMs: 61_000, field: 'segment' },
  ],
};
const noteHit = {
  type: 'note',
  id: N1,
  title: 'Kappa notes',
  score: 0.02,
  updatedAt: '2026-09-02T00:00:00.000Z',
  status: 'ready',
  snippets: [{ html: '<mark>Kappa</mark> renewal', startMs: null, field: 'body' }],
};

describe('SearchTool', () => {
  it('runs both legs with defaults for null arguments', async () => {
    const { tool, graphRead, search } = build();
    const ctx = makeCtx();
    const args = tool.input.parse({ query: ' Kappa ', scope: null, limit: null });
    await tool.run(ctx, args);
    expect(graphRead.listEntities).toHaveBeenCalledWith(ctx.user, { q: 'Kappa', sort: 'updated', limit: 5 });
    expect(search.search).toHaveBeenCalledWith(
      { q: 'Kappa', types: 'transcript,note', limit: 5 },
      { userId: ctx.user.id, permissions: new Set(ctx.user.permissions) },
    );
  });

  it.each([
    ['entities', 10, 3],
    ['documents', 3, 10],
    ['all', 10, 10],
  ])('scope %s shortens the other leg but never skips it', async (scope, entityLimit, documentLimit) => {
    const { tool, graphRead, search } = build();
    await tool.run(makeCtx(), tool.input.parse({ query: 'Kappa', scope, limit: 10 }));
    expect(graphRead.listEntities).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: entityLimit }));
    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({ limit: documentLimit }), expect.anything());
  });

  it('registers handles and returns a uuid-free shape', async () => {
    const { tool } = build({ entities: [entity(KAPPA, 'Kappa'), entity(SARAH, 'Sarah', 'Person')], results: [transcriptHit, noteHit] });
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ query: 'Kappa' }));
    expect(res.data).toEqual({
      entities: [
        { ref: 'ent1', type: 'Organization', label: 'Kappa', aliases: ['KAPPA Corp'] },
        { ref: 'ent2', type: 'Person', label: 'Sarah', aliases: ['KAPPA Corp'] },
      ],
      documents: [
        { ref: 'doc1', kind: 'transcript', title: 'Weekly sync', excerpt: 'we signed with Kappa & co <3', at: '2026-03-04', startMs: 61_000 },
        { ref: 'doc2', kind: 'note', title: 'Kappa notes', excerpt: 'Kappa renewal', at: '2026-05-06', startMs: null },
      ],
    });
    expect(ctx.handles.resolve('doc1')).toEqual({ kind: 'doc', id: T1, label: 'Weekly sync', documentKind: 'transcript', startMs: 61_000 });
    expect(ctx.handles.resolve('ent1')).toEqual({ kind: 'ent', id: KAPPA, label: 'Kappa' });
    expect(res.summary).toBe('Searched "Kappa" · 2 entities, 2 passages');
    expect(res.resultCount).toBe(4);
    expectNoUuid(res.data);
  });

  it('never returns a personal-domain entity without the opt-in (#383)', async () => {
    const { tool } = build({ entities: [entity(uid(30), 'Kappa'), entity(uid(31), 'Lisbon trip', 'Trip')] });
    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ query: 'Kappa' }));
    const entities = (res.data as { entities: Array<{ label: string }> }).entities;
    expect(entities.map((e) => e.label)).toEqual(['Kappa']);

    const allowed = makeCtx({ personalFactsAllowed: true });
    const withOptIn = await tool.run(allowed, tool.input.parse({ query: 'Kappa' }));
    expect((withOptIn.data as { entities: Array<{ label: string }> }).entities.map((e) => e.label)).toEqual(['Kappa', 'Lisbon trip']);
  });

  it('with zero entities still returns documents', async () => {
    const { tool } = build({ results: [noteHit] });
    const res = await tool.run(makeCtx(), tool.input.parse({ query: 'renewal' }));
    expect((res.data as { entities: unknown[] }).entities).toEqual([]);
    expect((res.data as { documents: unknown[] }).documents).toHaveLength(1);
    expect(res.summary).toBe('Searched "renewal" · 0 entities, 1 passage');
  });

  it('degrades the document leg when the caller may read neither transcripts nor notes', async () => {
    const { tool } = build({ entities: [entity(KAPPA, 'Kappa')], searchError: new ForbiddenException() });
    const res = await tool.run(makeCtx(), tool.input.parse({ query: 'Kappa' }));
    expect(res.data).toMatchObject({ documents: [], documentsUnavailable: expect.any(String) });
  });

  it('rethrows any other search failure (a bug is not a model mistake)', async () => {
    const { tool } = build({ searchError: new TypeError('boom') });
    await expect(tool.run(makeCtx(), tool.input.parse({ query: 'Kappa' }))).rejects.toThrow(TypeError);
  });

  it('scopes the document-date lookup to what the caller may see', async () => {
    const { tool, prisma, visibility, queryRaw } = build({ results: [transcriptHit, noteHit] });
    const ctx = makeCtx();
    await tool.run(ctx, tool.input.parse({ query: 'Kappa' }));
    // Transcripts: the host's visibility rule, in the viewer's scope.
    expect(visibility.viewerFor).toHaveBeenCalledWith(ctx.user.id);
    expect(visibility.transcriptVisibleSql).toHaveBeenCalledWith({ userId: ctx.user.id }, 't');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // Notes: owner only, live.
    expect(prisma.note.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: ctx.user.id, deletedAt: null }) }));
  });

  it('rejects an empty or over-long query', () => {
    const { tool } = build();
    expect(tool.input.safeParse({ query: '  ' }).success).toBe(false);
    expect(tool.input.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(tool.input.safeParse({ query: 'x', limit: 11 }).success).toBe(false);
  });
});

describe('snippetToText', () => {
  it('drops marks and undoes the escape, ampersands last', () => {
    expect(snippetToText('<mark>a</mark> &amp;lt; &quot;b&quot; &#39;c&#39; &gt;')).toBe('a &lt; "b" \'c\' >');
  });
});
