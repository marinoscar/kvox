import { NotFoundException } from '@nestjs/common';
import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import type { KvoxEventsPort } from '../ports/index.js';
import { auditPortOver } from './__fixtures__/audit-port.js';
import type { GraphAccessService } from './access/graph-access.service.js';
import type { KvoxGraphDb } from './data/graph-db.js';
import type { GraphEntitiesService } from './graph-entities.service.js';
import {
  GRAPH_RELATION_REMOVED_ACTION,
  GRAPH_RELATION_SET_ACTION,
  GraphRelationEditsService,
  manualRelationQuote,
} from './graph-relation-edits.service.js';
import type { GraphOntologyService } from './ontology/graph-ontology.service.js';
import { GraphValidationError } from './write/graph-write.errors.js';
import type { GraphWriteService } from './write/graph-write.service.js';
import { ManualEvidence } from './write/manual-evidence.js';

// =============================================================================
// GraphRelationEditsService (#586) — the manual relation edit's envelope and
// its use of the shared closing rule, against a mocked transaction. The real
// database leg (the trigger, the reopened range) is the bare host's e2e.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const JENNY = '22222222-2222-4222-8222-222222222222';
const MARK = '33333333-3333-4333-8333-333333333333';
const WILL = '44444444-4444-4444-8444-444444444444';
const OLD_EDGE = '55555555-5555-4555-8555-555555555555';
const NEW_EDGE = '66666666-6666-4666-8666-666666666666';
const EVIDENCE = '77777777-7777-4777-8777-777777777777';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });

const entity = (id: string, label: string, type = 'Person') => ({ id, ownerId: OWNER, type, label, reviewStatus: 'accepted' });

interface EdgeRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  props: unknown;
  valid: string | null;
  valid_precision: string | null;
  review_status: string;
}

function setup(opts: { edges?: EdgeRow[]; toType?: string } = {}) {
  const edges = opts.edges ?? [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) return [{ id: JENNY }];
      if (sql.includes('FROM kg_relations r')) return edges;
      return [];
    }),
    kgEvidence: { findFirst: jest.fn(async () => ({ id: EVIDENCE })) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    $queryRaw: jest.fn(async () => [
      {
        id: NEW_EDGE,
        type: 'REPORTS_TO',
        from_id: JENNY,
        to_id: MARK,
        props: {},
        valid: '["2026-10-17 00:00:00+00",)',
        valid_precision: 'day',
        review_status: 'edited',
      },
    ]),
    auditEvent: { create: jest.fn(async (_args: { data: unknown }) => ({})) },
  };
  const rows: Record<string, ReturnType<typeof entity>> = {
    [JENNY]: entity(JENNY, 'Jenny Kim'),
    [MARK]: entity(MARK, 'Mark Chen', opts.toType ?? 'Person'),
  };
  const access = {
    require: jest.fn(async (_u: string, kind: string, id: string) => {
      if (kind === 'relation') return { id, ownerId: OWNER, type: 'REPORTS_TO', fromId: JENNY, toId: MARK, reviewStatus: 'edited' };
      if (!rows[id]) throw new NotFoundException('Entity not found');
      return rows[id];
    }),
  };
  const write = {
    createRelation: jest.fn(async () => ({ id: NEW_EDGE })),
    addEvidence: jest.fn(async () => [{ id: EVIDENCE }]),
    closeRelation: jest.fn(async () => undefined),
    retractRelation: jest.fn(async () => ({ reopenedIds: [OLD_EDGE] })),
  };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schema) };
  const events = { emit: jest.fn() };
  const entities = { enqueueFollowUps: jest.fn(async () => undefined) };
  class Fixed extends GraphRelationEditsService {
    protected override now(): Date {
      return new Date('2026-10-17T15:00:00Z');
    }
  }
  const service = new Fixed(
    prisma as unknown as KvoxGraphDb,
    access as unknown as GraphAccessService,
    ontology as unknown as GraphOntologyService,
    write as unknown as GraphWriteService,
    entities as unknown as GraphEntitiesService,
    events as unknown as KvoxEventsPort,
    auditPortOver(prisma),
  );
  return { service, tx, prisma, access, write, events, entities };
}

const user = { id: OWNER, permissions: ['graph:write'] } as never;
const openEdge = (id: string, to: string, valid: string | null, precision: string | null = valid ? 'year' : 'unknown'): EdgeRow => ({
  id,
  type: 'REPORTS_TO',
  from_id: JENNY,
  to_id: to,
  props: {},
  valid,
  valid_precision: precision,
  review_status: 'accepted',
});

describe('GraphRelationEditsService.set', () => {
  it('authorises BOTH endpoints at edit level before anything else', async () => {
    const { service, access } = setup();
    await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);
    expect(access.require).toHaveBeenCalledWith(OWNER, 'entity', JENNY, 'edit', ['graph:write']);
    expect(access.require).toHaveBeenCalledWith(OWNER, 'entity', MARK, 'edit', ['graph:write']);
  });

  it("answers 404 for a target that is not the caller's, and writes nothing", async () => {
    const { service, write, prisma } = setup();
    await expect(service.set(JENNY, { type: 'REPORTS_TO', toId: WILL }, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(write.createRelation).not.toHaveBeenCalled();
  });

  it('creates a dated, open, edited relation through GraphWriteService with ONE manual citation', async () => {
    const { service, write } = setup();
    const result = await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);

    expect(write.createRelation).toHaveBeenCalledTimes(1);
    const [, input] = write.createRelation.mock.calls[0] as unknown as [unknown, Record<string, any>];
    expect(input).toMatchObject({
      ownerId: OWNER,
      type: 'REPORTS_TO',
      fromId: JENNY,
      toId: MARK,
      props: {},
      valid: { from: new Date('2026-10-17T00:00:00Z'), to: null },
      validPrecision: 'day',
      reviewStatus: 'edited',
    });
    expect(input.evidence).toHaveLength(1);
    expect(input.evidence[0]).toBeInstanceOf(ManualEvidence);
    expect(input.evidence[0].quote).toBe('Set by hand: Jenny Kim reports to Mark Chen');
    expect(result).toMatchObject({ created: true, evidenceId: EVIDENCE, closedRelationIds: [], flags: [] });
    expect(result.relation).toMatchObject({ id: NEW_EDGE, valid: { from: '2026-10-17T00:00:00.000Z', to: null, precision: 'day' } });
  });

  it("closes the person's still-open REPORTS_TO to someone else at the new start, linked to the new edge (§5.4)", async () => {
    const { service, write } = setup({ edges: [openEdge(OLD_EDGE, WILL, '["2020-01-01 00:00:00+00",)')] });
    const result = await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK, validFrom: '2026-03-01' }, user);

    expect(write.closeRelation).toHaveBeenCalledWith(expect.anything(), OWNER, OLD_EDGE, {
      valid: { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2026-03-01T00:00:00Z') },
      validPrecision: 'year',
      supersededById: NEW_EDGE,
    });
    expect(result.closedRelationIds).toEqual([OLD_EDGE]);
  });

  it('never closes an undated edge of a different fact: it is flagged unordered', async () => {
    const { service, write } = setup({ edges: [openEdge(OLD_EDGE, WILL, null)] });
    const result = await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);
    expect(write.closeRelation).not.toHaveBeenCalled();
    expect(result.flags).toEqual(['unordered']);
  });

  it('cites the existing edge instead of duplicating the same fact (restated)', async () => {
    const { service, write } = setup({ edges: [openEdge(OLD_EDGE, MARK, '["2020-01-01 00:00:00+00",)')] });
    const result = await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);
    expect(write.createRelation).not.toHaveBeenCalled();
    expect(write.addEvidence).toHaveBeenCalledWith(expect.anything(), OWNER, 'relation', OLD_EDGE, [expect.any(ManualEvidence)]);
    expect(result).toMatchObject({ created: false, evidenceId: EVIDENCE });
  });

  it('cites an UNDATED edge of the same fact rather than adding a dated twin', async () => {
    const { service, write } = setup({ edges: [openEdge(OLD_EDGE, MARK, null)] });
    const result = await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);
    expect(write.createRelation).not.toHaveBeenCalled();
    expect(write.addEvidence).toHaveBeenCalledWith(expect.anything(), OWNER, 'relation', OLD_EDGE, [expect.any(ManualEvidence)]);
    expect(result.created).toBe(false);
  });

  it('writes a HAS_ROLE with its title and business unit, quoted', async () => {
    const { service, write } = setup({ toType: 'Organization' });
    await service.set(JENNY, { type: 'HAS_ROLE', toId: MARK, props: { title: 'VP', businessUnit: 'Finance' } }, user);
    const [, input] = write.createRelation.mock.calls[0] as unknown as [unknown, Record<string, any>];
    expect(input.props).toEqual({ title: 'VP', businessUnit: 'Finance' });
    expect(input.evidence[0].quote).toBe('Set by hand: Jenny Kim is VP, Finance at Mark Chen');
  });

  it('maps a GraphWriteService validation error (a wrong endpoint type) to a 400', async () => {
    const { service, write } = setup();
    write.createRelation.mockRejectedValueOnce(new GraphValidationError("'WORKS_FOR' cannot point at a Person.", { issues: [] }));
    await expect(service.set(JENNY, { type: 'WORKS_FOR', toId: MARK }, user)).rejects.toMatchObject({ status: 400 });
  });

  it('audits ids, types and counts only, then emits graph.changed and enqueues follow-ups for both ends', async () => {
    const { service, prisma, events, entities } = setup({ edges: [openEdge(OLD_EDGE, WILL, '["2020-01-01 00:00:00+00",)')] });
    await service.set(JENNY, { type: 'REPORTS_TO', toId: MARK }, user);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: OWNER,
        action: GRAPH_RELATION_SET_ACTION,
        targetType: 'kg_entity',
        targetId: JENNY,
        meta: { relationId: NEW_EDGE, relationType: 'REPORTS_TO', toId: MARK, created: true, closed: 1, flags: [] },
      },
    });
    const meta = JSON.stringify(prisma.auditEvent.create.mock.calls);
    expect(meta).not.toContain('Jenny');
    expect(meta).not.toContain('Mark');
    expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'manual_edit' });
    expect(entities.enqueueFollowUps.mock.calls).toEqual([
      [OWNER, JENNY],
      [OWNER, MARK],
    ]);
  });

  it('refuses a relation to the entity itself', async () => {
    const { service } = setup();
    await expect(service.set(JENNY, { type: 'REPORTS_TO', toId: JENNY }, user)).rejects.toMatchObject({ status: 400 });
  });
});

describe('GraphRelationEditsService.remove', () => {
  it('retracts through GraphWriteService and reports what was reopened', async () => {
    const { service, write, prisma, events } = setup();
    const result = await service.remove(JENNY, NEW_EDGE, user);
    expect(write.retractRelation).toHaveBeenCalledWith(expect.anything(), OWNER, NEW_EDGE);
    expect(result).toEqual({ relationId: NEW_EDGE, reviewStatus: 'rejected', reopenedRelationIds: [OLD_EDGE] });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: GRAPH_RELATION_REMOVED_ACTION,
        meta: { relationId: NEW_EDGE, relationType: 'REPORTS_TO', toId: MARK, reopened: 1 },
      }),
    });
    expect(events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'manual_edit' });
  });

  it('is a 404 for a relation that does not start at this entity', async () => {
    const { service, write } = setup();
    await expect(service.remove(MARK, NEW_EDGE, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(write.retractRelation).not.toHaveBeenCalled();
  });

  it('is a 400 for a relation type the manual edit does not own', async () => {
    const { service, access, write } = setup();
    access.require.mockImplementation((async (_u: string, kind: string, id: string) =>
      kind === 'relation'
        ? { id, ownerId: OWNER, type: 'ATTENDED', fromId: JENNY, toId: MARK, reviewStatus: 'accepted' }
        : entity(id, 'x')) as never);
    await expect(service.remove(JENNY, NEW_EDGE, user)).rejects.toMatchObject({ status: 400 });
    expect(write.retractRelation).not.toHaveBeenCalled();
  });
});

describe('manualRelationQuote', () => {
  it('reads as the fact, for each type', () => {
    expect(manualRelationQuote('WORKS_FOR', 'Jenny Kim', 'Acme')).toBe('Set by hand: Jenny Kim works for Acme');
    expect(manualRelationQuote('HAS_ROLE', 'Jenny Kim', 'Acme', { title: 'CFO' })).toBe('Set by hand: Jenny Kim is CFO at Acme');
  });
});
