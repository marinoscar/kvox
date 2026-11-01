import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { GraphActivityService, shapeActivity } from './graph-activity.service.js';

const row = (start: string, entity_id: string, etype: string, n: number) => ({ start, entity_id, etype, n });

describe('shapeActivity (GIC-15)', () => {
  it('stacks by type, sums the total of the stack, and keeps a series per entity', () => {
    const shaped = shapeActivity('month', [
      row('2026-01-01', 'a', 'Person', 2),
      row('2026-01-01', 'b', 'Project', 4),
      row('2026-02-01', 'a', 'Person', 1),
      row('2026-02-01', 'c', 'Person', 3),
    ]);
    expect(shaped.bucket).toBe('month');
    expect(shaped.timeZone).toBe('UTC');
    expect(shaped.series).toEqual([
      { start: '2026-01-01', total: 6, byType: { Person: 2, Project: 4 } },
      { start: '2026-02-01', total: 4, byType: { Person: 4 } },
    ]);
    expect(shaped.byEntity).toEqual({
      a: [
        { start: '2026-01-01', count: 2 },
        { start: '2026-02-01', count: 1 },
      ],
      b: [{ start: '2026-01-01', count: 4 }],
      c: [{ start: '2026-02-01', count: 3 }],
    });
    for (const bucket of shaped.series) {
      expect(bucket.total).toBe(Object.values(bucket.byType).reduce((a, b) => a + b, 0));
    }
  });

  it('orders buckets oldest first whatever order the rows came in', () => {
    const shaped = shapeActivity('week', [row('2026-03-09', 'a', 'Person', 1), row('2026-03-02', 'a', 'Person', 1)]);
    expect(shaped.series.map((b) => b.start)).toEqual(['2026-03-02', '2026-03-09']);
  });

  it('is empty without rows', () => {
    expect(shapeActivity('month', [])).toEqual({ bucket: 'month', timeZone: 'UTC', series: [], byEntity: {} });
    expect(shapeActivity('week', [], 'Asia/Tokyo').timeZone).toBe('Asia/Tokyo');
  });
});

describe('GraphActivityService (mocked)', () => {
  const A = '00000000-0000-4000-8000-00000000000a';

  function service(opts: { readable?: boolean; rows?: unknown[]; failWith?: unknown; zoneKnown?: boolean } = {}) {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: opts.failWith ? jest.fn().mockRejectedValue(opts.failWith) : jest.fn().mockResolvedValue(opts.rows ?? []),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      // `pg_timezone_names`: does Postgres know the zone?
      $queryRaw: jest.fn().mockResolvedValue(opts.zoneKnown === false ? [] : [{ '?column?': 1 }]),
    };
    const neighborhood = {
      assertReadableNodes: jest.fn(async () => {
        if (opts.readable === false) throw new NotFoundException('Entity not found');
      }),
    };
    return {
      svc: new GraphActivityService(prisma as never, neighborhood as never),
      tx,
      neighborhood,
      prisma,
    };
  }

  it('checks every id is a readable node first, and answers 404 without querying when one is not', async () => {
    const { svc, tx, neighborhood } = service({ readable: false });
    await expect(svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' })).rejects.toBeInstanceOf(NotFoundException);
    expect(neighborhood.assertReadableNodes).toHaveBeenCalledWith('u1', [A]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('runs one aggregate under the 3 s statement timeout and shapes the rows', async () => {
    const { svc, tx } = service({ rows: [row('2026-01-01', A, 'Person', 2)] });
    const res = await svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' });
    expect(res.series).toEqual([{ start: '2026-01-01', total: 2, byType: { Person: 2 } }]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("cuts the buckets in the requester's zone: a bound parameter, echoed in the response", async () => {
    const { svc, tx } = service({ rows: [row('2026-10-26', A, 'Person', 1)] });
    const res = await svc.activity({ id: 'u1' }, { ids: [A], bucket: 'week' }, { timeZone: 'America/Chicago' });
    expect(res.timeZone).toBe('America/Chicago');
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values).toContain('America/Chicago');
    // The local wall-clock truncation: the SQL converts to the zone first, never 'UTC' as a literal.
    expect(strings.join('?')).toContain('AT TIME ZONE ');
    expect(strings.join('?')).not.toContain("AT TIME ZONE 'UTC'");
  });

  it('reads a bare from/to day as local midnight in that zone, and a full instant as itself', async () => {
    const { svc, tx } = service();
    await svc.activity(
      { id: 'u1' },
      { ids: [A], bucket: 'month', from: '2026-10-26', to: '2026-11-01T00:00:00Z' },
      { timeZone: 'America/Chicago' },
    );
    const [, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const dates = values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    // 2026-10-26 starts at 05:00Z in Chicago (CDT); the explicit instant is untouched.
    expect(dates).toContain('2026-10-26T05:00:00.000Z');
    expect(dates).toContain('2026-11-01T00:00:00.000Z');
  });

  it('falls back to UTC when Postgres does not know the zone, and asks once per zone', async () => {
    const unknown = service({ zoneKnown: false });
    const res = await unknown.svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' }, { timeZone: 'Europe/Fictional' });
    expect(res.timeZone).toBe('UTC');

    const known = service();
    await known.svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' }, { timeZone: 'Asia/Tokyo' });
    await known.svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' }, { timeZone: 'Asia/Tokyo' });
    expect(known.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // UTC is never queried.
    await known.svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' });
    expect(known.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad from/to as a 400', async () => {
    const { svc } = service();
    await expect(
      svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month', from: '2026-02-30' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('turns a statement timeout into the 503 graph_query_timeout', async () => {
    const { svc } = service({ failWith: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
    const err = await svc.activity({ id: 'u1' }, { ids: [A], bucket: 'month' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ details: { reason: 'graph_query_timeout' } });
  });
});
