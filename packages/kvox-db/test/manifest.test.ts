import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  KVOX_EXTENSIONS,
  KVOX_HOST_TABLES,
  KVOX_RAW_SQL_INDEXES,
  checkPackage,
  listPackageFragments,
  parseManifest,
  readInventories,
  readManifest,
  serializeManifest,
} from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const migrationsDir = join(PACKAGE_DIR, 'migrations');
const manifest = readManifest(migrationsDir);

describe('migrations/manifest.json', () => {
  it('records the sha256 of every migration.sql, comments included', () => {
    for (const entry of manifest.migrations) {
      const bytes = readFileSync(join(migrationsDir, entry.id, 'migration.sql'));
      expect(createHash('sha256').update(bytes).digest('hex'), entry.id).toBe(entry.sha256);
    }
  });

  it('has an entry for every migration directory and a directory for every entry', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(manifest.migrations.map((entry) => entry.id)).toEqual(dirs);
  });

  it('lists the ids in ascending order, each with a known slice and host-table list', () => {
    const ids = manifest.migrations.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    const fragments = new Set(listPackageFragments(join(PACKAGE_DIR, 'schema')).map((name) => name.split('.')[1]));
    for (const entry of manifest.migrations) {
      expect(fragments.has(entry.slice), `${entry.id} slice ${entry.slice}`).toBe(true);
      for (const table of entry.requiresHostTables) expect(KVOX_HOST_TABLES).toContain(table);
    }
    expect(ids).toHaveLength(20);
  });

  it('derives requiresHostTables from the foreign keys in the SQL', () => {
    for (const entry of manifest.migrations) {
      const sql = readFileSync(join(migrationsDir, entry.id, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
      const referenced = KVOX_HOST_TABLES.filter((table) => new RegExp(`REFERENCES\\s+"?${table}"?\\s*\\(`, 'i').test(sql));
      expect([...entry.requiresHostTables].sort(), entry.id).toEqual([...referenced].sort());
    }
  });

  it('is written in the canonical serialisation', () => {
    expect(serializeManifest(manifest)).toBe(readFileSync(join(migrationsDir, 'manifest.json'), 'utf8'));
  });

  it('refuses a malformed manifest', () => {
    expect(() => parseManifest('{"manifestVersion":2,"migrations":[]}')).toThrow(/manifestVersion/);
    expect(() => parseManifest('{"manifestVersion":1,"migrations":[{"id":"x","slice":"a","sha256":"0","requiresHostTables":[]}]}')).toThrow(/id/);
    const entry = { id: '20260101000000_a', slice: 'graph', sha256: 'a'.repeat(64), requiresHostTables: ['orders'] };
    expect(() => parseManifest(JSON.stringify({ manifestVersion: 1, migrations: [entry] }))).toThrow(/requiresHostTables/);
  });
});

describe('inventories', () => {
  const inventories = readInventories(PACKAGE_DIR);

  it('exports the inventory files as constants', () => {
    expect(KVOX_RAW_SQL_INDEXES).toEqual(inventories.rawSqlIndexes);
    expect(KVOX_EXTENSIONS.map((extension) => extension.name)).toEqual(['vector', 'pg_trgm']);
    expect(KVOX_EXTENSIONS[0]?.minVersion).toBe('0.5.0');
  });

  it('lists the seventeen special indexes of the domain by name', () => {
    expect(KVOX_RAW_SQL_INDEXES.map((index) => index.name).sort()).toEqual(
      [
        'ask_messages_one_running_turn_uniq_idx',
        'kg_entities_embedding_hnsw_idx',
        'kg_entities_label_trgm_idx',
        'kg_entity_aliases_normalized_trgm_idx',
        'kg_items_embedding_hnsw_idx',
        'kg_items_live_statement_uniq_idx',
        'kg_items_valid_gist_idx',
        'kg_proposals_note_draft_uniq_idx',
        'kg_proposals_note_extracting_uniq_idx',
        'kg_proposals_owner_import_extracting_uniq_idx',
        'kg_relations_speaker_link_uniq_idx',
        'kg_relations_valid_gist_idx',
        'notes_search_vector_idx',
        'search_embeddings_embedding_hnsw_idx',
        'transcript_segments_search_vector_idx',
        'transcript_speakers_transcript_id_label_key',
        'transcripts_title_search_vector_idx',
      ].sort(),
    );
  });

  it('names the generated columns, the evidence function and its four triggers', () => {
    expect(inventories.schemaObjects.generatedColumns).toHaveLength(3);
    expect(inventories.schemaObjects.functions.map((fn) => fn.name)).toEqual(['kg_assert_has_evidence']);
    expect(inventories.schemaObjects.triggers).toHaveLength(4);
    expect(inventories.schemaObjects.checkConstraints.every((c) => /^kg_.*_chk$/.test(c.name))).toBe(true);
  });

  it('is consistent with the migrations and the fragments (the package check)', () => {
    expect(checkPackage(PACKAGE_DIR)).toEqual([]);
  });
});
