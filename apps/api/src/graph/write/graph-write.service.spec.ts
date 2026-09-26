import { computeEffectiveSchema } from '@app/shared/ontology';
import type { Prisma } from '@prisma/client';

import type { EvidenceInput } from '../dto/graph-evidence.dto';
import { toPgRange } from '../temporal';
import type { EvidenceValidator } from './evidence-validator.service';
import { GraphDuplicateError, GraphInvariantError, GraphValidationError } from './graph-write.errors';
import { GraphWriteService } from './graph-write.service';
import { statementHash } from './normalize';

// =============================================================================
// GraphWriteService — every validation branch, against a mocked transaction
// =============================================================================
//
// The real-Postgres behaviour (the trigger, the unique index, `valid`
// round-tripping) is `test/graph/graph-write.db.spec.ts`. This file pins the
// service's own rules and the ORDER of its writes.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const MEETING = '44444444-4444-4444-8444-444444444444';
const SPEAKER = '55555555-5555-4555-8555-555555555555';
const OLDER = '66666666-6666-4666-8666-666666666666';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const evidence = [{ noteId: OWNER, noteVersion: 1, charStart: 0, charEnd: 1, quote: 'x' } as EvidenceInput];

type Mock = jest.Mock;
interface FakeTx {
  kgEntity: Record<'create' | 'findMany' | 'findFirst' | 'findUnique' | 'update', Mock>;
  kgEntityAlias: Record<'createMany' | 'createManyAndReturn' | 'findMany' | 'deleteMany', Mock>;
  kgEvidence: Record<'createMany' | 'createManyAndReturn' | 'findFirst' | 'count' | 'delete', Mock>;
  kgRelation: Record<'create' | 'findFirst' | 'findUnique' | 'update', Mock>;
  kgItem: Record<'create' | 'findFirst' | 'findUnique' | 'update', Mock>;
  transcriptSpeaker: Record<'findFirst', Mock>;
  kgProposalItem: Record<'findFirst', Mock>;
  $executeRaw: Mock;
}

/** Entities the owner holds, live, by id → type. */
const LIVE_ENTITIES: Record<string, string> = { [PERSON]: 'Person', [ORG]: 'Organization', [MEETING]: 'Meeting' };

function fakeTx(): FakeTx {
  const calls: string[] = [];
  const track = (name: string, impl: (...args: never[]) => unknown = () => undefined) =>
    jest.fn(async (...args: never[]) => {
      calls.push(name);
      return impl(...args);
    });
  const tx: FakeTx & { calls: string[] } = {
    calls,
    kgEntity: {
      create: track('kgEntity.create', ((args: { data: Record<string, unknown> }) => ({ id: 'new-entity', ...args.data })) as never),
      findMany: track('kgEntity.findMany', ((args: { where: { id: { in: string[] }; ownerId: string } }) =>
        args.where.ownerId === OWNER
          ? args.where.id.in.filter((id) => LIVE_ENTITIES[id]).map((id) => ({ id, type: LIVE_ENTITIES[id] }))
          : []) as never),
      findFirst: track('kgEntity.findFirst'),
      findUnique: track('kgEntity.findUnique'),
      update: track('kgEntity.update', ((args: { data: Record<string, unknown> }) => ({ id: PERSON, ...args.data })) as never),
    },
    kgEntityAlias: {
      createMany: track('kgEntityAlias.createMany', ((args: { data: unknown[] }) => ({ count: args.data.length })) as never),
      createManyAndReturn: track('kgEntityAlias.createManyAndReturn', ((args: { data: unknown[] }) => args.data) as never),
      findMany: track('kgEntityAlias.findMany', (() => []) as never),
      deleteMany: track('kgEntityAlias.deleteMany', (() => ({ count: 0 })) as never),
    },
    kgEvidence: {
      createMany: track('kgEvidence.createMany', ((args: { data: unknown[] }) => ({ count: args.data.length })) as never),
      createManyAndReturn: track('kgEvidence.createManyAndReturn', ((args: { data: unknown[] }) => args.data) as never),
      findFirst: track('kgEvidence.findFirst'),
      count: track('kgEvidence.count', (() => 1) as never),
      delete: track('kgEvidence.delete'),
    },
    kgRelation: {
      create: track('kgRelation.create', ((args: { data: Record<string, unknown> }) => ({ id: 'new-relation', ...args.data })) as never),
      findFirst: track('kgRelation.findFirst', (() => ({ id: OLDER })) as never),
      findUnique: track('kgRelation.findUnique'),
      update: track('kgRelation.update'),
    },
    kgItem: {
      create: track('kgItem.create', ((args: { data: Record<string, unknown> }) => ({ ...args.data })) as never),
      findFirst: track('kgItem.findFirst', (() => null) as never),
      findUnique: track('kgItem.findUnique'),
      update: track('kgItem.update'),
    },
    transcriptSpeaker: { findFirst: track('transcriptSpeaker.findFirst', (() => ({ id: SPEAKER })) as never) },
    kgProposalItem: { findFirst: track('kgProposalItem.findFirst') },
    $executeRaw: track('$executeRaw', (() => 1) as never),
  };
  return tx;
}

function setup() {
  const validator = { assertReadable: jest.fn(async (_o: string, ev: EvidenceInput[]) => ev) };
  const service = new GraphWriteService(validator as unknown as EvidenceValidator);
  const tx = fakeTx() as FakeTx & { calls: string[] };
  const asTx = tx as unknown as Prisma.TransactionClient;
  return { service, tx, asTx, validator };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

const baseEntity = {
  ownerId: OWNER,
  type: 'Person',
  label: 'Sarah Chen',
  reviewStatus: 'accepted' as const,
  labelSource: 'extraction' as const,
  evidence,
};
const baseRelation = {
  ownerId: OWNER,
  type: 'WORKS_FOR',
  fromId: PERSON,
  toId: ORG,
  validPrecision: 'unknown' as const,
  reviewStatus: 'accepted' as const,
  evidence,
};
const baseItem = {
  ownerId: OWNER,
  kind: 'claim' as const,
  typeKey: 'Claim',
  subjectId: PERSON,
  statement: 'Revenue grew 20%',
  reviewStatus: 'accepted' as const,
  evidence,
};

describe('GraphWriteService', () => {
  // ===========================================================================
  // The invariant, before any SQL
  // ===========================================================================

  describe('evidence is required', () => {
    it.each([
      ['createEntity', (s: GraphWriteService, tx: Prisma.TransactionClient) => s.createEntity(tx, { ...baseEntity, evidence: [] }, schema)],
      ['createRelation', (s: GraphWriteService, tx: Prisma.TransactionClient) => s.createRelation(tx, { ...baseRelation, evidence: [] }, schema)],
      ['createItem', (s: GraphWriteService, tx: Prisma.TransactionClient) => s.createItem(tx, { ...baseItem, evidence: [] }, schema)],
    ])('%s with evidence: [] throws GraphInvariantError before any SQL', async (_name, run) => {
      const { service, tx, asTx, validator } = setup();
      const err = await caught(run(service, asTx));
      expect(err).toBeInstanceOf(GraphInvariantError);
      expect((err as GraphInvariantError).code).toBe('evidence_required');
      expect(tx.calls).toEqual([]);
      expect(validator.assertReadable).not.toHaveBeenCalled();
    });

    it('validates evidence against the owner, on the same transaction', async () => {
      const { service, asTx, validator } = setup();
      await service.createEntity(asTx, baseEntity, schema);
      expect(validator.assertReadable).toHaveBeenCalledWith(OWNER, evidence, asTx);
    });
  });

  // ===========================================================================
  // Entities
  // ===========================================================================

  describe('createEntity', () => {
    it('refuses an unknown type and an item type', async () => {
      const { service, asTx } = setup();
      await expect(service.createEntity(asTx, { ...baseEntity, type: 'Spaceship' }, schema)).rejects.toBeInstanceOf(
        GraphValidationError,
      );
      await expect(service.createEntity(asTx, { ...baseEntity, type: 'Claim' }, schema)).rejects.toMatchObject({
        details: { issues: [expect.objectContaining({ path: 'type' })] },
      });
    });

    it('refuses an undeclared props key, naming it', async () => {
      const { service, asTx } = setup();
      const err = await caught(service.createEntity(asTx, { ...baseEntity, props: { shoeSize: 42 } }, schema));
      expect(err).toBeInstanceOf(GraphValidationError);
      expect((err as GraphValidationError).details).toEqual({
        issues: [expect.objectContaining({ path: 'shoeSize' })],
      });
    });

    it('stamps the ontology version and stores the label as an alias, deduplicated by normalized form', async () => {
      const { service, tx, asTx } = setup();
      await service.createEntity(
        asTx,
        {
          ...baseEntity,
          props: { title: 'CTO' },
          aliases: [
            { alias: 'SARAH  CHEN!', source: 'user' },
            { alias: 'Sally', source: 'user' },
          ],
        },
        schema,
      );

      expect(tx.kgEntity.create.mock.calls[0][0].data).toMatchObject({
        ownerId: OWNER,
        type: 'Person',
        label: 'Sarah Chen',
        props: { title: 'CTO' },
        ontologyVersion: expect.any(String),
      });
      const aliases = tx.kgEntityAlias.createMany.mock.calls[0][0].data;
      expect(aliases).toEqual([
        expect.objectContaining({ alias: 'Sarah Chen', normalized: 'sarah chen', source: 'extraction' }),
        expect.objectContaining({ alias: 'Sally', normalized: 'sally', source: 'user' }),
      ]);
      expect(tx.kgEvidence.createMany.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ ownerId: OWNER, subjectKind: 'entity', subjectId: 'new-entity', quote: 'x' }),
      ]);
    });

    it('refuses an alias that normalizes to the empty string', async () => {
      const { service, tx, asTx } = setup();
      await expect(
        service.createEntity(asTx, { ...baseEntity, aliases: [{ alias: '!!!', source: 'user' }] }, schema),
      ).rejects.toBeInstanceOf(GraphValidationError);
      expect(tx.kgEntity.create).not.toHaveBeenCalled();
    });

    it('refuses a review status that is not accepted/edited', async () => {
      const { service, asTx } = setup();
      await expect(
        service.createEntity(asTx, { ...baseEntity, reviewStatus: 'unreviewed' as never }, schema),
      ).rejects.toBeInstanceOf(GraphValidationError);
    });
  });

  // ===========================================================================
  // Relations
  // ===========================================================================

  describe('createRelation', () => {
    it.each(['ABOUT', 'SUPERSEDES', 'MENTIONS', 'SUPPORTED_BY'])(
      'refuses %s, which is represented as a column elsewhere',
      async (type) => {
        const { service, asTx } = setup();
        await expect(service.createRelation(asTx, { ...baseRelation, type }, schema)).rejects.toMatchObject({
          details: { issues: [expect.objectContaining({ path: 'type' })] },
        });
      },
    );

    it('refuses a wrong endpoint type, naming the endpoint', async () => {
      const { service, asTx } = setup();
      const err = await caught(service.createRelation(asTx, { ...baseRelation, toId: MEETING }, schema));
      expect(err).toBeInstanceOf(GraphValidationError);
      expect((err as GraphValidationError).details).toEqual({
        issues: [{ path: 'toId', message: 'must be one of: Organization' }],
      });
    });

    it('refuses an endpoint that is not a live entity of the owner', async () => {
      const { service, asTx } = setup();
      await expect(
        service.createRelation(asTx, { ...baseRelation, ownerId: '99999999-9999-4999-8999-999999999999' }, schema),
      ).rejects.toMatchObject({ details: { issues: [expect.objectContaining({ path: 'toId' })] } });
    });

    it('refuses fromSpeakerId on a relation other than IDENTIFIED_AS', async () => {
      const { service, asTx } = setup();
      const err = await caught(
        service.createRelation(asTx, { ...baseRelation, fromId: undefined, fromSpeakerId: SPEAKER }, schema),
      );
      expect((err as GraphValidationError).details).toEqual({
        issues: [expect.objectContaining({ path: 'fromSpeakerId' })],
      });
    });

    it('accepts IDENTIFIED_AS from a viewable speaker, and refuses it with fromId too', async () => {
      const { service, tx, asTx } = setup();
      const input = {
        ownerId: OWNER,
        type: 'IDENTIFIED_AS',
        fromSpeakerId: SPEAKER,
        toId: PERSON,
        reviewStatus: 'accepted' as const,
        evidence,
      };
      await service.createRelation(asTx, input, schema);
      expect(tx.transcriptSpeaker.findFirst).toHaveBeenCalled();
      expect(tx.kgRelation.create.mock.calls[0][0].data).toMatchObject({ fromId: null, fromSpeakerId: SPEAKER });

      await expect(service.createRelation(asTx, { ...input, fromId: PERSON }, schema)).rejects.toBeInstanceOf(
        GraphValidationError,
      );
    });

    it('refuses a temporal relation without a precision, naming validPrecision', async () => {
      const { service, asTx } = setup();
      const err = await caught(
        service.createRelation(
          asTx,
          { ...baseRelation, validPrecision: null, valid: { from: new Date('2019-01-01'), to: null } },
          schema,
        ),
      );
      expect((err as GraphValidationError).details).toEqual({
        issues: [expect.objectContaining({ path: 'validPrecision' })],
      });
    });

    it("refuses a range with precision 'unknown', and any range on a non-temporal relation", async () => {
      const { service, asTx } = setup();
      const valid = { from: new Date('2019-01-01'), to: null };
      await expect(
        service.createRelation(asTx, { ...baseRelation, valid, validPrecision: 'unknown' }, schema),
      ).rejects.toMatchObject({ details: { issues: [expect.objectContaining({ path: 'valid' })] } });
      await expect(
        service.createRelation(
          asTx,
          { ...baseRelation, type: 'ATTENDED', toId: MEETING, valid, validPrecision: 'day' },
          schema,
        ),
      ).rejects.toBeInstanceOf(GraphValidationError);
    });

    it("validates props against the relation's own declaration", async () => {
      const { service, asTx } = setup();
      await expect(
        service.createRelation(asTx, { ...baseRelation, type: 'HAS_ROLE', props: { title: 'CTO' } }, schema),
      ).resolves.toBeDefined();
      await expect(
        service.createRelation(asTx, { ...baseRelation, type: 'HAS_ROLE', props: { salary: 1 } }, schema),
      ).rejects.toMatchObject({ details: { issues: [expect.objectContaining({ path: 'salary' })] } });
    });

    it('writes valid and valid_precision together, through toPgRange, before the evidence', async () => {
      const { service, tx, asTx } = setup();
      const valid = { from: new Date('2019-01-01T00:00:00Z'), to: new Date('2026-03-01T00:00:00Z') };
      await service.createRelation(asTx, { ...baseRelation, valid, validPrecision: 'month' }, schema);

      const [strings, ...values] = tx.$executeRaw.mock.calls[0];
      expect((strings as string[]).join('?')).toContain('UPDATE kg_relations SET valid =');
      expect(values).toEqual([toPgRange(valid), 'month', 'new-relation']);
      expect(tx.kgRelation.create.mock.calls[0][0].data).not.toHaveProperty('validPrecision');
    });

    it('supersedes the older relation after the new one exists', async () => {
      const { service, tx, asTx } = setup();
      await service.createRelation(asTx, { ...baseRelation, supersedesId: OLDER }, schema);
      expect(tx.kgRelation.update).toHaveBeenCalledWith({
        where: { id: OLDER },
        data: { supersededById: 'new-relation', reviewStatus: 'superseded' },
      });
    });
  });

  // ===========================================================================
  // Items
  // ===========================================================================

  describe('createItem', () => {
    it('refuses a kind that does not match the type', async () => {
      const { service, asTx } = setup();
      await expect(service.createItem(asTx, { ...baseItem, kind: 'decision' }, schema)).rejects.toMatchObject({
        details: { issues: [expect.objectContaining({ path: 'kind' })] },
      });
    });

    it('defaults status to open for a commitment and active otherwise, and refuses an unknown status', async () => {
      const { service, tx, asTx } = setup();
      await service.createItem(asTx, { ...baseItem, kind: 'commitment', typeKey: 'Commitment' }, schema);
      await service.createItem(asTx, { ...baseItem, kind: 'decision', typeKey: 'Decision' }, schema);
      expect(tx.kgItem.create.mock.calls.map((c) => c[0].data.status)).toEqual(['open', 'active']);

      await expect(service.createItem(asTx, { ...baseItem, status: 'done' }, schema)).rejects.toMatchObject({
        details: { issues: [expect.objectContaining({ path: 'status' })] },
      });
    });

    it('requires a subject for claim and person_fact, of a permitted type', async () => {
      const { service, asTx } = setup();
      await expect(service.createItem(asTx, { ...baseItem, subjectId: null }, schema)).rejects.toMatchObject({
        details: { issues: [expect.objectContaining({ path: 'subjectId' })] },
      });
      await expect(
        service.createItem(
          asTx,
          { ...baseItem, kind: 'person_fact', typeKey: 'PersonFact', subjectId: ORG },
          schema,
        ),
      ).rejects.toMatchObject({ details: { issues: [{ path: 'subjectId', message: 'must be one of: Person' }] } });
    });

    it('checks meeting/owner-person/counterparty references against the item-column relations', async () => {
      const { service, asTx } = setup();
      await expect(
        service.createItem(
          asTx,
          { ...baseItem, kind: 'commitment', typeKey: 'Commitment', meetingId: MEETING, ownerPersonId: PERSON, counterpartyId: ORG },
          schema,
        ),
      ).resolves.toBeDefined();
      // A Claim has no CREATED_IN / DECIDED_IN.
      await expect(service.createItem(asTx, { ...baseItem, meetingId: MEETING }, schema)).rejects.toMatchObject({
        details: { issues: [expect.objectContaining({ path: 'meetingId' })] },
      });
      // ASSIGNED_TO points at a Person, not an Organization.
      await expect(
        service.createItem(asTx, { ...baseItem, kind: 'commitment', typeKey: 'Commitment', ownerPersonId: ORG }, schema),
      ).rejects.toMatchObject({ details: { issues: [expect.objectContaining({ path: 'ownerPersonId' })] } });
    });

    it("defaults a person_fact's sensitivity to personal, and stores null for every other kind", async () => {
      const { service, tx, asTx } = setup();
      await service.createItem(asTx, { ...baseItem, kind: 'person_fact', typeKey: 'PersonFact' }, schema);
      await service.createItem(asTx, { ...baseItem, sensitivity: 'sensitive' }, schema);
      expect(tx.kgItem.create.mock.calls.map((c) => c[0].data.sensitivity)).toEqual(['personal', null]);
    });

    it('hashes the statement with statementHash(kind, statement)', async () => {
      const { service, tx, asTx } = setup();
      await service.createItem(asTx, baseItem, schema);
      expect(tx.kgItem.create.mock.calls[0][0].data.statementHash).toBe(statementHash('claim', 'Revenue grew 20%'));
    });

    it('raises GraphDuplicateError with the live row, before inserting', async () => {
      const { service, tx, asTx } = setup();
      tx.kgItem.findFirst.mockImplementation(async (args: { where: { statementHash?: string } }) =>
        args.where.statementHash ? { id: 'existing' } : { id: OLDER },
      );
      const err = await caught(service.createItem(asTx, baseItem, schema));
      expect(err).toBeInstanceOf(GraphDuplicateError);
      expect((err as GraphDuplicateError).existingId).toBe('existing');
      expect(tx.kgItem.create).not.toHaveBeenCalled();
    });

    it('retires the older item first, then inserts, then links superseded_by_id', async () => {
      const { service, tx, asTx } = setup();
      tx.kgItem.findFirst.mockImplementation(async (args: { where: { id?: unknown } }) =>
        args.where.id === OLDER ? { id: OLDER } : null,
      );
      const created = (await service.createItem(asTx, { ...baseItem, supersedesId: OLDER }, schema)) as { id: string };

      const order = tx.calls.filter((c) => c === 'kgItem.update' || c === 'kgItem.create');
      expect(order).toEqual(['kgItem.update', 'kgItem.create', 'kgItem.update']);
      expect(tx.kgItem.update.mock.calls[0][0]).toEqual({
        where: { id: OLDER },
        data: { reviewStatus: 'superseded', status: 'superseded' },
      });
      expect(tx.kgItem.update.mock.calls[1][0]).toEqual({ where: { id: OLDER }, data: { supersededById: created.id } });
      // The duplicate check never matches the row being superseded.
      expect(tx.kgItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: OLDER } }) }),
      );
    });
  });

  // ===========================================================================
  // Evidence and aliases
  // ===========================================================================

  describe('removeEvidence', () => {
    it('refuses the last citation of an accepted subject', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEvidence.findFirst.mockResolvedValue({ id: 'ev', subjectKind: 'relation', subjectId: 'rel' });
      tx.kgRelation.findUnique.mockResolvedValue({ reviewStatus: 'accepted' });
      tx.kgEvidence.count.mockResolvedValue(1);

      const err = await caught(service.removeEvidence(asTx, OWNER, 'ev'));
      expect(err).toBeInstanceOf(GraphInvariantError);
      expect((err as Error).message).toBe('An accepted fact must keep at least one citation.');
      expect(tx.kgEvidence.delete).not.toHaveBeenCalled();
    });

    it('deletes a citation that is not the last, and the last of an unreviewed subject', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEvidence.findFirst.mockResolvedValue({ id: 'ev', subjectKind: 'entity', subjectId: 'e' });
      tx.kgEntity.findUnique.mockResolvedValueOnce({ reviewStatus: 'edited' });
      tx.kgEvidence.count.mockResolvedValueOnce(2);
      await service.removeEvidence(asTx, OWNER, 'ev');

      tx.kgEntity.findUnique.mockResolvedValueOnce({ reviewStatus: 'unreviewed' });
      await service.removeEvidence(asTx, OWNER, 'ev');

      expect(tx.kgEvidence.delete).toHaveBeenCalledTimes(2);
    });

    it("is a 404 for another owner's evidence", async () => {
      const { service, tx, asTx } = setup();
      tx.kgEvidence.findFirst.mockResolvedValue(null);
      await expect(service.removeEvidence(asTx, OWNER, 'ev')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('addAliases', () => {
    it('skips aliases whose normalized form already exists', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue({ id: PERSON });
      tx.kgEntityAlias.findMany.mockResolvedValue([{ normalized: 'sally' }]);

      await service.addAliases(asTx, OWNER, PERSON, [
        { alias: 'SALLY', source: 'user' },
        { alias: 'Dr. Chen', source: 'user' },
        { alias: 'dr. chen ', source: 'user' },
      ]);

      expect(tx.kgEntityAlias.createManyAndReturn.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ alias: 'Dr. Chen', normalized: 'dr. chen' }),
      ]);
    });
  });

  // ===========================================================================
  // Manual edit
  // ===========================================================================

  describe('updateEntityDetailed', () => {
    const current = {
      id: PERSON,
      ownerId: OWNER,
      type: 'Person',
      label: 'Sarah Chen',
      props: { title: 'CTO' },
      reviewStatus: 'accepted',
    };

    it('refuses a type change', async () => {
      const { service, asTx } = setup();
      await expect(
        service.updateEntityDetailed(asTx, OWNER, PERSON, { type: 'Organization' }, schema),
      ).rejects.toMatchObject({ message: 'Change a type through a proposal.' });
    });

    it('keeps the old label as an alias, adds the new one, and flips accepted to edited', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue(current);

      const result = await service.updateEntityDetailed(asTx, OWNER, PERSON, { label: 'Sarah Chen-Li' }, schema);

      expect(tx.kgEntityAlias.createMany.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ alias: 'Sarah Chen-Li', source: 'user' }),
        expect.objectContaining({ alias: 'Sarah Chen', source: 'user' }),
      ]);
      expect(tx.kgEntity.update).toHaveBeenCalledWith({
        where: { id: PERSON },
        data: { label: 'Sarah Chen-Li', reviewStatus: 'edited' },
      });
      expect(result).toMatchObject({ labelChanged: true, changedKeys: [], changed: true });
    });

    it('merges props, with null clearing a key, and validates the merged result', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue(current);

      const result = await service.updateEntityDetailed(asTx, OWNER, PERSON, { props: { title: null } }, schema);
      expect(tx.kgEntity.update.mock.calls[0][0].data).toEqual({ props: {}, reviewStatus: 'edited' });
      expect(result.changedKeys).toEqual(['title']);

      await expect(
        service.updateEntityDetailed(asTx, OWNER, PERSON, { props: { nope: 1 } }, schema),
      ).rejects.toMatchObject({ details: { issues: [expect.objectContaining({ path: 'nope' })] } });
    });

    it('writes nothing when nothing changed', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue(current);
      const result = await service.updateEntityDetailed(
        asTx,
        OWNER,
        PERSON,
        { label: 'Sarah Chen', props: { title: 'CTO' } },
        schema,
      );
      expect(result.changed).toBe(false);
      expect(tx.kgEntity.update).not.toHaveBeenCalled();
    });

    it('refuses removing the alias that is the current label', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue(current);
      tx.kgEntityAlias.findMany.mockResolvedValue([{ id: 'a1', normalized: 'sarah chen' }]);
      await expect(
        service.updateEntityDetailed(asTx, OWNER, PERSON, { removeAliasIds: ['a1'] }, schema),
      ).rejects.toBeInstanceOf(GraphValidationError);
    });

    it('is a 404 for an entity that is not a live entity of the owner', async () => {
      const { service, tx, asTx } = setup();
      tx.kgEntity.findFirst.mockResolvedValue(null);
      await expect(
        service.updateEntityDetailed(asTx, OWNER, PERSON, { label: 'X' }, schema),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
