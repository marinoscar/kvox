import { Prisma } from '@prisma/client';
import { permissionRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';
import {
  USER_DATA_EXPORT_SOURCE_ID,
  datasetNameOf,
  exportColumnsOf,
  exportSourceRegistry,
  userDataTables,
  writersFor,
  type ExportContext,
  type ExportDb,
  type ExportTable,
} from '@marinoscar/platform-api/exports';
import {
  collectExportOutput,
  exportFileText,
  exportSentinel,
  forbiddenExportSentinels,
  runSentinelExports,
  sentinelExportDb,
} from '@marinoscar/platform-api/exports/testing';

import { KVOX_USER_OWNED_MODELS } from '../../src/app-registrations/user-owned-models';
// Mounting the module registers the platform sources and writers, then `kvox-content`.
import '../../src/platform/exports/exports.config';
import {
  KVOX_CONTENT_DATASETS,
  KVOX_CONTENT_EXPORT_PERMISSION,
  KVOX_CONTENT_EXPORT_SOURCE,
  KVOX_CONTENT_EXPORT_SOURCE_ID,
  kvoxContentTables,
} from '../../src/platform/exports/kvox-content.source';

// =============================================================================
// What "Download your data" may contain (issue #532, Part B of #479)
// =============================================================================
//
// The platform `user-data` source exports whatever the user-owned registry
// (`app-registrations/user-owned-models.ts`) marks `include`; the app's
// `kvox-content` source adds the datasets that need a parent-keyed filter. This
// spec pins the policy so a registry edit cannot widen it by accident:
//
//   * a `sensitive` PersonFact never leaves the deployment (root AGENTS.md):
//     `KgItem` and `KgEvidence` stay `exclude`, and nothing of theirs is written;
//   * no embedding column is exported;
//   * an actor-only model is never exported by the platform source (it would carry
//     the wrong rows); `kvox-content` exports it by ownership of the PARENT row.
//
// No database: the sources are driven through a recording fake client.
// =============================================================================

const datamodel = Prisma.dmmf.datamodel;
const permissions = permissionRegistry.list();
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

function modelNamed(name: string) {
  const model = datamodel.models.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`model ${name} is not in the datamodel`);
  return model;
}

function contextOver(db: ExportDb, overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    exportId: '00000000-0000-4000-8000-0000000000ee',
    scope: 'user',
    subjectId: USER_ID,
    requestedById: USER_ID,
    db,
    datamodel,
    pageSize: 2,
    now: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function drain(tables: AsyncIterable<ExportTable>): Promise<ExportTable[]> {
  const out: ExportTable[] = [];
  for await (const table of tables) {
    for await (const row of table.rows) void row;
    out.push(table);
  }
  return out;
}

/** A client whose delegates record every `findMany` argument and answer with `pages` in turn. */
function recordingDb(pages: Record<string, unknown[][]> = {}) {
  const calls: Array<{ delegate: string; args: { where: Record<string, unknown>; select: Record<string, boolean> } }> = [];
  const served: Record<string, number> = {};
  const db: ExportDb = new Proxy(
    {},
    {
      get: (_target, delegate: string) => ({
        findMany: async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) => {
          calls.push({ delegate, args });
          const index = served[delegate] ?? 0;
          served[delegate] = index + 1;
          return pages[delegate]?.[index] ?? [];
        },
      }),
    },
  );
  return { db, calls };
}

/** The models this app declares (the platform declares its own, with its own policy). */
const KVOX_MODELS = new Set(KVOX_USER_OWNED_MODELS.map((def) => def.model as string));
const EXCLUDED = userOwnedModelRegistry.list().filter((def) => def.export === 'exclude');
const INCLUDED = userOwnedModelRegistry.list().filter((def) => def.export === 'include');

describe('the export policy of the user-owned registry', () => {
  it('keeps every KgItem and KgEvidence out: a sensitive PersonFact never leaves the deployment', () => {
    for (const model of ['KgItem', 'KgEvidence']) {
      const def = userOwnedModelRegistry.get(model);

      expect(def?.export).toBe('exclude');
      expect(def?.rationale).toMatch(/sensitive PersonFact never leaves the deployment/);
    }
  });

  it('includes exactly the owner-keyed, small, user-authored kvox models', () => {
    expect(
      INCLUDED.map((def) => def.model as string)
        .filter((model) => KVOX_MODELS.has(model))
        .sort(),
    ).toEqual(
      [
        'AskConversation',
        'KgEntity',
        'KgEntityAlias',
        'KgRelation',
        'Note',
        'NoteTemplate',
        'Transcript',
        'UserHiddenNoteTemplate',
      ],
    );
  });

  it('excludes the derived, bulky, transient and sensitive kvox models', () => {
    const excluded = new Set(EXCLUDED.map((def) => def.model));

    for (const model of [
      'KgItem',
      'KgEvidence',
      'KgMention',
      'KgProposal',
      'KgMerge',
      'KgDistinctPair',
      'KgEntityDigest',
      'KgExport',
      'KgGraphLayout',
      'KgEntityView',
      'KgAttributeDef',
      'TranscriptSegment',
      'TranscriptVersion',
      'TranscriptExport',
      'TranscriptNameCheck',
      'TranscriptNameSuggestion',
      'NoteVersion',
      'NoteExport',
      'SearchIndexState',
    ]) {
      expect(excluded.has(model)).toBe(true);
    }
  });

  it('never exports an actor-only model through the platform source', () => {
    const actorOnlyIncluded = INCLUDED.filter((def) => def.ownerField === undefined).map((def) => def.model as string);

    // The platform's own actor-only models (audit events) are its decision; none is kvox's.
    expect(actorOnlyIncluded.filter((model) => KVOX_MODELS.has(model))).toEqual([]);
    expect(userOwnedModelRegistry.get('TranscriptSegment')?.export).toBe('exclude');
    expect(userOwnedModelRegistry.get('NoteVersion')?.export).toBe('exclude');
  });

  it('gives every excluded or omitting entry a reason', () => {
    for (const def of userOwnedModelRegistry.list().filter((entry) => KVOX_MODELS.has(entry.model as string))) {
      expect(def.rationale.trim().length).toBeGreaterThan(20);
    }
  });

  it('omits the entity embedding bookkeeping and the props of an entity and a relation', () => {
    expect(userOwnedModelRegistry.get('KgEntity')?.exportOmit).toEqual(
      expect.arrayContaining(['embeddingModel', 'embeddingHash', 'props']),
    );
    expect(userOwnedModelRegistry.get('KgRelation')?.exportOmit).toEqual(['props']);
  });

  it('exports no embedding or search-vector column of any included model', () => {
    for (const def of INCLUDED) {
      const keys = exportColumnsOf(modelNamed(def.model), def.exportOmit ?? []).map((column) => column.key);

      expect(keys.filter((key) => /^embedding|[sS]earchVector$/.test(key))).toEqual([]);
    }
  });

  it('exports no props column of an entity or a relation (a sensitive attribute value may sit in it)', () => {
    for (const model of ['KgEntity', 'KgRelation']) {
      const def = userOwnedModelRegistry.get(model);
      const keys = exportColumnsOf(modelNamed(model), def?.exportOmit ?? []).map((column) => column.key);

      expect(keys).not.toContain('props');
    }
  });
});

describe('the kvox-content source', () => {
  it('is registered after the platform sources, for every role, with no request options', () => {
    const source = exportSourceRegistry.get(KVOX_CONTENT_EXPORT_SOURCE_ID);

    expect(source).toBe(KVOX_CONTENT_EXPORT_SOURCE);
    expect(source?.scope).toBe('user');
    expect(source?.permission).toBe('user_settings:read');
    expect(KVOX_CONTENT_EXPORT_PERMISSION).toBe(exportSourceRegistry.get(USER_DATA_EXPORT_SOURCE_ID)?.permission);
    expect(permissions.some((permission) => permission.id === source?.permission)).toBe(true);
    expect(exportSourceRegistry.ids().slice(0, 2)).toEqual(['user-data', 'org-data']);
    expect(exportSourceRegistry.ids()).toContain('kvox-content');
    expect(source?.requestSchema.safeParse({}).success).toBe(true);
    expect(source?.requestSchema.safeParse({ everything: true }).success).toBe(false);
    expect(writersFor(source!).map((writer) => writer.id)).toEqual(['json', 'csv', 'xlsx']);
  });

  it('exports the speakers, segments, note versions, Ask messages and attribute definitions, in that order', async () => {
    const { db } = recordingDb();
    const tables = await drain(kvoxContentTables(contextOver(db)));

    expect(tables.map((table) => table.dataset)).toEqual([
      'transcript_speaker',
      'transcript_segment',
      'note_version',
      'ask_message',
      'kg_attribute_def',
    ]);
    expect(KVOX_CONTENT_DATASETS.map((dataset) => datasetNameOf(dataset.model))).toEqual(tables.map((table) => table.dataset));
  });

  it('filters EVERY dataset by the owner of the parent row', async () => {
    const { db, calls } = recordingDb();
    await drain(kvoxContentTables(contextOver(db)));

    const whereOf = (delegate: string) => calls.find((call) => call.delegate === delegate)?.args.where;

    expect(whereOf('transcriptSpeaker')).toEqual({ transcript: { ownerId: USER_ID } });
    expect(whereOf('transcriptSegment')).toEqual({ transcript: { ownerId: USER_ID } });
    expect(whereOf('noteVersion')).toEqual({ note: { ownerId: USER_ID } });
    expect(whereOf('askMessage')).toEqual({ conversation: { ownerId: USER_ID } });
    expect(whereOf('kgAttributeDef')).toMatchObject({ ownerId: USER_ID });
    expect(calls.map((call) => call.delegate)).toHaveLength(KVOX_CONTENT_DATASETS.length);

    // Nothing is keyed by the actor: a collaborator's edit must neither add nor hide a row.
    expect(JSON.stringify(calls.map((call) => call.args.where))).not.toMatch(/editedById|authorId/);
  });

  it('keeps the owner filter on every page after the first', async () => {
    const row = (id: string) => ({ id });
    const { db, calls } = recordingDb({ transcriptSegment: [[row('a'), row('b')], [row('c')]] });
    await drain(kvoxContentTables(contextOver(db, { pageSize: 2 })));

    const segmentCalls = calls.filter((call) => call.delegate === 'transcriptSegment');

    expect(segmentCalls).toHaveLength(2);
    expect(segmentCalls[1].args.where).toEqual({
      AND: [{ transcript: { ownerId: USER_ID } }, { id: { gt: 'b' } }],
    });
  });

  it('leaves out a sensitive attribute definition and keeps an unclassified one', () => {
    const where = KVOX_CONTENT_DATASETS.find((dataset) => dataset.model === 'KgAttributeDef')!.where(USER_ID);

    expect(where).toEqual({
      ownerId: USER_ID,
      OR: [{ sensitivity: null }, { sensitivity: { not: 'sensitive' } }],
    });
  });

  it('selects no per-word timing and no tool-call trace', async () => {
    const { db, calls } = recordingDb();
    await drain(kvoxContentTables(contextOver(db)));

    const selectOf = (delegate: string) => Object.keys(calls.find((call) => call.delegate === delegate)?.args.select ?? {});

    expect(selectOf('transcriptSegment')).toEqual(expect.arrayContaining(['id', 'text', 'startMs', 'endMs', 'editedById']));
    expect(selectOf('transcriptSegment')).not.toContain('words');
    expect(selectOf('transcriptSegment')).not.toContain('wordsAlignment');
    expect(selectOf('askMessage')).toEqual(expect.arrayContaining(['content', 'citations']));
    expect(selectOf('askMessage')).not.toContain('toolCalls');
  });
});

describe('what each source writes', () => {
  const sentinelContext = () => contextOver(sentinelExportDb(datamodel), { pageSize: 10 });

  it('splits the datasets: segments and note versions only in kvox-content, never in user-data', async () => {
    const userData = (await drain(userDataTables(sentinelContext()))).map((table) => table.dataset);
    const content = (await drain(kvoxContentTables(sentinelContext()))).map((table) => table.dataset);

    for (const dataset of ['transcript_segment', 'note_version', 'kg_item', 'kg_evidence', 'kg_attribute_def']) {
      expect(userData).not.toContain(dataset);
    }
    expect(userData).toEqual(expect.arrayContaining(['account', 'transcript', 'note', 'kg_entity', 'kg_relation', 'ask_conversation']));
    expect(content).toEqual(expect.arrayContaining(['transcript_segment', 'note_version']));
    expect(content).not.toContain('kg_item');
    expect(content).not.toContain('kg_evidence');
  });

  it('writes no field of KgItem or KgEvidence, and no embedding or props, with any writer of either source', async () => {
    const outputs = await runSentinelExports({ datamodel, permissions });
    const contentOutputs = await Promise.all(
      writersFor(KVOX_CONTENT_EXPORT_SOURCE).map(async (writer) => {
        const { bytes } = await collectExportOutput(writer, kvoxContentTables(sentinelContext()), KVOX_CONTENT_EXPORT_SOURCE_ID);
        return { source: KVOX_CONTENT_EXPORT_SOURCE_ID, format: writer.id, text: exportFileText(bytes) };
      }),
    );

    expect(outputs.length).toBeGreaterThanOrEqual(3);
    expect(contentOutputs).toHaveLength(3);

    const never = [
      ...modelNamed('KgItem').fields,
      ...modelNamed('KgEvidence').fields,
    ]
      .filter((field) => field.kind === 'scalar' || field.kind === 'enum')
      .flatMap((field) => [exportSentinel('KgItem', field.name), exportSentinel('KgEvidence', field.name)])
      .concat([
        exportSentinel('KgEntity', 'props'),
        exportSentinel('KgEntity', 'embeddingModel'),
        exportSentinel('KgEntity', 'embeddingHash'),
        exportSentinel('KgRelation', 'props'),
      ]);

    for (const output of [...outputs, ...contentOutputs]) {
      for (const sentinel of never) {
        expect(`${output.source}/${output.format}: ${output.text.includes(sentinel)}`).toBe(`${output.source}/${output.format}: false`);
      }
    }
    for (const output of contentOutputs) {
      // Not vacuous: the source did write the user's content.
      expect(output.text).toContain(exportSentinel('TranscriptSegment', 'text'));
      expect(output.text).toContain(exportSentinel('NoteVersion', 'body'));
      expect(output.text).toContain(exportSentinel('AskMessage', 'content'));
      // The columns the source leaves out.
      expect(output.text).not.toContain(exportSentinel('TranscriptSegment', 'words'));
      expect(output.text).not.toContain(exportSentinel('AskMessage', 'toolCalls'));
    }
  });

  it('writes no field of an excluded model other than the ones kvox-content exports on purpose', async () => {
    const forbidden = forbiddenExportSentinels(datamodel, USER_DATA_EXPORT_SOURCE_ID);
    const fromContent = new Set(['TranscriptSegment', 'NoteVersion', 'KgAttributeDef']);
    const tables = await drain(kvoxContentTables(sentinelContext()));
    const text = JSON.stringify(
      await Promise.all(tables.map(async (table) => {
        const rows = [];
        for await (const row of table.rows) rows.push(row);

        return rows;
      })),
    );

    const leaks = forbidden.filter((sentinel) => {
      const model = sentinel.replace(/^S3NT1N3L-/, '').split('-')[0];

      return !fromContent.has(model) && text.includes(sentinel);
    });

    expect(forbidden.length).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
  });
});
