// =============================================================================
// Real-Postgres CI drift check: a fixture graph's export conforms to its own
// generated SHACL shapes (#386, docs/specs/ontology.md §18.2)
// =============================================================================
//
// "An export validates against its own shapes by construction" — this is the
// test that catches the one remaining failure mode, drift between the data
// serializer and the shapes generator. It seeds a fixture owner (~20 entities,
// temporal relations, items including a superseded decision, a sensitive fact,
// a sensitive and a non-sensitive user attribute, segment and note citations,
// and rows that must NOT leave: a merge tombstone, unreviewed and rejected
// rows, a speaker link), runs the REAL `kg.export` handler over the REAL SQL
// for Turtle, JSON-LD and N-Quads, and:
//
//   - validates Turtle and JSON-LD with `rdf-validate-shacl` against
//     `generateShacl(ONTOLOGY, <the owner's definitions>, ns)` → must conform;
//   - parses N-Quads;
//   - asserts the sensitive fact's text, its evidence quote and the sensitive
//     attribute value appear in no format, and `stats.excludedSensitive` = 2;
//   - asserts merged/unreviewed/rejected rows are absent and the superseded
//     decision is present with `prov:wasRevisionOf`;
//   - asserts two runs over the same graph write identical bytes;
//   - and, through `GraphExportService`, content-addressed reuse (202 then
//     `reused: true`), a new export after any committed change, and owner B's
//     404 on owner A's export.
//
// Excluded from `npm test`; run by `npm run test:db` (CI's Smoke job).
// Storage is faked (the bytes are captured); the `storage_objects` row is real.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import type { KgExport, PrismaClient } from '@prisma/client';
import * as jsonld from 'jsonld';
import { Parser, type Quad } from 'n3';
import { APP_SLUG } from '@app/shared';
import { ONTOLOGY, kvNamespace } from '@app/shared/ontology';

import { GraphExportService } from '../../../src/graph/export/graph-export.service';
import { GraphExportSource } from '../../../src/graph/export/graph-export.source';
import { KgExportHandler } from '../../../src/graph/export/kg-export.handler';
import type { GraphObjectsService } from '../../../src/graph/graph-objects.service';
import { GraphOntologyService } from '../../../src/graph/ontology/graph-ontology.service';
import { GraphPreferencesService } from '../../../src/graph/preferences/graph-preferences.service';
import { generateShacl } from '../../../src/graph/rdf/shacl-generator';
import { NoteAccessService } from '../../../src/notes/access/note-access.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../../src/transcripts/transcript-access.service';
import { resolveDbSuite } from '../../jobs/db-test-support';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph-read.fixtures';
import { validateShacl } from './rdf-fixtures';

const { describeWithDb, dbReachable } = resolveDbSuite('export-conforms.db.spec');

const EMAIL_PREFIX = 'graph-export-test';
const NS = kvNamespace(APP_SLUG);
const PROV = 'http://www.w3.org/ns/prov#';

describeWithDb('kg.export — a fixture export conforms to the generated shapes (real Postgres)', () => {
  let prisma: PrismaClient;
  let source: GraphExportSource;
  let ontology: GraphOntologyService;
  const uploads = new Map<string, string>();

  /** Captures the bytes; records a real, managed `storage_objects` row. */
  const objects = {
    putStream: (input: { storageKey: string; name: string; mimeType: string; ownerId: string }) => {
      const body = new PassThrough();
      const chunks: Buffer[] = [];
      body.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise((resolve, reject) => {
        body.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          uploads.set(input.storageKey, text);
          prisma.storageObject
            .upsert({
              where: { id: uuidFromKey(input.storageKey) },
              update: { size: BigInt(Buffer.byteLength(text)) },
              create: {
                id: uuidFromKey(input.storageKey),
                name: input.name,
                size: BigInt(Buffer.byteLength(text)),
                mimeType: input.mimeType,
                storageKey: input.storageKey,
                managedBy: 'graph',
                status: 'ready',
                uploadedById: input.ownerId,
              },
            })
            .then(resolve, reject);
        });
      });
      return { body, done };
    },
    signedUrlFor: async () => ({ url: 'https://storage.example/signed', expiresAt: new Date(), object: {} }),
    deleteIfPresent: async () => true,
  } as unknown as GraphObjectsService;

  const keyIds = new Map<string, string>();
  function uuidFromKey(key: string): string {
    if (!keyIds.has(key)) keyIds.set(key, randomUUID());
    return keyIds.get(key)!;
  }

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    ontology = new GraphOntologyService(p, new GraphPreferencesService(p));
    source = new GraphExportSource(p, ontology, new TranscriptAccessService(p), new NoteAccessService(p));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    // `kg_exports.object_id` is Restrict: the exports go before their objects.
    await prisma.kgExport.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.job.deleteMany({ where: { type: 'kg.export', subjectType: 'kg_export', payload: { path: ['test'], equals: EMAIL_PREFIX } } });
    await prisma.auditEvent.deleteMany({ where: { actorUser: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgAttributeDef.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
    uploads.clear();
  }, 60_000);

  function handler(): KgExportHandler {
    return new KgExportHandler({ register: () => undefined } as never, prisma as unknown as PrismaService, source, objects);
  }

  async function exportRow(ownerId: string, format: 'turtle' | 'jsonld' | 'nquads'): Promise<KgExport> {
    return prisma.kgExport.create({
      data: {
        ownerId,
        format,
        graphFingerprint: 'pending',
        ontologyVersion: ONTOLOGY.version,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        createdAt: new Date('2026-09-01T12:00:00Z'),
      },
    });
  }

  async function run(row: KgExport): Promise<{ text: string; row: KgExport }> {
    await handler().process({ id: randomUUID(), payload: { mode: 'render', exportId: row.id } } as never);
    const done = await prisma.kgExport.findUniqueOrThrow({ where: { id: row.id } });
    const ext = row.format === 'turtle' ? 'ttl' : row.format === 'nquads' ? 'nq' : 'jsonld';
    return { text: uploads.get(`graph/${row.ownerId}/exports/${row.id}.${ext}`)!, row: done };
  }

  /** The fixture graph. Returns the ids the assertions need. */
  async function seed() {
    const user = await createUser(prisma, EMAIL_PREFIX, 'a');
    const g = new GraphFixture(prisma, user.id);
    const tier = await prisma.kgAttributeDef.create({
      data: {
        ownerId: user.id,
        entityType: 'Organization',
        key: 'u_tier000001',
        label: 'Tier',
        kind: 'select',
        options: { choices: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
      },
    });
    const medical = await prisma.kgAttributeDef.create({
      data: { ownerId: user.id, entityType: 'Person', key: 'u_medical001', label: 'Medical note', kind: 'text', sensitivity: 'sensitive' },
    });

    const { transcript, speakerA, segment } = await g.transcript({ title: 'Weekly sync' });
    const note = await g.note({ title: 'Pilot notes' });

    const sarah = await g.entity('Person', 'Sarah Chen', {
      aliases: ['Sarah', 'S. Chen'],
      props: { title: 'Staff Engineer', u_medical001: 'SECRET-ATTRIBUTE-VALUE' },
    });
    await g.evidence('entity', sarah, {
      transcriptId: transcript.id,
      segmentId: segment.id,
      segmentRev: 1,
      startMs: 1500,
      endMs: 4000,
      charStart: 0,
      charEnd: 5,
      quote: 'Sarah joined Acme',
    });
    const marcus = await g.entity('Person', 'Marcus Webb');
    const people = [];
    for (let i = 0; i < 8; i++) people.push(await g.entity('Person', `Person ${i}`));
    const acme = await g.entity('Organization', 'Acme', { props: { website: 'https://acme.example', u_tier000001: 'gold' } });
    const globex = await g.entity('Organization', 'Globex');
    const meeting = await g.entity('Meeting', 'Pilot sync', {
      occurredAt: new Date('2026-04-02T15:00:00Z'),
      props: { dateSource: 'stated', topics: ['budget', 'hiring'] },
    });
    const project = await g.entity('Project', 'Q2 pilot', { props: { status: 'active', startDate: '2026-04-01' } });
    const tombstone = await g.entity('Person', 'Sarah C.', { reviewStatus: 'merged', mergedIntoId: sarah });
    // #383's personal domain — exported (personal is not sensitive), and even
    // though this owner has switched the domain OFF: rows that exist are exported.
    await prisma.userSettings.create({ data: { userId: user.id, value: { graph: { domains: { personal: false } } } } });
    const trip = await g.entity('Trip', 'Lisbon trip', { props: { destination: 'Lisbon', startDate: '2026-05-01' } });
    const interest = await g.entity('Interest', 'Sailing');
    const milestone = await g.entity('Milestone', 'Wedding anniversary', { props: { kind: 'anniversary' } });
    const spouseOf = await g.relation('SPOUSE_OF', sarah, people[4], { valid: '[2015-06-01,)', precision: 'month' });
    await g.relation('FRIEND_OF', people[5], sarah);
    await g.relation('PARENT_OF', sarah, people[6]);
    await g.relation('TRAVELED_ON', sarah, trip);
    await g.relation('INTERESTED_IN', sarah, interest);
    await g.relation('HAS_MILESTONE', sarah, milestone);
    const unreviewed = await g.entity('Person', 'Maybe Person', { reviewStatus: 'unreviewed' });
    const rejected = await g.entity('Organization', 'Rejected Org', { reviewStatus: 'rejected' });

    const worksFor = await g.relation('WORKS_FOR', sarah, acme, { valid: '[2019-01-01,2024-06-01)', precision: 'month', confidence: 0.9 });
    const hasRole = await g.relation('HAS_ROLE', sarah, acme, { valid: '[2024-06-01,)', precision: 'month' });
    await prisma.kgRelation.update({ where: { id: hasRole }, data: { props: { title: 'Staff Engineer' } } });
    await g.relation('REPORTS_TO', sarah, marcus, { valid: '[2024-01-01,)', precision: 'day' });
    await g.relation('ATTENDED', sarah, meeting);
    await g.relation('ATTENDED', marcus, meeting);
    for (const p of people.slice(0, 3)) await g.relation('ATTENDED', p, meeting);
    await g.relation('WORKS_FOR', people[3], globex, { valid: '[2020-01-01,)', precision: 'year' });
    await g.relation('DISCUSSED', meeting, project);
    await g.relation('PART_OF', project, acme);
    const toUnreviewed = await g.relation('REPORTS_TO', marcus, unreviewed);
    const rejectedRel = await g.relation('WORKS_FOR', marcus, globex, { reviewStatus: 'rejected' });
    const speakerLink = await g.relation('IDENTIFIED_AS', null, sarah, { fromSpeakerId: speakerA.id });

    const commitment = await g.item('commitment', {
      title: 'Send the proposal',
      statement: 'Sarah will send the updated proposal by Friday.',
      ownerPersonId: sarah,
      counterpartyId: acme,
      meetingId: meeting,
      subjectId: project,
      dueAt: new Date('2026-04-10T17:00:00Z'),
    });
    const newDecision = await g.item('decision', { title: 'Run in-house', statement: 'The pilot runs in-house.', meetingId: meeting, subjectId: project });
    const oldDecision = await g.item('decision', {
      title: 'Outsource',
      statement: 'The pilot would be outsourced.',
      status: 'superseded',
      reviewStatus: 'superseded',
      supersededById: newDecision,
    });
    const claim = await g.item('claim', {
      statement: 'The pilot budget was cut by 20%.',
      subjectId: acme,
      valid: '[2026-03-01,)',
      precision: 'month',
    });
    await g.evidence('item', claim, { noteId: note.id, noteVersion: 1, charStart: 2, charEnd: 9, quote: 'budget cut' });
    const personal = await g.item('person_fact', { statement: 'Sarah prefers written updates.', subjectId: sarah, sensitivity: 'personal' });
    const sensitive = await g.item('person_fact', { statement: 'SECRET-FACT-STATEMENT', subjectId: sarah, sensitivity: 'sensitive' });
    await g.evidence('item', sensitive, { quote: 'SECRET-FACT-QUOTE' });
    const unreviewedItem = await g.item('claim', { statement: 'UNREVIEWED-CLAIM', subjectId: acme, reviewStatus: 'unreviewed' });

    return {
      user,
      ids: { trip, interest, milestone, spouseOf, sarah, acme, meeting, tombstone, unreviewed, rejected, worksFor, toUnreviewed, rejectedRel, speakerLink, commitment, newDecision, oldDecision, personal, sensitive, unreviewedItem },
      defs: { tier, medical },
    };
  }

  const jsonLdQuads = async (text: string): Promise<Quad[]> =>
    new Parser({ format: 'N-Quads' }).parse((await jsonld.toRDF(JSON.parse(text), { format: 'application/n-quads' })) as unknown as string);

  it('Turtle and JSON-LD conform to the generated shapes; N-Quads parses; sensitive never leaves', async () => {
    const { user, ids } = await seed();
    const shapes = new Parser().parse(generateShacl(ONTOLOGY, await ontology.attributeDefsFor(user.id), NS));

    for (const format of ['turtle', 'jsonld', 'nquads'] as const) {
      const { text, row } = await run(await exportRow(user.id, format));
      expect(row.status).toBe('ready');
      expect(row.objectId).not.toBeNull();

      const quads =
        format === 'turtle' ? new Parser().parse(text) : format === 'nquads' ? new Parser({ format: 'N-Quads' }).parse(text) : await jsonLdQuads(text);
      expect(quads.length).toBeGreaterThan(100);

      if (format !== 'nquads') {
        const report = await validateShacl(shapes, quads);
        expect(report.results.map((r) => [r.focusNode?.value, r.path?.value, r.message[0]?.value])).toEqual([]);
        expect(report.conforms).toBe(true);
      }

      // ⚠ Sensitive: the fact, its quote and the attribute value — in no format.
      for (const secret of ['SECRET-FACT-STATEMENT', 'SECRET-FACT-QUOTE', 'SECRET-ATTRIBUTE-VALUE', ids.sensitive]) {
        expect(text).not.toContain(secret);
      }
      expect(row.stats).toMatchObject({ excludedSensitive: 2, entities: 17, items: 5 });

      // The personal domain is exported although this owner switched it off.
      for (const personal of [ids.trip, ids.interest, ids.milestone]) {
        expect(quads.some((q) => q.subject.value === `${NS}entity/${personal}`)).toBe(true);
      }
      // A symmetric edge: exactly one direct triple, as stored, and one assertion.
      const spouse = quads.filter((q) => q.predicate.value === `${NS}SPOUSE_OF`);
      expect(spouse).toHaveLength(1);
      expect(spouse[0].subject.value).toBe(`${NS}entity/${ids.sarah}`);
      expect(quads.filter((q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate' && q.object.value === `${NS}SPOUSE_OF`)).toHaveLength(1);
      expect(quads.some((q) => q.subject.value === `${NS}relation/${ids.spouseOf}`)).toBe(true);

      // Absent: a merge tombstone, unreviewed and rejected rows, a speaker link.
      for (const absent of [ids.tombstone, ids.unreviewed, ids.rejected, ids.toUnreviewed, ids.rejectedRel, ids.speakerLink, ids.unreviewedItem]) {
        expect(text).not.toContain(absent);
      }
      expect(text).not.toContain('UNREVIEWED-CLAIM');

      // Present: the superseded decision, linked from its replacement.
      const revision = quads.find(
        (q) => q.predicate.value === `${PROV}wasRevisionOf` && q.subject.value === `${NS}item/${ids.newDecision}`,
      );
      expect(revision?.object.value).toBe(`${NS}item/${ids.oldDecision}`);
      expect(quads.some((q) => q.subject.value === `${NS}item/${ids.oldDecision}` && q.predicate.value === `${NS}reviewStatus` && q.object.value === 'superseded')).toBe(true);

      // A reified temporal edge with its finite bounds.
      const started = quads.find((q) => q.subject.value === `${NS}relation/${ids.worksFor}` && q.predicate.value === `${PROV}startedAtTime`);
      expect(started?.object.value).toBe('2019-01-01T00:00:00.000Z');

      // Segment and note sources are labelled with their (readable) titles.
      expect(text).toContain('Weekly sync');
      expect(text).toContain('Pilot notes');
    }
  }, 120_000);

  it('two runs over the same graph write identical bytes', async () => {
    const { user } = await seed();
    const row = await exportRow(user.id, 'turtle');
    const first = (await run(row)).text;
    await prisma.kgExport.update({ where: { id: row.id }, data: { status: 'pending', objectId: null } });
    const second = (await run(row)).text;
    expect(second).toBe(first);
  }, 60_000);

  it('reuses an unchanged graph’s export, re-exports after a change, and 404s another owner', async () => {
    const { user, ids } = await seed();
    const jobs = {
      enqueue: async (input: { type: string; reason: string; subjectType: string; subjectId: string; payload: object; priority: number }) =>
        prisma.job.create({
          data: { type: input.type, reason: 'rerun', subjectType: input.subjectType, subjectId: input.subjectId, payload: { ...input.payload, test: EMAIL_PREFIX }, priority: input.priority },
        }),
    };
    const service = new GraphExportService(
      prisma as unknown as PrismaService,
      source,
      objects,
      { get: () => ({}) } as never,
      jobs as never,
    );

    const first = await service.requestExport(user.id, 'turtle');
    expect(first.reused).toBe(false);
    const again = await service.requestExport(user.id, 'turtle');
    expect(again).toMatchObject({ reused: true, export: { id: first.export.id } });
    // Another format is another export.
    expect((await service.requestExport(user.id, 'jsonld')).reused).toBe(false);

    // Any committed change moves the fingerprint.
    await prisma.kgEntityAlias.create({
      data: { entityId: ids.acme, ownerId: user.id, alias: 'Acme Corp', normalized: 'acme corp', source: 'user' },
    });
    const changed = await service.requestExport(user.id, 'turtle');
    expect(changed.reused).toBe(false);
    expect(changed.export.id).not.toBe(first.export.id);

    // Owner B: 404 for A's export, and an empty list.
    const other = await createUser(prisma, EMAIL_PREFIX, 'b');
    await expect(service.get(other.id, first.export.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.list(other.id)).exports).toEqual([]);
    expect((await service.list(user.id)).exports.map((e) => e.id)).toContain(first.export.id);

    // An owner with nothing readable: 409 graph_empty.
    await expect(service.requestExport(other.id, 'turtle')).rejects.toMatchObject({
      response: { details: { reason: 'graph_empty' } },
    });
  }, 60_000);

  it('the sweep deletes expired exports and their objects, and only those', async () => {
    const { user } = await seed();
    const expired = await exportRow(user.id, 'nquads');
    await run(expired);
    await prisma.kgExport.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const live = await exportRow(user.id, 'turtle');
    const deleted: string[] = [];
    const sweeper = new KgExportHandler({ register: () => undefined } as never, prisma as unknown as PrismaService, source, {
      ...objects,
      deleteIfPresent: async (id: string) => {
        deleted.push(id);
        await prisma.storageObject.delete({ where: { id } });
        return true;
      },
    } as unknown as GraphObjectsService);
    const removed = await sweeper.sweep();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.kgExport.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.kgExport.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(deleted).toHaveLength(1);
  }, 60_000);
});
