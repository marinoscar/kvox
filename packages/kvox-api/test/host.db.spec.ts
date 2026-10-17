import { Test } from '@nestjs/testing';

import { KVOX_PRISMA } from '../src/ports/index.js';
import { createTestDb, createTestKvoxModule, type TestDb } from './host/db.js';

// =============================================================================
// The test host itself (issue #492, epic #491)
// =============================================================================
//
// Proves the harness every later slice's real-database specs stand on: the
// platform and domain migrations apply cleanly to a fresh PostgreSQL 16 with
// pgvector, the extensions and the raw-SQL objects are there, and the ports
// module binds `KVOX_PRISMA` to the host client.
// =============================================================================

describe('the kvox-api test host', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.dispose();
  });

  it('applies every platform and domain migration', async () => {
    const rows = await db.prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`;

    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((row) => row.finished_at !== null)).toBe(true);
    expect(rows.some((row) => row.migration_name.includes('kvox_add_transcripts'))).toBe(true);
  });

  it('has the extensions and the tables of both halves', async () => {
    const extensions = await db.prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')`;
    expect(extensions.map((row) => row.extname).sort()).toEqual(['pg_trgm', 'vector']);

    const tables = await db.prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND tablename IN ('users', 'storage_objects', 'jobs', 'transcripts', 'notes', 'kg_entities', 'search_embeddings', 'ask_messages')`;
    expect(tables).toHaveLength(8);
  });

  it('keeps a raw-SQL index that Prisma cannot express', async () => {
    const rows = await db.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'ask_messages_one_running_turn_uniq_idx'`;
    expect(rows).toHaveLength(1);
  });

  it('binds KVOX_PRISMA to the host client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [createTestKvoxModule({ db })],
    }).compile();

    expect(moduleRef.get(KVOX_PRISMA, { strict: false })).toBe(db.prisma);

    await moduleRef.close();
  });
});
