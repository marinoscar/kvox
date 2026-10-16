import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { KVOX_RAW_SQL_INDEXES, checkFragmentDeclarations, listPackageFragments, scanFragmentIndexes } from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const schemaDir = join(PACKAGE_DIR, 'schema');
const fragments = listPackageFragments(schemaDir).map((name) => ({ file: `schema/${name}`, text: readFileSync(join(schemaDir, name), 'utf8') }));

describe('raw-SQL index tripwire', () => {
  it('finds no fragment that redeclares a listed index', () => {
    expect(checkFragmentDeclarations(fragments, KVOX_RAW_SQL_INDEXES)).toEqual([]);
  });

  it('reads the declarations of the real fragments (the scan is not vacuous)', () => {
    const all = fragments.flatMap((fragment) => scanFragmentIndexes(fragment.file, fragment.text));
    expect(all.length).toBeGreaterThan(50);
    // The plain b-tree next to the partial unique index is a separate, legitimate index.
    expect(all.some((d) => d.table === 'kg_relations' && d.kind === '@@index' && d.columns.join() === 'from_speaker_id')).toBe(true);
  });

  const graph = fragments.find((fragment) => fragment.file.endsWith('kvox.graph.prisma'))!;

  it('fails when a fragment adds @@unique on the column of a partial unique index', () => {
    const edited = graph.text.replace('model KgProposal {\n', 'model KgProposal {\n  @@unique([noteId])\n');
    expect(edited).not.toBe(graph.text);
    const problems = checkFragmentDeclarations([{ file: graph.file, text: edited }], KVOX_RAW_SQL_INDEXES);
    expect(problems.map((p) => p.code)).toEqual(['FRAGMENT_DECLARES_RAW_INDEX', 'FRAGMENT_DECLARES_RAW_INDEX']);
    expect(problems[0]?.message).toContain('kg_proposals_note_');
  });

  it('fails when a fragment declares an index under the name of a listed one', () => {
    const edited = graph.text.replace('model KgItem {\n', 'model KgItem {\n  @@index([ownerId], map: "kg_items_live_statement_uniq_idx")\n');
    expect(edited).not.toBe(graph.text);
    const problems = checkFragmentDeclarations([{ file: graph.file, text: edited }], KVOX_RAW_SQL_INDEXES);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('kg_items_live_statement_uniq_idx');
  });

  it('fails on a single-field @unique over the same key', () => {
    const text = 'model TranscriptSpeaker {\n  label String? @unique\n  @@map("transcript_speakers")\n}\n';
    const problems = checkFragmentDeclarations([{ file: 'f.prisma', text }], [
      { name: 'x_idx', table: 'transcript_speakers', definition: 'CREATE UNIQUE INDEX x_idx ON public.transcript_speakers USING btree (label) WHERE (label IS NOT NULL)' },
    ]);
    expect(problems).toHaveLength(1);
  });
});
