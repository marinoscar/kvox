-- Storage object ownership moves to a side table (issue #469, epic #467).
--
-- storage_objects.managed_by (which app module owns the object: 'transcripts',
-- 'notes' or 'graph') and storage_objects.part_size (the persisted multipart
-- part size) were app-only columns on a platform table, migration
-- 20260914120000_add_storage_part_size_and_managed_by, declared as the
-- deviation kvox:storage-managed-by-part-size. This migration:
--   1. creates kvox_object_ownership, keyed by the object id, with a composite
--      foreign key (object_id, org_id) because storage_objects is an org table
--      with forced row-level security and a foreign-key check bypasses RLS;
--   2. copies every managed object into it (the data move);
--   3. drops both deviation columns. part_size is not carried over: the part
--      size is now the platform's deployment-wide storage.partSize setting, and
--      a multipart upload in flight when this migration runs must be drained or
--      aborted first (docs/runbooks/storage-configuration.md).
--
-- The CreateTable and the DDL are what `prisma migrate dev --create-only`
-- printed; its DropIndex and ALTER COLUMN ... DROP DEFAULT statements for the
-- raw-SQL indexes and generated columns (HNSW, trigram, GiST, GIN tsvector) are
-- Prisma's known blind spot and were removed by hand. Never apply them.
--
-- One transaction. The copy reads and writes org tables, so it runs with the
-- row-level-security bypass on (set_config is_local = true, so it ends with the
-- transaction): a no-op for today's superuser connection, required once the app
-- runs as a non-superuser (#471).

BEGIN;

-- CreateTable
CREATE TABLE "kvox_object_ownership" (
    "object_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "managed_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kvox_object_ownership_pkey" PRIMARY KEY ("object_id")
);

-- CreateIndex
CREATE INDEX "kvox_object_ownership_managed_by_idx" ON "kvox_object_ownership"("managed_by");

-- CreateIndex
CREATE UNIQUE INDEX "kvox_object_ownership_object_id_org_id_key" ON "kvox_object_ownership"("object_id", "org_id");

-- AddForeignKey
ALTER TABLE "kvox_object_ownership" ADD CONSTRAINT "kvox_object_ownership_object_id_org_id_fkey" FOREIGN KEY ("object_id", "org_id") REFERENCES "storage_objects"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data move: every object an app module owns gets an ownership row.
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO "kvox_object_ownership" ("object_id", "org_id", "managed_by", "created_at")
SELECT "id", "org_id", "managed_by", now()
  FROM "storage_objects"
 WHERE "managed_by" IS NOT NULL;

-- AlterTable
ALTER TABLE "storage_objects" DROP COLUMN "managed_by",
DROP COLUMN "part_size";

COMMIT;
