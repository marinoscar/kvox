import { BadRequestException } from '@nestjs/common';

import { chooseSurvivor, MergeService } from './merge.service';

// The SQL half of a merge — re-pointing, duplicate and self-loop collapse,
// distinct-pair rewriting and the exact reverse — is exercised against real
// Postgres in `test/graph/kg-resolution.db.spec.ts`; a mocked transaction
// would only restate the statements. This file pins the pure rule and the
// guards that run before any SQL.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('chooseSurvivor (the curated-survivor rule)', () => {
  const req = { survivorId: B, mergedId: A };

  it('keeps the curated side in an automatic merge when exactly one side is curated', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual({ survivorId: A, mergedId: B });
    expect(chooseSurvivor(req, { [A]: 'edited', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual({ survivorId: A, mergedId: B });
  });

  it('keeps the requested survivor when both or neither side is curated', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'edited' }, 'resolution_proposal')).toEqual(req);
    expect(chooseSurvivor(req, { [A]: 'unreviewed', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual(req);
    expect(chooseSurvivor(req, { [A]: 'unreviewed', [B]: 'accepted' }, 'resolution_proposal')).toEqual(req);
  });

  it('never overrides a manual merge — a person named the survivor', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'unreviewed' }, 'manual')).toEqual(req);
  });
});

describe('MergeService guards', () => {
  it('refuses to merge an entity into itself before touching the database', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new MergeService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      service.merge({ ownerId: 'o', mergedId: A, survivorId: A.toUpperCase(), actorId: 'o', source: 'manual' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
