-- =============================================================================
-- `kg_exports` — RDF exports of one owner's graph (issue #386, epic #349)
-- =============================================================================
-- One row per requested JSON-LD / Turtle / N-Quads render, produced by the
-- `kg.export` job into a `managed_by: 'graph'` storage object and expiring
-- after 7 days (spec §18.2). Content-addressed on `graph_fingerprint`, a plain
-- non-unique lookup index exactly like `note_exports_lookup_idx`. Every
-- constraint is Prisma-expressible — no hand-written SQL, no schema drift.
-- See the block comment above `KgExport` in schema.prisma.
-- =============================================================================

-- CreateEnum
CREATE TYPE "kg_export_format" AS ENUM ('jsonld', 'turtle', 'nquads');

-- CreateEnum
CREATE TYPE "kg_export_status" AS ENUM ('pending', 'running', 'ready', 'failed');

-- CreateTable
CREATE TABLE "kg_exports" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "format" "kg_export_format" NOT NULL,
    "status" "kg_export_status" NOT NULL DEFAULT 'pending',
    "graph_fingerprint" TEXT NOT NULL,
    "ontology_version" TEXT NOT NULL,
    "object_id" UUID,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "job_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kg_exports_job_id_key" ON "kg_exports"("job_id");

-- CreateIndex
CREATE INDEX "kg_exports_owner_id_format_graph_fingerprint_idx" ON "kg_exports"("owner_id", "format", "graph_fingerprint");

-- CreateIndex
CREATE INDEX "kg_exports_expires_at_idx" ON "kg_exports"("expires_at");

-- AddForeignKey
ALTER TABLE "kg_exports" ADD CONSTRAINT "kg_exports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_exports" ADD CONSTRAINT "kg_exports_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_exports" ADD CONSTRAINT "kg_exports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
