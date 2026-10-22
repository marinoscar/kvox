/**
 * The golden-graph seeder on the PGlite host (#608): nothing refused, nothing
 * warned, every evidence row mapped, no orphan, the sensitive facts present,
 * and the pinned row counts (m37-m39 added the Topic, Product and BROADER gold; m40-m44 the stakeholder and market relations; m50-m55 the Risk gold; m56-m57 the Joe / Company A / Copilot rollout scenario). One host for the file.
 */

import { createKvoxAi } from '@marinoscar/kvox-ai';
import { createScriptedRuntime } from '@marinoscar/kvox-ai/testing';

import { loadGoldenSet } from '../src/fixtures/index';
import { staticTaskModelSource } from '../src/live/index';
import { startAskEvalHost, type AskEvalHost } from '../src/ask-run/host/app';
import { seedGoldenGraph, type SeededGoldenGraph } from '../src/ask-run/seed-golden-graph';

jest.setTimeout(240_000);

let host: AskEvalHost;
let seeded: SeededGoldenGraph;
const fixtures = loadGoldenSet();

beforeAll(async () => {
  const ai = createKvoxAi({ runtime: createScriptedRuntime(), taskModels: staticTaskModelSource('openai', 'gpt-seed') });
  host = await startAskEvalHost({ ai });
  seeded = await seedGoldenGraph(host, fixtures);
}, 240_000);

afterAll(async () => {
  await host?.close();
});

describe('seedGoldenGraph (PGlite)', () => {
  it('refuses 0 rows and warns 0 times', () => {
    expect(seeded.refusals).toEqual([]);
    expect(seeded.warnings).toEqual([]);
  });

  it('seeds the pinned row counts', async () => {
    expect(fixtures).toHaveLength(52);
    expect(seeded.counts).toEqual({ entities: 214, relations: 330, items: 209, evidence: 965 });
    const where = { ownerId: host.userId };
    expect(await host.prisma.kgEntity.count({ where })).toBe(214);
    expect(await host.prisma.kgRelation.count({ where })).toBe(330);
    expect(await host.prisma.kgItem.count({ where })).toBe(209);
    expect(await host.prisma.kgEvidence.count({ where })).toBe(965);
  });

  it('maps every kg_evidence row of the eval user in idMap.evidenceSource', async () => {
    const rows = await host.prisma.kgEvidence.findMany({ where: { ownerId: host.userId }, select: { id: true } });
    expect(rows.length).toBeGreaterThan(0);
    const unmapped = rows.filter((r) => !seeded.idMap.evidenceSource.has(r.id));
    expect(unmapped).toEqual([]);
    expect(seeded.idMap.evidenceSource.size).toBe(rows.length);
  });

  it('leaves no accepted or edited kg row without evidence', async () => {
    const accepted = { ownerId: host.userId, reviewStatus: { in: ['accepted', 'edited'] as ('accepted' | 'edited')[] } };
    const [entities, relations, items, evidence] = await Promise.all([
      host.prisma.kgEntity.findMany({ where: accepted, select: { id: true } }),
      host.prisma.kgRelation.findMany({ where: accepted, select: { id: true } }),
      host.prisma.kgItem.findMany({ where: accepted, select: { id: true } }),
      host.prisma.kgEvidence.findMany({ where: { ownerId: host.userId }, select: { subjectKind: true, subjectId: true } }),
    ]);
    const cited = new Set(evidence.map((e) => `${e.subjectKind}:${e.subjectId}`));
    const orphans = [
      ...entities.filter((r) => !cited.has(`entity:${r.id}`)),
      ...relations.filter((r) => !cited.has(`relation:${r.id}`)),
      ...items.filter((r) => !cited.has(`item:${r.id}`)),
    ];
    expect(entities.length + relations.length + items.length).toBeGreaterThan(0);
    expect(orphans).toEqual([]);
  });

  it('seeds the 6 sensitive person facts', async () => {
    const sensitive = await host.prisma.kgItem.count({ where: { ownerId: host.userId, sensitivity: 'sensitive' } });
    expect(sensitive).toBe(6);
  });
});
