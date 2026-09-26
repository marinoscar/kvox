import { ONTOLOGY } from '@app/shared/ontology';

import { edgeValid, itemLabel, mergeEdgeRows, type EdgeRow } from './graph-neighborhood.service';
import { GRAPH_QUERY_TIMEOUT_REASON, isStatementTimeout, withGraphStatementTimeout } from './graph-query-timeout';
import { ITEM_COLUMN_EDGES, itemColumnEdges } from './virtual-edges';

// Pure pieces of the neighbourhood slice (#370): edge merging, labels, the
// registry-derived item edges and the timeout mapping.

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const I = '00000000-0000-4000-8000-0000000000c1';

const row = (over: Partial<EdgeRow>): EdgeRow => ({
  id: 'x',
  type: 'ABOUT',
  source: I,
  target: A,
  vfrom: null,
  vto: null,
  vnull: true,
  precision: null,
  confidence: null,
  virtual: true,
  ...over,
});

describe('mergeEdgeRows', () => {
  it('lets a stored relation win over a derived edge with the same (type, from, to)', () => {
    const stored = row({ id: 'r-1', virtual: false, confidence: 0.9 });
    const derived = row({ id: `virt:${I}:ABOUT` });
    expect(mergeEdgeRows([derived, stored])).toEqual([
      { id: 'r-1', type: 'ABOUT', source: I, target: A, valid: null, confidence: 0.9, virtual: false },
    ]);
  });

  it('emits each derived edge once, with the virt: id, sorted', () => {
    const edges = mergeEdgeRows([
      row({ type: 'OWED_TO', target: B }),
      row({ type: 'ASSIGNED_TO' }),
      row({ type: 'ASSIGNED_TO' }),
    ]);
    expect(edges.map((e) => e.id)).toEqual([`virt:${I}:ASSIGNED_TO`, `virt:${I}:OWED_TO`]);
    expect(edges.every((e) => e.virtual)).toBe(true);
  });
});

describe('edgeValid', () => {
  it('is null for a non-temporal edge', () => {
    expect(edgeValid({ vfrom: null, vto: null, vnull: true, precision: null })).toBeNull();
  });
  it('reports an unknown-precision edge as unbounded', () => {
    expect(edgeValid({ vfrom: null, vto: null, vnull: true, precision: 'unknown' })).toEqual({
      from: null,
      to: null,
      precision: 'unknown',
    });
  });
  it('carries finite and infinite bounds', () => {
    expect(
      edgeValid({ vfrom: new Date('2019-01-01T00:00:00Z'), vto: null, vnull: false, precision: 'year' }),
    ).toEqual({ from: '2019-01-01T00:00:00.000Z', to: null, precision: 'year' });
  });
});

describe('itemLabel', () => {
  it('prefers the title, else the first 80 characters of the statement', () => {
    expect(itemLabel('Send deck', 'Sarah will send the deck')).toBe('Send deck');
    expect(itemLabel(null, 'short')).toBe('short');
    const long = 'x'.repeat(200);
    expect(itemLabel('  ', long)).toHaveLength(80);
  });
});

describe('item-column edges', () => {
  it('are generated from the registry, never hardcoded', () => {
    const expected = ONTOLOGY.relationTypes()
      .filter((r) => r.representation.kind === 'item_column')
      .map((r) => r.key)
      .sort();
    expect(ITEM_COLUMN_EDGES.map((e) => e.type).sort()).toEqual(expected);
    expect(itemColumnEdges()).toEqual(ITEM_COLUMN_EDGES);
  });

  it('map meeting_id to CREATED_IN for commitments and DECIDED_IN for decisions', () => {
    const byType = Object.fromEntries(ITEM_COLUMN_EDGES.map((e) => [e.type, e]));
    expect(byType.CREATED_IN).toEqual({ type: 'CREATED_IN', column: 'meeting_id', kinds: ['commitment'] });
    expect(byType.DECIDED_IN).toEqual({ type: 'DECIDED_IN', column: 'meeting_id', kinds: ['decision'] });
    expect(byType.ABOUT.column).toBe('subject_id');
    expect(byType.ABOUT.kinds).toEqual(['claim', 'commitment', 'decision', 'person_fact']);
  });
});

describe('statement timeout', () => {
  it('recognises SQLSTATE 57014 however it is wrapped', () => {
    expect(isStatementTimeout({ meta: { driverAdapterError: { cause: { originalCode: '57014' } } } })).toBe(true);
    expect(isStatementTimeout(new Error('canceling statement due to statement timeout'))).toBe(true);
    expect(isStatementTimeout({ code: 'P2028' })).toBe(true);
    expect(isStatementTimeout(new Error('duplicate key'))).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
  });

  it('maps a timeout to a 503 graph_query_timeout and logs a warning without labels', async () => {
    const logger = { warn: jest.fn() };
    const prisma = {
      $transaction: jest.fn(async () => {
        throw new Error('canceling statement due to statement timeout');
      }),
    };
    const err = await withGraphStatementTimeout(prisma as never, logger as never, { ownerId: A }, async () => 1).catch(
      (e: unknown) => e,
    );
    expect((err as { getStatus(): number }).getStatus()).toBe(503);
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      details: { reason: GRAPH_QUERY_TIMEOUT_REASON },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ ownerId: A }));
  });

  it('sets a local statement_timeout inside the transaction and passes other errors through', async () => {
    const tx = { $executeRawUnsafe: jest.fn() };
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    await expect(withGraphStatementTimeout(prisma as never, { warn: jest.fn() } as never, {}, async () => 'ok')).resolves.toBe('ok');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL statement_timeout = '3000ms'");

    const boom = new Error('boom');
    await expect(
      withGraphStatementTimeout(prisma as never, { warn: jest.fn() } as never, {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
