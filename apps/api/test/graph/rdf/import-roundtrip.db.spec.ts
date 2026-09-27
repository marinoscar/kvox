// =============================================================================
// Real-Postgres: `kg.import` end to end, and the export → import round trip
// (#387, docs/specs/ontology.md §16 P7, §18.3)
// =============================================================================
//
// What only a real database (and the real SHACL engine) can show:
//
//   - ROUND TRIP: #386's export of a fixture owner A, imported into an empty
//     owner B, yields a draft that — after "accept all" and #366's commit —
//     reproduces A's entities (type, label, props, aliases) and relations
//     (type, endpoints by label, valid range, precision). Ids differ.
//     `sensitive` facts are absent on both sides. Every committed row cites
//     the import (`import_object_id` + `source_iri`).
//   - An attribute of A's (unknown to B) arrives as an OFFER; accepting it
//     creates B's own `kg_attribute_defs` row and moves the values into props.
//   - An invalid file fails `shacl_violations` and writes NOTHING to any graph
//     table or any proposal row.
//   - A newer-major file fails `ontology_version_newer`.
//   - An imported "Joe Smith" resolves to B's existing Joe (resolution runs).
//   - A JSON-LD CRM export imports.
//
// Excluded from `npm test`; run by `npm run test:db` (CI's Smoke job). Storage
// is faked (bytes kept in memory); every `storage_objects` row is real.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import type { KgExport, PrismaClient } from '@prisma/client';
import { ONTOLOGY } from '@app/shared/ontology';

import type { RequestUser } from '../../../src/auth/interfaces/authenticated-user.interface';
import { GraphAccessService } from '../../../src/graph/access/graph-access.service';
import { GraphAttributeDefsService } from '../../../src/graph/attribute-defs/graph-attribute-defs.service';
import { GraphExportSource } from '../../../src/graph/export/graph-export.source';
import { KgExportHandler } from '../../../src/graph/export/kg-export.handler';
import { ProposalStageRegistry } from '../../../src/graph/extraction/proposal-stage';
import type { GraphObjectsService } from '../../../src/graph/graph-objects.service';
import type { GraphImportOffer, GraphImportStats } from '../../../src/graph/import/dto/graph-import.dto';
import { GraphImportService } from '../../../src/graph/import/graph-import.service';
import { KgImportHandler } from '../../../src/graph/import/kg-import.handler';
import { KgMigrateRepository } from '../../../src/graph/migrate/kg-migrate.repository';
import { KgPurgeService } from '../../../src/graph/purge/kg-purge.service';
import { GraphOntologyService } from '../../../src/graph/ontology/graph-ontology.service';
import { GraphPreferencesService } from '../../../src/graph/preferences/graph-preferences.service';
import { CandidateService } from '../../../src/graph/resolution/candidate.service';
import { ContextFeatureService } from '../../../src/graph/resolution/context-features.service';
import { ResolutionService } from '../../../src/graph/resolution/resolution.service';
import { ResolutionStage } from '../../../src/graph/resolution/resolution.stage';
import { NoteAccessService } from '../../../src/notes/access/note-access.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../../src/transcripts/transcript-access.service';
import { resolveDbSuite } from '../../jobs/db-test-support';
import { buildServices } from '../kg-proposal-db-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph-read.fixtures';
import { importFixture, type ImportFixture } from './import-fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('import-roundtrip.db.spec');

const EMAIL_PREFIX = 'graph-import-test';
const PERMS = ['graph:read', 'graph:write'];

describeWithDb('kg.import — validation, proposal and round trip (real Postgres)', () => {
  let prisma: PrismaClient;
  let db: PrismaService;
  let ontology: GraphOntologyService;
  let source: GraphExportSource;
  let services: ReturnType<typeof buildServices>;
  const files = new Map<string, string>();

  /** In-memory bytes behind real, managed `storage_objects` rows. */
  const objects = {
    putStream: (input: { storageKey: string; name: string; mimeType: string; ownerId: string }) => {
      const body = new PassThrough();
      const chunks: Buffer[] = [];
      body.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise((resolve, reject) => {
        body.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          prisma.storageObject
            .create({
              data: {
                name: input.name,
                size: BigInt(Buffer.byteLength(text)),
                mimeType: input.mimeType,
                storageKey: input.storageKey,
                managedBy: 'graph',
                status: 'ready',
                uploadedById: input.ownerId,
              },
            })
            .then((row) => {
              files.set(row.id, text);
              files.set(input.storageKey, text);
              resolve(row);
            }, reject);
        });
      });
      return { body, done };
    },
    openStream: async (objectId: string) => {
      const object = await prisma.storageObject.findUnique({ where: { id: objectId } });
      const text = files.get(objectId);
      if (!object || text === undefined) return null;
      return { stream: Readable.from([Buffer.from(text)]), object };
    },
    signedUrlFor: async () => null,
    // What the real one does to the row: `kg.purge` sweeps import files through it.
    deleteIfPresent: async (id: string | null | undefined) => {
      if (!id) return false;
      files.delete(id);
      return (await prisma.storageObject.deleteMany({ where: { id } })).count > 0;
    },
  } as unknown as GraphObjectsService;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    db = prisma as unknown as PrismaService;
    ontology = new GraphOntologyService(db, new GraphPreferencesService(db));
    source = new GraphExportSource(db, ontology, new TranscriptAccessService(db), new NoteAccessService(db));
    services = buildServices(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    for (const { id } of users) {
      await prisma.kgExport.deleteMany({ where: { ownerId: id } });
      await new KgPurgeService(db, objects).purgeAll(id);
      await prisma.auditEvent.deleteMany({ where: { actorUserId: id } });
    }
    await prisma.kgAttributeDef.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.userSettings.deleteMany({ where: { user: { email: { startsWith: EMAIL_PREFIX } } } });
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
    files.clear();
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Harness
  // ---------------------------------------------------------------------------

  const caller = (id: string): RequestUser => ({ id, email: `${id}@example.test`, roles: [], permissions: PERMS, isActive: true });

  /** No AI key: adjudication is unavailable, so a middle-band match stays uncertain. */
  const NO_ADJUDICATION = { adjudicate: jest.fn(), buildCandidateDossiers: async () => new Map() };
  /** An adjudicator that calls every middle-band pair the same entity. */
  const SAYS_SAME = {
    buildCandidateDossiers: async (_owner: string, ids: string[]) => new Map(ids.map((id) => [id, { entityId: id }])),
    adjudicate: async (_user: string, pairs: Array<{ pairId: string }>) =>
      new Map(pairs.map((p) => [p.pairId, { verdict: 'same', rationale: 'Same person.', model: 'fake-model' }])),
  };

  function importHandler(adjudication: object = NO_ADJUDICATION): KgImportHandler {
    const stages = new ProposalStageRegistry();
    const resolution = new ResolutionService(
      db,
      new CandidateService(db),
      new ContextFeatureService(db),
      { resolve: async () => ({ ok: false, reason: 'ai_key_missing' }) } as never,
      adjudication as never,
      { registerProviderKey: jest.fn() } as never,
    );
    new ResolutionStage(stages, resolution).onModuleInit();
    return new KgImportHandler(
      { register: () => undefined } as never,
      db,
      objects,
      ontology,
      new GraphPreferencesService(db),
      stages,
      { registerProviderKey: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
      new KgMigrateRepository(db),
    );
  }

  function importService(): GraphImportService {
    const access = new GraphAccessService(db);
    return new GraphImportService(
      db,
      { get: async () => ({ graphEnabled: true }) } as never,
      objects,
      { enqueueWithin: jest.fn() } as never,
      access,
      ontology,
      new GraphAttributeDefsService(db, access, ontology),
    );
  }

  /** Store `text` for `ownerId`, create the extracting import proposal, run `kg.import`. */
  async function runImport(ownerId: string, text: string, format: 'turtle' | 'jsonld' | 'nquads', filename: string, adjudication?: object) {
    const { body, done } = objects.putStream({ storageKey: `graph/${ownerId}/imports/${randomUUID()}.x`, name: filename, mimeType: 'text/turtle', ownerId });
    body.end(Buffer.from(text));
    const object = (await done) as { id: string };
    const proposal = await prisma.kgProposal.create({
      data: { ownerId, kind: 'import', status: 'extracting', stats: { filename, format, bytes: Buffer.byteLength(text) } },
    });
    await importHandler(adjudication).process({ id: randomUUID(), payload: { proposalId: proposal.id, ownerId, objectId: object.id, format } } as never);
    const done2 = await prisma.kgProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    return { proposal: done2, stats: done2.stats as unknown as GraphImportStats & { failure?: { message: string } }, objectId: object.id };
  }

  async function runFixture(ownerId: string, name: ImportFixture, adjudication?: object) {
    return runImport(ownerId, importFixture(name), name.endsWith('.jsonld') ? 'jsonld' : 'turtle', name, adjudication);
  }

  async function graphRowCount(ownerId: string): Promise<number> {
    const [e, r, i, a] = await Promise.all([
      prisma.kgEntity.count({ where: { ownerId } }),
      prisma.kgRelation.count({ where: { ownerId } }),
      prisma.kgItem.count({ where: { ownerId } }),
      prisma.kgEntityAlias.count({ where: { ownerId } }),
    ]);
    return e + r + i + a;
  }

  async function acceptAllAndCommit(ownerId: string, proposalId: string) {
    await prisma.kgProposalItem.updateMany({ where: { proposalId }, data: { decision: 'accept' } });
    return services.commits.commit(caller(ownerId), proposalId);
  }

  /** `type|label` → { props, aliases } for every live entity of the owner. */
  async function entityPicture(ownerId: string) {
    const rows = await prisma.kgEntity.findMany({
      where: { ownerId, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
      include: { aliases: true },
    });
    const out = new Map<string, { props: unknown; aliases: string[] }>();
    for (const r of rows) {
      out.set(`${r.type}|${r.label}`, { props: r.props, aliases: r.aliases.map((a) => a.alias).filter((a) => a !== r.label).sort() });
    }
    return out;
  }

  /** `TYPE|from|to` → range/precision/props for every live relation. */
  async function relationPicture(ownerId: string) {
    const rows = await prisma.$queryRaw<Array<{ type: string; f: string; t: string; valid: string | null; precision: string | null; props: unknown }>>`
      SELECT r.type, fe.label AS f, te.label AS t, r.valid::text AS valid, r.valid_precision::text AS precision, r.props
        FROM kg_relations r JOIN kg_entities fe ON fe.id = r.from_id JOIN kg_entities te ON te.id = r.to_id
       WHERE r.owner_id = ${ownerId}::uuid AND r.review_status IN ('accepted','edited') AND r.type <> 'IDENTIFIED_AS'`;
    return new Map(rows.map((r) => [`${r.type}|${r.f}|${r.t}`, { valid: r.valid, precision: r.precision, props: r.props }]));
  }

  // ---------------------------------------------------------------------------
  // The round trip
  // ---------------------------------------------------------------------------

  async function seedOwnerA() {
    const user = await createUser(prisma, EMAIL_PREFIX, 'a');
    const g = new GraphFixture(prisma, user.id);
    const tier = await prisma.kgAttributeDef.create({
      data: {
        ownerId: user.id,
        entityType: 'Organization',
        key: 'u_tier000001',
        label: 'Tier',
        kind: 'text',
      },
    });
    const medical = await prisma.kgAttributeDef.create({
      data: { ownerId: user.id, entityType: 'Person', key: 'u_medical001', label: 'Medical note', kind: 'text', sensitivity: 'sensitive' },
    });
    await prisma.userSettings.create({ data: { userId: user.id, value: { graph: { domains: { personal: true } } } } });

    const sarah = await g.entity('Person', 'Sarah Chen', { aliases: ['Sarah', 'S. Chen'], props: { title: 'Staff Engineer', u_medical001: 'SECRET-ATTRIBUTE-VALUE' } });
    const marcus = await g.entity('Person', 'Marcus Webb');
    const partner = await g.entity('Person', 'Alex Chen');
    const acme = await g.entity('Organization', 'Acme', { props: { website: 'https://acme.example', u_tier000001: 'gold' } });
    const globex = await g.entity('Organization', 'Globex');
    const meeting = await g.entity('Meeting', 'Pilot sync', { occurredAt: new Date('2026-04-02T15:00:00Z'), props: { dateSource: 'stated', topics: ['budget', 'hiring'] } });
    const project = await g.entity('Project', 'Q2 pilot', { props: { status: 'active', startDate: '2026-04-01' } });

    await g.relation('WORKS_FOR', sarah, globex, { valid: '[2019-01-01,2024-06-01)', precision: 'month', confidence: 0.9 });
    await g.relation('WORKS_FOR', sarah, acme, { valid: '[2024-06-01,)', precision: 'month' });
    const hasRole = await g.relation('HAS_ROLE', sarah, acme, { valid: '[2024-06-01,)', precision: 'month' });
    await prisma.kgRelation.update({ where: { id: hasRole }, data: { props: { title: 'Staff Engineer' } } });
    await g.relation('REPORTS_TO', sarah, marcus, { valid: '[2024-01-15,)', precision: 'day' });
    await g.relation('ATTENDED', sarah, meeting);
    await g.relation('ATTENDED', marcus, meeting);
    await g.relation('DISCUSSED', meeting, project);
    await g.relation('PART_OF', project, acme);
    await g.relation('SPOUSE_OF', sarah, partner, { valid: '[2015-06-01,)', precision: 'month' });

    await g.item('commitment', { title: 'Send the proposal', statement: 'Sarah will send the updated proposal by Friday.', ownerPersonId: sarah, counterpartyId: acme, meetingId: meeting, dueAt: new Date('2026-04-10T00:00:00Z') });
    await g.item('claim', { statement: 'The pilot budget was cut by 20%.', subjectId: acme, valid: '[2026-03-01,)', precision: 'month' });
    const sensitive = await g.item('person_fact', { statement: 'SECRET-FACT-STATEMENT', subjectId: sarah, sensitivity: 'sensitive' });
    await g.evidence('item', sensitive, { quote: 'SECRET-FACT-QUOTE' });
    return { user, defs: { tier, medical } };
  }

  async function exportTurtle(ownerId: string): Promise<string> {
    const uploads = new Map<string, string>();
    const exportObjects = {
      ...objects,
      putStream: (input: { storageKey: string; name: string; mimeType: string; ownerId: string }) => {
        const body = new PassThrough();
        const chunks: Buffer[] = [];
        body.on('data', (c: Buffer) => chunks.push(c));
        const done = new Promise((resolve, reject) => {
          body.on('end', () => {
            uploads.set(input.storageKey, Buffer.concat(chunks).toString('utf8'));
            prisma.storageObject
              .create({ data: { name: input.name, size: 1n, mimeType: input.mimeType, storageKey: input.storageKey, managedBy: 'graph', status: 'ready', uploadedById: input.ownerId } })
              .then(resolve, reject);
          });
        });
        return { body, done };
      },
    } as unknown as GraphObjectsService;
    const row: KgExport = await prisma.kgExport.create({
      data: { ownerId, format: 'turtle', graphFingerprint: 'pending', ontologyVersion: ONTOLOGY.version, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await new KgExportHandler({ register: () => undefined } as never, db, source, exportObjects).process({ id: randomUUID(), payload: { mode: 'render', exportId: row.id } } as never);
    return [...uploads.values()][0];
  }

  it('reproduces owner A’s entities and relations in an empty owner B (§16 P7)', async () => {
    const { user: a } = await seedOwnerA();
    const turtle = await exportTurtle(a.id);
    expect(turtle).toContain('Sarah Chen');
    expect(turtle).not.toContain('SECRET-FACT-STATEMENT');

    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    await prisma.userSettings.create({ data: { userId: b.id, value: { graph: { domains: { personal: true } } } } });
    const { proposal, stats, objectId } = await runImport(b.id, turtle, 'turtle', 'a.ttl');

    expect(stats.failureReason).toBeNull();
    expect(stats.validation).toMatchObject({ conforms: true, violationCount: 0 });
    expect(proposal.status).toBe('draft');
    expect(stats.sourceOntologyVersion).toBe(ONTOLOGY.version);
    // Nothing is in B's graph until the commit.
    expect(await graphRowCount(b.id)).toBe(0);

    // A's own attribute (Tier) is unknown to B: offered, not kept.
    const tierOffer = stats.unknownProperties.find((o: GraphImportOffer) => o.label === 'Tier');
    expect(tierOffer).toMatchObject({ status: 'offered', subjectTypes: ['Organization'], suggestedKind: 'text', sampleValues: ['gold'] });
    // The sensitive attribute definition was never exported, so it is not even offered.
    expect(JSON.stringify(stats)).not.toContain('SECRET');

    const rows = await prisma.kgProposalItem.findMany({ where: { proposalId: proposal.id } });
    expect(rows.every((r) => r.origin === 'user' && r.flags.includes('imported'))).toBe(true);

    const accepted = await importService().acceptOffer(caller(b.id), proposal.id, tierOffer!.offerId, {});
    expect(accepted.attributeDefs).toHaveLength(1);
    const tierKey = accepted.attributeDefs[0].key;
    expect(accepted.rowsUpdated).toBe(1);

    await acceptAllAndCommit(b.id, proposal.id);

    const [pa, pb] = await Promise.all([entityPicture(a.id), entityPicture(b.id)]);
    expect([...pb.keys()].sort()).toEqual([...pa.keys()].sort());
    for (const [key, fromA] of pa) {
      const fromB = pb.get(key)!;
      expect(fromB.aliases).toEqual(fromA.aliases);
      const propsA = { ...(fromA.props as Record<string, unknown>) };
      delete propsA.u_medical001; // sensitive: never left A
      if ('u_tier000001' in propsA) {
        propsA[tierKey] = propsA.u_tier000001;
        delete propsA.u_tier000001;
      }
      expect(fromB.props).toEqual(propsA);
    }

    const [ra, rb] = await Promise.all([relationPicture(a.id), relationPicture(b.id)]);
    expect([...rb.keys()].sort()).toEqual([...ra.keys()].sort());
    for (const [key, fromA] of ra) expect(rb.get(key)).toEqual(fromA);

    // Items: the commitment and the claim; never the sensitive fact.
    const items = await prisma.kgItem.findMany({ where: { ownerId: b.id }, select: { kind: true, statement: true, dueAt: true } });
    expect(items.map((i) => i.kind).sort()).toEqual(['claim', 'commitment']);
    expect(items.find((i) => i.kind === 'commitment')?.dueAt?.toISOString()).toBe('2026-04-10T00:00:00.000Z');

    // Every committed row cites the import itself.
    const evidence = await prisma.kgEvidence.findMany({ where: { ownerId: b.id, subjectKind: { in: ['entity', 'relation', 'item'] } } });
    const subjects = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM kg_entities WHERE owner_id = ${b.id}::uuid UNION ALL
      SELECT id::text FROM kg_relations WHERE owner_id = ${b.id}::uuid UNION ALL
      SELECT id::text FROM kg_items WHERE owner_id = ${b.id}::uuid`;
    for (const { id } of subjects) {
      const cites = evidence.filter((e) => e.subjectId === id);
      expect(cites.length).toBeGreaterThan(0);
      expect(cites.every((e) => e.importObjectId === objectId && typeof e.sourceIri === 'string')).toBe(true);
    }
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Failures write nothing
  // ---------------------------------------------------------------------------

  it('an invalid file fails with every violation listed, and writes nothing', async () => {
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    const { proposal, stats } = await runFixture(b.id, 'import-invalid.ttl');

    expect(proposal.status).toBe('failed');
    expect(stats.failureReason).toBe('shacl_violations');
    expect(stats.validation.conforms).toBe(false);
    expect(stats.validation.violationCount).toBe(3);
    const paths = stats.validation.violations.map((v) => v.path);
    expect(paths).toEqual(expect.arrayContaining(['http://www.w3.org/ns/prov#wasDerivedFrom']));
    expect(paths.some((p) => p?.endsWith('Meeting.dateSource'))).toBe(true);
    expect(paths.some((p) => p?.endsWith('WORKS_FOR'))).toBe(true);

    expect(await graphRowCount(b.id)).toBe(0);
    expect(await prisma.kgProposalItem.count({ where: { proposalId: proposal.id } })).toBe(0);
    expect(await prisma.kgEvidence.count({ where: { ownerId: b.id } })).toBe(0);
  }, 60_000);

  it('a newer-major file fails with ontology_version_newer', async () => {
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    const { proposal, stats } = await runFixture(b.id, 'import-newer-major.ttl');
    expect(proposal.status).toBe('failed');
    expect(stats).toMatchObject({ failureReason: 'ontology_version_newer', sourceOntologyVersion: '99.0.0' });
    expect(await prisma.kgProposalItem.count({ where: { proposalId: proposal.id } })).toBe(0);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Resolution, offers, JSON-LD
  // ---------------------------------------------------------------------------

  it('an imported "Joe Smith" resolves to the owner’s existing Joe Smith', async () => {
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    const joe = await new GraphFixture(prisma, b.id).entity('Person', 'Joe Smith');

    // Without an AI key, the match is proposed but left uncertain — never pre-checked.
    const unsure = await runFixture(b.id, 'import-valid.ttl');
    const unsureRow = (await prisma.kgProposalItem.findMany({ where: { proposalId: unsure.proposal.id, kind: 'entity' } })).find(
      (r) => (r.payload as { label: string }).label === 'Joe Smith',
    )!;
    const unsureRes = unsureRow.resolution as { ref: string | null; candidates: Array<{ entityId: string }> };
    expect(unsureRes.candidates[0]?.entityId).toBe(joe);
    expect(unsureRow.flags).toContain('possible_duplicate');
    expect(unsureRow.decision).toBe('pending');
    await services.proposals.discard(caller(b.id), unsure.proposal.id);

    // With adjudication (the owner's key), it links to the existing Joe exactly like an extracted mention.
    const { proposal, stats } = await runFixture(b.id, 'import-valid.ttl', SAYS_SAME);
    expect(stats.failureReason).toBeNull();
    expect(stats.counts).toMatchObject({ entities: 3, relations: 2, items: 1 });
    const rows = await prisma.kgProposalItem.findMany({ where: { proposalId: proposal.id, kind: 'entity' } });
    const joeRow = rows.find((r) => (r.payload as { label: string }).label === 'Joe Smith');
    expect((joeRow?.resolution as { ref: string | null } | null)?.ref).toBe(joe);

    // The annotation's body text is the evidence quote.
    const cite = await prisma.kgEvidence.findFirst({ where: { subjectKind: 'proposal_item', subjectId: joeRow!.id } });
    expect(cite).toMatchObject({ quote: 'Joe joined Acme in March 2019 and owes them the deck.', sourceIri: 'https://source.example/joe' });

    // The reified employment's range and precision win over the bare triple.
    const works = await prisma.kgProposalItem.findFirst({ where: { proposalId: proposal.id, kind: 'relation', payload: { path: ['type'], equals: 'WORKS_FOR' } } });
    expect(works?.payload).toMatchObject({ validFrom: '2019-03-01', validTo: '2024-06-01', precision: 'month' });
    expect((works?.resolution as { score: number } | null)?.score).toBe(0.8);

    await acceptAllAndCommit(b.id, proposal.id);
    const range = await prisma.$queryRaw<Array<{ valid: string }>>`
      SELECT valid::text FROM kg_relations WHERE owner_id = ${b.id}::uuid AND type = 'WORKS_FOR'`;
    expect(range[0].valid).toContain('2019-03-01');
    expect(range[0].valid).toContain('2024-07-01');
    // Linked, not duplicated.
    expect(await prisma.kgEntity.count({ where: { ownerId: b.id, type: 'Person', label: 'Joe Smith' } })).toBe(1);
  }, 90_000);

  it('offers unknown properties; accepting creates the attribute and moves values, rejecting drops them', async () => {
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    const { proposal, stats } = await runFixture(b.id, 'import-unknown-prop.ttl');
    expect(stats.failureReason).toBeNull();
    const nickname = stats.unknownProperties.find((o) => o.iri === 'https://crm.example/ns#nickname')!;
    const employees = stats.unknownProperties.find((o) => o.iri === 'https://crm.example/ns#employees')!;
    expect(nickname).toMatchObject({ label: 'Nickname', suggestedKind: 'text', status: 'offered' });
    expect(employees).toMatchObject({ suggestedKind: 'number', subjectTypes: ['Organization'] });

    const service = importService();
    const accepted = await service.acceptOffer(caller(b.id), proposal.id, nickname.offerId, {});
    const def = await prisma.kgAttributeDef.findFirstOrThrow({ where: { ownerId: b.id, entityType: 'Person' } });
    expect(def).toMatchObject({ label: 'Nickname', kind: 'text' });
    expect(accepted.rowsUpdated).toBe(1);
    const joeRow = await prisma.kgProposalItem.findFirst({ where: { proposalId: proposal.id, kind: 'entity', payload: { path: ['label'], equals: 'Joe Smith' } } });
    expect((joeRow?.payload as { props: Record<string, unknown> }).props).toEqual({ [def.key]: 'Joey' });

    const rejected = await service.rejectOffer(caller(b.id), proposal.id, employees.offerId);
    expect(rejected).toMatchObject({ offer: { status: 'rejected' }, valuesDropped: 1 });
    await expect(service.rejectOffer(caller(b.id), proposal.id, employees.offerId)).rejects.toMatchObject({ status: 409 });

    const after = (await prisma.kgProposal.findUniqueOrThrow({ where: { id: proposal.id } })).stats as Record<string, unknown>;
    expect((after.unknownProperties as GraphImportOffer[]).map((o) => o.status).sort()).toEqual(['accepted', 'rejected']);
    expect(after.importPending).toEqual({});

    await acceptAllAndCommit(b.id, proposal.id);
    const joe = await prisma.kgEntity.findFirstOrThrow({ where: { ownerId: b.id, label: 'Joe Smith' } });
    expect(joe.props).toEqual({ [def.key]: 'Joey' });
  }, 90_000);

  it('imports a JSON-LD CRM export of people and organizations', async () => {
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');
    const { proposal, stats } = await runFixture(b.id, 'import-crm.jsonld');
    expect(stats).toMatchObject({ failureReason: null, format: 'jsonld', counts: { entities: 3, relations: 2 } });
    await acceptAllAndCommit(b.id, proposal.id);
    const org = await prisma.kgEntity.findFirstOrThrow({ where: { ownerId: b.id, type: 'Organization' } });
    expect(org).toMatchObject({ label: 'Northwind Logistics', props: { website: 'https://northwind.example' } });
    const priya = await prisma.kgEntity.findFirstOrThrow({ where: { ownerId: b.id, label: 'Priya Natarajan' }, include: { aliases: true } });
    expect(priya.aliases.map((a) => a.alias)).toContain('Priya');
  }, 90_000);
});
