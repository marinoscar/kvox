// =============================================================================
// Real-Postgres test: the Ask toolset's owner isolation and its own queries (#377)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db` (CI's Smoke job).
//
// What it proves, against real rows for TWO owners:
//   - owner isolation through every tool: even a handle forged to point at
//     user B's ids (which the toolset itself never issues) returns nothing of
//     B's to user A — the read services and the tools' own queries are
//     owner-scoped in the statement, not only by the handle registry;
//   - `list_commitments`: status, direction, `dueBefore`, and the
//     `due_at ASC NULLS LAST, occurred_at DESC` order;
//   - `GraphEvidenceService.listForSubject`: newest source first, and empty
//     for another owner's subject;
//   - no serialised tool result contains a uuid.
// =============================================================================

import type { PrismaClient } from '@prisma/client';

import { AskToolset } from '../../src/ask/tools/ask-toolset';
import { EntityBriefTool } from '../../src/ask/tools/entity-brief.tool';
import { EvidenceTool } from '../../src/ask/tools/evidence.tool';
import { GetEntityTool } from '../../src/ask/tools/get-entity.tool';
import { ListCommitmentsTool } from '../../src/ask/tools/list-commitments.tool';
import { NeighborsTool } from '../../src/ask/tools/neighbors.tool';
import { SearchTool } from '../../src/ask/tools/search.tool';
import { TimelineTool } from '../../src/ask/tools/timeline.tool';
import type { AskToolContext } from '../../src/ask/tools/ask-tool';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { EntityBriefService } from '../../src/graph/brief/entity-brief.service';
import { EntityViewService } from '../../src/graph/brief/entity-view.service';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { GraphPreferencesService } from '../../src/graph/preferences/graph-preferences.service';
import { GraphEvidenceService } from '../../src/graph/read/graph-evidence.service';
import { GraphNeighborhoodService } from '../../src/graph/read/graph-neighborhood.service';
import { GraphReadService } from '../../src/graph/read/graph-read.service';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';
import { UUID_ANYWHERE } from './ask-tool-fakes';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-tools.db.spec');

const EMAIL_PREFIX = 'ask-tools-test';

describeWithDb('Ask toolset (real Postgres)', () => {
  let prisma: PrismaClient;
  let toolset: AskToolset;
  let evidence: GraphEvidenceService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const access = new GraphAccessService(p);
    const transcriptAccess = new TranscriptAccessService(p);
    const preferences = new GraphPreferencesService(p);
    const ontology = new GraphOntologyService(p, preferences);
    const reads = new GraphReadService(p, access, ontology, transcriptAccess);
    const neighborhood = new GraphNeighborhoodService(p, access, ontology);
    evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p));
    // The document leg's own visibility is SearchService's (and its specs'); stubbed here.
    const search = { search: async () => ({ results: [], nextCursor: null }) };
    const brief = new EntityBriefService(
      p,
      access,
      ontology,
      new EntityViewService(p),
      search as never,
      { resolve: async () => { throw new Error('the Ask tool must never resolve a digest model'); } } as never,
      { enqueue: async () => { throw new Error('the Ask tool must never enqueue'); } } as never,
    );
    toolset = new AskToolset(
      new SearchTool(reads, search as never, p),
      new GetEntityTool(reads, ontology, p),
      new NeighborsTool(neighborhood, p),
      new TimelineTool(reads, p),
      new EvidenceTool(evidence, p),
      new EntityBriefTool(brief, p),
      new ListCommitmentsTool(p),
      preferences,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix: string) {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    const ctx = await toolset.createContext({
      id: user.id,
      email: user.email,
      roles: ['Viewer'],
      permissions: ['graph:read', 'transcripts:read', 'notes:read'],
      isActive: true,
    });
    return { user, ctx, g: new GraphFixture(prisma, user.id) };
  }

  async function call(ctx: AskToolContext, name: string, args: Record<string, unknown>) {
    const out = await toolset.execute(ctx, name, JSON.stringify(args));
    expect(out.json).not.toMatch(UUID_ANYWHERE);
    return out;
  }

  it('never returns another owner’s rows, even through a forged handle', async () => {
    const a = await owner('a');
    const b = await owner('b');
    const aAcme = await a.g.entity('Organization', 'Acme Corp');
    const bAcme = await b.g.entity('Organization', 'Acme Corp');
    const bSarah = await b.g.entity('Person', 'Sarah Secret');
    await b.g.relation('WORKS_AT', bSarah, bAcme);
    await b.g.item('commitment', { ownerPersonId: bSarah, counterpartyId: bAcme, statement: 'B private promise' });
    await a.g.item('commitment', { counterpartyId: aAcme, statement: 'A own promise' });

    // search: A sees only A's Acme.
    const found = await call(a.ctx, 'search', { query: 'Acme Corp', scope: 'entities', limit: 10 });
    expect(found.ok).toBe(true);
    const entities = (JSON.parse(found.json) as { entities: { ref: string }[] }).entities;
    expect(entities).toHaveLength(1);
    expect(a.ctx.handles.resolve(entities[0].ref)?.id).toBe(aAcme);

    // Forge handles to B's ids — something no tool would ever issue to A.
    const forgedAcme = a.ctx.handles.register({ kind: 'ent', id: bAcme, label: 'forged' });
    const forgedSarah = a.ctx.handles.register({ kind: 'ent', id: bSarah, label: 'forged' });

    for (const [name, args] of [
      ['get_entity', { entity: forgedAcme }],
      ['neighbors', { entity: forgedAcme }],
      ['timeline', { entity: forgedSarah }],
      ['evidence', { subject: forgedAcme }],
      ['entity_brief', { entity: forgedAcme }],
    ] as const) {
      const out = await call(a.ctx, name, args);
      expect({ name, ok: out.ok }).toEqual({ name, ok: false });
      expect(out.json).not.toContain('Secret');
      expect(out.json).not.toContain('B private');
    }

    const commitments = await call(a.ctx, 'list_commitments', { entity: forgedSarah, direction: 'any' });
    expect(JSON.parse(commitments.json)).toEqual({ items: [], truncated: false });
    const all = await call(a.ctx, 'list_commitments', {});
    expect(JSON.stringify(JSON.parse(all.json))).toContain('A own promise');
    expect(all.json).not.toContain('B private');
  });

  it('answers the tools for the caller’s own graph', async () => {
    const a = await owner('a');
    const acme = await a.g.entity('Organization', 'Globex');
    const sarah = await a.g.entity('Person', 'Sarah Chen');
    await a.g.relation('WORKS_AT', sarah, acme, { valid: '[2019-03-01,)', precision: 'month' });
    await a.g.item('decision', { subjectId: acme, statement: 'Renew Globex', occurredAt: new Date('2026-09-01T00:00:00Z') });
    await a.g.item('person_fact', { subjectId: sarah, statement: 'Private hobby', sensitivity: 'personal' });
    await a.g.item('person_fact', { subjectId: sarah, statement: 'Health detail', sensitivity: 'sensitive' });

    const h = a.ctx.handles.register({ kind: 'ent', id: sarah, label: 'Sarah Chen' });
    for (const [name, args] of [
      ['get_entity', { entity: h }],
      ['neighbors', { entity: h, hops: 2 }],
      ['timeline', { entity: h }],
      ['evidence', { subject: h }],
      ['entity_brief', { entity: h }],
    ] as const) {
      const out = await call(a.ctx, name, args);
      expect({ name, ok: out.ok }).toEqual({ name, ok: true });
      expect(out.json).not.toContain('Health detail');
      expect(out.json).not.toContain('Private hobby');
    }
  });

  it('list_commitments filters and orders by due date, then by when it was made', async () => {
    const a = await owner('a');
    const sarah = await a.g.entity('Person', 'Sarah');
    const acme = await a.g.entity('Organization', 'Acme');
    const mk = (statement: string, opts: Record<string, unknown>) => a.g.item('commitment', { statement, ...opts });
    await mk('due late', { ownerPersonId: sarah, dueAt: new Date('2026-12-01T00:00:00Z'), occurredAt: new Date('2026-01-01T00:00:00Z') });
    await mk('due soon', { ownerPersonId: sarah, dueAt: new Date('2026-10-01T00:00:00Z'), occurredAt: new Date('2026-01-01T00:00:00Z') });
    await mk('no due, newer', { ownerPersonId: sarah, occurredAt: new Date('2026-06-01T00:00:00Z') });
    await mk('no due, older', { ownerPersonId: sarah, occurredAt: new Date('2026-02-01T00:00:00Z') });
    await mk('owed to sarah', { ownerPersonId: acme, counterpartyId: sarah, dueAt: new Date('2026-11-01T00:00:00Z') });
    await mk('done already', { ownerPersonId: sarah, status: 'done' });
    await mk('draft', { ownerPersonId: sarah, reviewStatus: 'unreviewed' });

    const h = a.ctx.handles.register({ kind: 'ent', id: sarah, label: 'Sarah' });
    const statements = async (args: Record<string, unknown>) => {
      const out = await call(a.ctx, 'list_commitments', args);
      expect(out.ok).toBe(true);
      return (JSON.parse(out.json) as { items: { statement: string }[] }).items.map((i) => i.statement);
    };

    expect(await statements({ entity: h, direction: 'owned_by' })).toEqual(['due soon', 'due late', 'no due, newer', 'no due, older']);
    expect(await statements({ entity: h, direction: 'owed_to' })).toEqual(['owed to sarah']);
    expect(await statements({ entity: h })).toEqual(['due soon', 'owed to sarah', 'due late', 'no due, newer', 'no due, older']);
    expect(await statements({ entity: h, dueBefore: '2026-11-01' })).toEqual(['due soon', 'owed to sarah']);
    expect(await statements({ entity: h, status: 'done' })).toEqual(['done already']);
    expect(await statements({ entity: h, status: 'any', direction: 'owned_by' })).toHaveLength(5);
  });

  it('GraphEvidenceService.listForSubject: newest source first, owner-scoped', async () => {
    const a = await owner('a');
    const b = await owner('b');
    const acme = await a.g.entity('Organization', 'Acme');
    const oldT = await a.g.transcript({ recordedAt: new Date('2025-01-01T00:00:00Z'), title: 'Old call' });
    const newT = await a.g.transcript({ recordedAt: new Date('2026-06-01T00:00:00Z'), title: 'New call' });
    await a.g.evidence('entity', acme, { transcriptId: oldT.transcript.id, segmentId: oldT.segment.id, quote: 'old' });
    await a.g.evidence('entity', acme, { transcriptId: newT.transcript.id, segmentId: newT.segment.id, startMs: 1500, quote: 'new' });

    const rows = await evidence.listForSubject(a.user.id, 'entity', acme, 10);
    expect(rows.map((r) => r.link.quote)).toEqual(['new', 'old', 'Acme']);
    expect(rows[0].occurredAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(rows[2].occurredAt).toBeNull();
    expect(await evidence.listForSubject(b.user.id, 'entity', acme, 10)).toEqual([]);
    expect(await evidence.listForSubject(a.user.id, 'entity', acme, 1)).toHaveLength(1);
  });
});
