import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunningBareHost } from '../src/bootstrap.js';
import type { ScenarioRecording } from '../src/graph-scenario.js';

// =============================================================================
// The graph and Ask on the bare host (issue #573, epic #574)
// =============================================================================
//
// Two recordings through the whole domain, over real HTTP, on the database leg
// `--db` chose (`BARE_HOST_DB`): the graph, graph-extraction, graph-rdf and Ask
// slices mounted next to the transcripts and notes ones. The graph is seeded
// through the real write path ONLY. Per recording (`src/graph-scenario.ts`):
//
//   upload -> transcription -> note -> POST /api/graph/notes/:id/extract
//   -> kg.extract (the fake model's `kg_extraction` answer, validated, resolved)
//   -> proposal -> bulk accept -> POST /api/graph/proposals/:id/commit
//   (GraphWriteService)
//
// Then one fact NO meeting states — who Joe reports to — is set BY HAND on his
// entity page (step 9, `POST /api/graph/entities/:id/relations`, #586), through
// the same GraphWriteService, cited by the owner ("Set by hand"), and Ask
// answers "meetings with Joe's boss" from it.
//
// No test statement inserts, updates or deletes a kg_* row to build the graph;
// the only SQL is read-only assertions and one refused transaction at the very
// end (step 12), which proves the `kg_assert_has_evidence` trigger and leaves
// nothing behind. Nothing in the host is mocked except the speech provider and
// the language model (`src/fake-provider.ts`, `src/fake-ai.ts`).
//
// ISOLATION: every started host owns a throwaway database (the service leg
// creates and drops one, PGlite lives in memory) and its own data folder, so
// this file and `happy-path.e2e.test.ts` never see each other's rows, in either
// order. `fileParallelism: false` only keeps two applications from sharing the
// machine.
//
// PGLITE: the socket closes the connection after any SQL error and the next
// query fails once with "Connection terminated unexpectedly" (README "PGlite").
// Step 12 provokes one error on purpose, so it is the LAST step and is followed
// by a retried harmless query.
//
// The application is loaded from `dist/` with `require`, not imported: Vitest's
// transformer does not emit decorator metadata, and Nest's dependency injection
// reads it. `dist/` is what `npm run build` made with `tsc`.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const load = createRequire(import.meta.url);
const bootstrap = load('../dist/bootstrap.js') as typeof import('../src/bootstrap.js');
const provider = load('../dist/fake-provider.js') as typeof import('../src/fake-provider.js');
const scenario = load('../dist/graph-scenario.js') as typeof import('../src/graph-scenario.js');
const { startBareHost } = bootstrap;
const { queueFakeTranscript } = provider;
const { GRAPH_SCENARIO, ASK_QUESTIONS, WEEKLY_SYNC, STANDUP } = scenario;

const AUDIO = readFileSync(join(here, 'fixtures', 'hello.mp3'));

interface Seeded {
  transcriptId: string;
  noteId: string;
  proposalId: string;
  itemCount: number;
}

interface AskAnswer {
  status: string;
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; summary: string; error: string | null }>;
  citations: Array<{ marker: string; kind: string; valid: boolean; label: string; via: { kind: string } | null }>;
}

let host: RunningBareHost;
const seeded: Seeded[] = [];
const people = new Map<string, string>();
let exportId = '';

/** A request as the one local user. */
async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-local-user', '1');
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return fetch(`${host.baseUrl}${path}`, { ...init, headers, body });
}

/** The body, unwrapped from the graph routes' `{ data }` envelope when there is one. */
async function json<T = any>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(expected);
  const parsed = JSON.parse(text);
  return (parsed && typeof parsed === 'object' && 'data' in parsed && Object.keys(parsed).length <= 2 ? parsed.data : parsed) as T;
}

/** Runs every job that is due (the poll back-off is fast-forwarded) and fails the test on a failed job. */
async function drain(): Promise<void> {
  await host.jobs.drain({ ignoreSchedule: true });
  const failed = await host.prisma.job.findMany({ where: { status: 'failed' }, select: { type: true, lastError: true } });
  expect(failed, `failed jobs: ${JSON.stringify(failed)}`).toEqual([]);
}

async function succeeded(type: string): Promise<number> {
  return host.prisma.job.count({ where: { type, status: 'succeeded' } });
}

/** Every `kg.graph_layout` job, whatever its status. */
async function layoutJobs(): Promise<number> {
  return host.prisma.job.count({ where: { type: 'kg.graph_layout' } });
}

/** Polls (the listener is detached from the commit request) until a `kg.graph_layout` job exists. */
async function expectLayoutJobEnqueued(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await layoutJobs()) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(await layoutJobs(), 'a commit enqueues a kg.graph_layout job through graph.changed').toBeGreaterThanOrEqual(1);
}

/** Upload, transcribe, generate a note, extract, accept everything, commit: HTTP only. */
async function seedRecording(recording: ScenarioRecording): Promise<Seeded> {
  queueFakeTranscript(recording.transcript);
  const created = await json(
    await api('/api/transcripts', {
      method: 'POST',
      json: { title: recording.title, source: { name: 'meeting.mp3', size: AUDIO.length, mimeType: 'audio/mpeg' } },
    }),
    201,
  );
  const transcriptId: string = created.transcript.id;
  const put = await fetch(created.upload.parts[0].url, { method: 'PUT', body: AUDIO, headers: { 'content-type': 'audio/mpeg' } });
  expect(put.status).toBe(200);
  await json(await api(`/api/storage/objects/${created.upload.objectId}/upload/complete`, { method: 'POST', json: {} }));
  await drain();
  expect((await json(await api(`/api/transcripts/${transcriptId}`))).status).toBe('ready');

  const templates = await json(await api('/api/note-templates'));
  const note = await json(
    await api('/api/notes', { method: 'POST', json: { templateId: templates.items[0].id, source: { type: 'transcript', transcriptId } } }),
    201,
  );
  const noteId: string = note.note?.id ?? note.id;
  await drain();
  expect((await json(await api(`/api/notes/${noteId}`))).status).toBe('ready');

  const requested = await json(await api(`/api/graph/notes/${noteId}/extract`, { method: 'POST', json: {} }), 202);
  expect(requested.proposal.status).toBe('extracting');
  await drain();

  const detail = (await json(await api(`/api/graph/notes/${noteId}/proposal`))).proposal;
  const proposal = detail.proposal;
  expect(proposal.status).toBe('draft');
  const items: Array<{ id: string }> = detail.items;
  expect(items.length).toBeGreaterThan(0);
  const bulk = await json(
    await api(`/api/graph/proposals/${proposal.id}/items/bulk`, { method: 'POST', json: { itemIds: items.map((i) => i.id), decision: 'accept' } }),
  );
  expect(bulk.updated).toBe(items.length);
  expect(bulk.skipped).toEqual([]);
  const committed = await json(await api(`/api/graph/proposals/${proposal.id}/commit`, { method: 'POST', json: {} }));
  expect(committed.proposal.status).toBe('committed');
  // A commit emits `graph.changed` (#591); the layout listener counts detached from the request, so
  // wait for the delayed `kg.graph_layout` job it enqueues (the first commit has no snapshot yet; a
  // later one is not a >= 20 % change and joins or adds nothing) before the drain runs it.
  await expectLayoutJobEnqueued();
  await drain();
  return { transcriptId, noteId, proposalId: proposal.id, itemCount: items.length };
}

/** Asks one question in a fresh conversation and returns the finished assistant message. */
async function ask(question: string): Promise<AskAnswer> {
  const conversation = await json(await api('/api/ask/conversations', { method: 'POST', json: {} }), 201);
  const posted = await json(await api(`/api/ask/conversations/${conversation.id}/messages`, { method: 'POST', json: { content: question } }), 202);
  await drain();
  const detail = await json(await api(`/api/ask/conversations/${conversation.id}`));
  const messages: Array<{ id: string }> = detail.messages?.items ?? detail.messages;
  const answer = messages.find((m) => m.id === posted.assistantMessage.id);
  expect(answer, 'the assistant message is in the conversation').toBeDefined();
  return answer as unknown as AskAnswer;
}

/** Rows of an accepted/edited graph subject that have no evidence row (read-only). */
async function orphans(table: 'kg_entities' | 'kg_relations' | 'kg_items', kind: 'entity' | 'relation' | 'item'): Promise<number> {
  const rows = await host.prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ${table} s
      WHERE s.review_status::text IN ('accepted','edited')
        AND NOT EXISTS (SELECT 1 FROM kg_evidence e WHERE e.subject_kind::text = '${kind}' AND e.subject_id = s.id)`,
  );
  return rows[0].n;
}

beforeAll(async () => {
  host = await startBareHost({
    backgroundJobs: false,
    dataDir: join(here, '..', '.data', `graph-${process.pid}`),
    log: (line) => console.log(line),
  });
});

afterAll(async () => {
  await host?.close();
});

describe('the graph and Ask on the bare host, end to end', () => {
  it('1. seeds both recordings through upload, extraction, review and commit', async () => {
    for (const recording of GRAPH_SCENARIO) seeded.push(await seedRecording(recording));

    expect(seeded).toHaveLength(2);
    expect(await succeeded('transcription.ingest')).toBe(2);
    expect(await succeeded('note.generate')).toBe(2);
    expect(await succeeded('kg.extract')).toBe(2);
    // The weekly sync: 3 people, the meeting, 2 commitments, 4 relations. The standup: the meeting and 2 ATTENDED.
    expect(seeded.map((s) => s.itemCount)).toEqual([10, 3]);
    const committed = await host.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kg_proposals WHERE status::text = 'committed'`;
    expect(committed[0].n).toBe(2);
  });

  it('2. reads the committed graph back over HTTP: 3 people, 2 meetings, who reports to whom, who attended', async () => {
    const persons = await json(await api('/api/graph/entities?type=Person'));
    expect(persons.items.map((e: { label: string }) => e.label).sort()).toEqual(['Jenny Kim', 'Joe Park', 'Maria Lopez']);
    for (const e of persons.items as Array<{ id: string; label: string }>) people.set(e.label, e.id);

    const meetings = await json(await api('/api/graph/entities?type=Meeting'));
    expect(meetings.items.map((e: { label: string }) => e.label).sort()).toEqual([STANDUP.title, WEEKLY_SYNC.title].sort());

    // Relations, from the database (read-only): the neighbourhood route is asserted through Ask below.
    const relations = await host.prisma.$queryRaw<Array<{ type: string; from_label: string; to_label: string }>>`
      SELECT r.type::text AS type, f.label AS from_label, t.label AS to_label
        FROM kg_relations r JOIN kg_entities f ON f.id = r.from_id JOIN kg_entities t ON t.id = r.to_id
       ORDER BY r.type::text, f.label, t.label`;
    expect(relations.filter((r) => r.type === 'REPORTS_TO')).toEqual([{ type: 'REPORTS_TO', from_label: 'Jenny Kim', to_label: 'Maria Lopez' }]);
    expect(relations.filter((r) => r.type === 'ATTENDED').map((r) => `${r.from_label} > ${r.to_label}`)).toEqual([
      `Jenny Kim > ${STANDUP.title}`,
      `Jenny Kim > ${WEEKLY_SYNC.title}`,
      `Joe Park > ${STANDUP.title}`,
      `Joe Park > ${WEEKLY_SYNC.title}`,
      `Maria Lopez > ${WEEKLY_SYNC.title}`,
    ]);
    expect(relations).toHaveLength(6);

    // One entity per person (the standup linked to the sync's people), readable by id.
    const brief = await json(await api(`/api/graph/entities/${people.get('Joe Park')}`));
    expect(brief.label).toBe('Joe Park');

    const commitments = await host.prisma.$queryRaw<Array<{ title: string; status: string }>>`
      SELECT title, status::text AS status FROM kg_items WHERE kind::text = 'commitment' ORDER BY title`;
    expect(commitments).toEqual([
      { title: 'Finish the vendor review', status: 'done' },
      { title: 'Send the budget draft', status: 'open' },
    ]);
  });

  it('3. gave every committed entity, relation and item at least one evidence row', async () => {
    expect(await orphans('kg_entities', 'entity')).toBe(0);
    expect(await orphans('kg_relations', 'relation')).toBe(0);
    expect(await orphans('kg_items', 'item')).toBe(0);

    const counts = await host.prisma.$queryRaw<Array<{ entities: number; relations: number; items: number; evidence: number }>>`
      SELECT (SELECT count(*)::int FROM kg_entities WHERE review_status::text IN ('accepted','edited')) AS entities,
             (SELECT count(*)::int FROM kg_relations WHERE review_status::text IN ('accepted','edited')) AS relations,
             (SELECT count(*)::int FROM kg_items WHERE review_status::text IN ('accepted','edited')) AS items,
             (SELECT count(*)::int FROM kg_evidence WHERE subject_kind::text IN ('entity','relation','item')) AS evidence`;
    // The assertions above are not vacuous: the graph is not empty.
    expect(counts[0].entities).toBe(5);
    expect(counts[0].relations).toBe(6);
    expect(counts[0].items).toBe(2);
    expect(counts[0].evidence).toBeGreaterThanOrEqual(13);
  });

  it('4. has the deferred kg_assert_has_evidence constraint triggers on this database leg', async () => {
    const triggers = await host.prisma.$queryRaw<Array<{ name: string; tbl: string; constraint_trigger: boolean; deferrable: boolean; deferred: boolean; fn: string }>>`
      SELECT t.tgname AS name, c.relname AS tbl, (t.tgconstraint <> 0) AS constraint_trigger,
             t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred, p.proname AS fn
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname = 'kg_assert_has_evidence'
       ORDER BY t.tgname`;
    expect(triggers.map((t) => `${t.tbl}:${t.name}`)).toEqual([
      'kg_entities:kg_entities_evidence_trg',
      'kg_evidence:kg_evidence_delete_trg',
      'kg_items:kg_items_evidence_trg',
      'kg_relations:kg_relations_evidence_trg',
    ]);
    for (const t of triggers) {
      expect(t.constraint_trigger, t.name).toBe(true);
      expect(t.deferrable, t.name).toBe(true);
      expect(t.deferred, t.name).toBe(true);
    }
  });

  it('5. has the pgvector (HNSW) and trigram (GIN) indexes on the graph tables', async () => {
    const indexes = await host.prisma.$queryRaw<Array<{ indexname: string; tablename: string; indexdef: string }>>`
      SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE 'kg\\_%' ORDER BY indexname`;
    const hnsw = indexes.filter((i) => /USING hnsw/i.test(i.indexdef) && /vector_cosine_ops/.test(i.indexdef));
    expect(hnsw.map((i) => i.indexname)).toEqual(expect.arrayContaining(['kg_entities_embedding_hnsw_idx', 'kg_items_embedding_hnsw_idx']));
    const trigram = indexes.filter((i) => /USING gin/i.test(i.indexdef) && /gin_trgm_ops/.test(i.indexdef));
    expect(trigram.map((i) => i.indexname)).toEqual(expect.arrayContaining(['kg_entities_label_trgm_idx', 'kg_entity_aliases_normalized_trgm_idx']));

    const extensions = await host.prisma.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm') ORDER BY extname`;
    expect(extensions.map((e) => e.extname)).toEqual(['pg_trgm', 'vector']);
  });

  it('6. lays out the overview (kg.graph_layout, the graphology peers)', async () => {
    // The first commit emitted `graph.changed` (#591) and enqueued the delayed layout (seedRecording
    // waited for it and drained it), so a snapshot exists before this GET: the bootstrap trigger of the
    // GET is not needed. That snapshot predates the second recording (4 -> 5 readable entities is not
    // the 20 % material change that would schedule another), so it reads back ready but stale.
    expect(await succeeded('kg.graph_layout')).toBe(1);
    const before = await json(await api('/api/graph/overview'));
    expect(before.status).toBe('ready');
    expect(before.stale).toBe(true);
    expect(before.nodeCount).toBe(4);

    // A manual refresh recomputes over the full graph.
    await json(await api('/api/graph/overview/refresh', { method: 'POST', json: {} }), 202);
    await drain();
    const after = await json(await api('/api/graph/overview'));
    expect(after.status).toBe('ready');
    expect(after.pending).toBe(false);
    expect(after.stale).toBe(false);
    expect(after.nodeCount).toBe(5);
    expect(after.edgeCount).toBe(6);
    expect(await succeeded('kg.graph_layout')).toBe(2);
  });

  it('7. answers "What are the action items from Joe?": search, then list_commitments for his open ones', async () => {
    const answer = await ask(ASK_QUESTIONS.actionItems);
    expect(answer.status).toBe('complete');

    expect(answer.toolCalls.map((c) => c.name)).toEqual(['search', 'list_commitments']);
    expect(answer.toolCalls.every((c) => c.error === null)).toBe(true);
    const [search, list] = answer.toolCalls;
    expect(search.arguments).toEqual({ query: 'Joe' });
    // The entity argument is the handle the search gave the Person; the citation of that handle names him.
    const handle = list.arguments.entity as string;
    expect(handle).toMatch(/^ent\d+$/);
    expect(list.arguments).toEqual({ entity: handle, direction: 'owned_by', status: 'open' });
    expect(list.summary).toBe('Listed 1 open commitment for Joe Park');
    expect(answer.citations.find((c) => c.marker === handle)).toMatchObject({ kind: 'entity', label: 'Joe Park', valid: true });

    expect(answer.content).toContain('Send the budget draft');
    expect(answer.content).not.toContain('vendor review');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((c) => c.valid)).toBe(true);
    expect(new Set(answer.citations.map((c) => c.kind))).toEqual(new Set(['entity', 'evidence']));
    // The evidence cited is the sync, never the standup.
    expect(answer.citations.filter((c) => c.kind === 'evidence').map((c) => c.label)).toEqual([WEEKLY_SYNC.title]);
  });

  it('8. answers "What meetings have we had with Jenny\'s boss?": search, neighbors over REPORTS_TO, timeline of the boss', async () => {
    const answer = await ask(ASK_QUESTIONS.bossMeetings);
    expect(answer.status).toBe('complete');

    expect(answer.toolCalls.map((c) => c.name)).toEqual(['search', 'neighbors', 'timeline']);
    expect(answer.toolCalls.every((c) => c.error === null)).toBe(true);
    const [search, neighbors, timeline] = answer.toolCalls;
    expect(search.arguments).toEqual({ query: 'Jenny' });
    expect(neighbors.arguments).toEqual({ entity: neighbors.arguments.entity, relationTypes: ['REPORTS_TO'] });
    expect(neighbors.arguments.entity).toMatch(/^ent\d+$/);
    expect(neighbors.summary).toContain('Jenny Kim');
    // The timeline is of the boss the neighbours step found, not of Jenny.
    expect(timeline.arguments).toEqual({ entity: timeline.arguments.entity, kinds: ['meeting'] });
    expect(timeline.arguments.entity).toMatch(/^ent\d+$/);
    expect(timeline.arguments.entity).not.toBe(neighbors.arguments.entity);
    expect(timeline.summary).toBe('Timeline of Maria Lopez · 1 event');

    expect(answer.content).toContain('Maria Lopez');
    expect(answer.content).toContain(WEEKLY_SYNC.title);
    expect(answer.content).not.toContain(STANDUP.title);
    expect(answer.content).not.toContain('standup');
    expect(answer.citations.every((c) => c.valid)).toBe(true);
    expect(new Set(answer.citations.map((c) => c.kind))).toEqual(new Set(['entity', 'evidence']));
    expect(answer.citations.some((c) => c.via?.kind === 'relation')).toBe(true);
    expect(answer.citations.filter((c) => c.kind === 'evidence').every((c) => c.label === WEEKLY_SYNC.title)).toBe(true);
  });

  it('9. a manager set by hand (no meeting states it) answers "meetings with Joe\'s boss", cited "Set by hand"', async () => {
    const joe = people.get('Joe Park') as string;
    const maria = people.get('Maria Lopez') as string;
    const jenny = people.get('Jenny Kim') as string;

    // Before: nothing says who Joe reports to.
    const before = await ask(ASK_QUESTIONS.manualBossMeetings);
    expect(before.toolCalls.map((c) => c.name)).toEqual(['search', 'neighbors']);
    expect(before.content).toContain('could not find who Joe Park');

    // Set by hand, from 1 January: one relation through GraphWriteService, one manual evidence row.
    const set = await json(
      await api(`/api/graph/entities/${joe}/relations`, { method: 'POST', json: { type: 'REPORTS_TO', toId: maria, validFrom: '2026-01-01' } }),
    );
    expect(set).toMatchObject({ created: true, closedRelationIds: [], flags: [] });
    expect(set.relation).toMatchObject({ type: 'REPORTS_TO', fromId: joe, toId: maria, reviewStatus: 'edited' });
    expect(set.relation.valid).toEqual({ from: '2026-01-01T00:00:00.000Z', to: null, precision: 'day' });
    const joeMaria: string = set.relation.id;
    const evidence = await host.prisma.$queryRaw<Array<{ id: string; quote: string; source_iri: string | null; anchors: number }>>`
      SELECT id::text AS id, quote, source_iri,
             (num_nonnulls(transcript_id, segment_id, note_id, import_object_id))::int AS anchors
        FROM kg_evidence WHERE subject_kind::text = 'relation' AND subject_id = ${joeMaria}::uuid`;
    expect(evidence).toEqual([
      { id: set.evidenceId, quote: 'Set by hand: Joe Park reports to Maria Lopez', source_iri: 'urn:kvox:evidence:manual', anchors: 0 },
    ]);
    const link = await json(await api(`/api/graph/evidence/${set.evidenceId}`));
    expect(link.source).toEqual({ kind: 'manual', available: true, href: null });

    // A new manager closes the open edge at its start (the commit's closing rule); removing the
    // new one as wrong retracts it and reopens what it closed.
    const next = await json(await api(`/api/graph/entities/${joe}/relations`, { method: 'POST', json: { type: 'REPORTS_TO', toId: jenny } }));
    expect(next.closedRelationIds).toEqual([joeMaria]);
    const closed = await host.prisma.$queryRaw<Array<{ open: boolean; superseded_by_id: string | null }>>`
      SELECT upper_inf(valid) AS open, superseded_by_id::text AS superseded_by_id FROM kg_relations WHERE id = ${joeMaria}::uuid`;
    expect(closed).toEqual([{ open: false, superseded_by_id: next.relation.id }]);
    const removed = await json(await api(`/api/graph/entities/${joe}/relations/${next.relation.id}`, { method: 'DELETE' }));
    expect(removed).toEqual({ relationId: next.relation.id, reviewStatus: 'rejected', reopenedRelationIds: [joeMaria] });
    const reopened = await host.prisma.$queryRaw<Array<{ open: boolean; superseded_by_id: string | null }>>`
      SELECT upper_inf(valid) AS open, superseded_by_id::text AS superseded_by_id FROM kg_relations WHERE id = ${joeMaria}::uuid`;
    expect(reopened).toEqual([{ open: true, superseded_by_id: null }]);
    // A relation that does not start at the entity named in the path is not found there.
    expect((await api(`/api/graph/entities/${maria}/relations/${joeMaria}`, { method: 'DELETE' })).status).toBe(404);

    // Every manual edit carries evidence: still no orphan.
    expect(await orphans('kg_relations', 'relation')).toBe(0);

    // After: Ask follows the manual REPORTS_TO to Maria, and her meeting.
    const answer = await ask(ASK_QUESTIONS.manualBossMeetings);
    expect(answer.status).toBe('complete');
    expect(answer.toolCalls.map((c) => c.name)).toEqual(['search', 'neighbors', 'timeline']);
    expect(answer.toolCalls.every((c) => c.error === null)).toBe(true);
    expect(answer.toolCalls[2].summary).toBe('Timeline of Maria Lopez · 1 event');
    expect(answer.content).toContain('Joe Park');
    expect(answer.content).toContain('Maria Lopez');
    expect(answer.content).toContain(WEEKLY_SYNC.title);
    expect(answer.content).not.toContain(STANDUP.title);
    expect(answer.citations.every((c) => c.valid)).toBe(true);
    // The relation's citation is the owner's own: valid evidence, labelled "Set by hand".
    expect(answer.citations.find((c) => c.via?.kind === 'relation')).toMatchObject({ kind: 'evidence', valid: true, label: 'Set by hand' });
    expect(
      answer.citations.filter((c) => c.kind === 'evidence' && c.via?.kind !== 'relation').every((c) => c.label === WEEKLY_SYNC.title),
    ).toBe(true);
  });

  it('10. runs one housekeeping round and every enqueued job succeeds', async () => {
    const round = await host.housekeeping.runOnce();
    expect(round.kgMigrate).toBe('called');
    expect(round.kgExportExpiry).toBe('called');
    expect(round.transcripts).toBeTruthy();
    expect(round.notes).toBeTruthy();
    await drain();
    expect(await succeeded('notes.housekeeping')).toBe(1);
  });

  it('11. exports the graph as Turtle and imports it back through SHACL validation', async () => {
    const created = await json(await api('/api/graph/exports', { method: 'POST', json: { format: 'turtle' } }), 202);
    exportId = created.export.id;
    await drain();
    const done = await json(await api(`/api/graph/exports/${exportId}`));
    expect(done.status).toBe('ready');
    // Six relations from the meetings, plus Joe's manager set by hand (step 9); the retracted one is not exported.
    expect(done.stats).toMatchObject({ entities: 5, relations: 7, items: 2, excludedSensitive: 0 });

    const turtle = await (await fetch(done.downloadUrl)).text();
    expect(turtle).toContain('Maria Lopez');
    expect(turtle).toContain('Weekly sync with Maria Lopez');

    const form = new FormData();
    form.append('file', new Blob([turtle], { type: 'text/turtle' }), 'graph.ttl');
    const imported = await json(await api('/api/graph/imports', { method: 'POST', body: form }), 202);
    expect(imported.proposalId).toBeTruthy();
    await drain();
    expect(await succeeded('kg.import')).toBe(1);

    // The import produced a draft proposal for review; nothing entered the graph without a commit.
    const proposal = await json(await api(`/api/graph/proposals/${imported.proposalId}`));
    expect(proposal.proposal.status).toBe('draft');
    expect(await host.prisma.$queryRaw`SELECT 1 FROM kg_entities`).toHaveLength(5);
  });

  it('12. refuses at COMMIT a transaction that strips an accepted entity of its evidence (the trigger, proven)', async () => {
    // LAST on purpose: on PGlite the socket drops the connection after this SQL error.
    const joe = people.get('Joe Park') as string;
    const before = await host.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kg_evidence WHERE subject_id = ${joe}::uuid`;
    expect(before[0].n).toBeGreaterThan(0);

    let refusal: unknown;
    try {
      await host.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM kg_evidence WHERE subject_kind::text = 'entity' AND subject_id = ${joe}::uuid`;
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal, 'COMMIT must be refused').toBeDefined();
    expect(String((refusal as Error).message)).toMatch(/no-orphans invariant|23514/);

    // Recover the connection (PGlite: the next query after an SQL error fails once), then prove nothing changed.
    let after: Array<{ n: number }> | undefined;
    for (let attempt = 0; attempt < 3 && !after; attempt += 1) {
      try {
        after = await host.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kg_evidence WHERE subject_id = ${joe}::uuid`;
      } catch {
        /* Connection terminated unexpectedly: retry */
      }
    }
    expect(after?.[0].n).toBe(before[0].n);
    expect(await orphans('kg_entities', 'entity')).toBe(0);
  });
});
