-- Note libraries (issue #713, epic #708): note_libraries, note_library_files,
-- note_import_batches, note_import_batch_items. Pure DDL; every foreign key
-- targets users, notes, storage_objects or a table created here. No raw-SQL
-- index is needed.

-- CreateEnum
CREATE TYPE "NoteLibraryFileStatus" AS ENUM ('pending', 'importing', 'imported', 'failed', 'missing', 'unsupported', 'diverged');

-- CreateEnum
CREATE TYPE "NoteImportBatchStatus" AS ENUM ('scanning', 'running', 'completed', 'completed_with_errors', 'cancelled');

-- CreateEnum
CREATE TYPE "NoteImportBatchItemAction" AS ENUM ('new', 'changed', 'missing');

-- CreateEnum
CREATE TYPE "NoteImportBatchItemStatus" AS ENUM ('queued', 'importing', 'imported', 'failed', 'missing', 'skipped');

-- CreateTable
CREATE TABLE "note_libraries" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "auto_extract" BOOLEAN NOT NULL DEFAULT true,
    "auto_commit" BOOLEAN NOT NULL DEFAULT false,
    "last_scan_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "note_libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_library_files" (
    "id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "relative_path" VARCHAR(1024) NOT NULL,
    "size" BIGINT NOT NULL,
    "mtime" TIMESTAMPTZ(3) NOT NULL,
    "content_hash" CHAR(64),
    "note_id" UUID,
    "imported_version" INTEGER,
    "extracted_version" INTEGER,
    "status" "NoteLibraryFileStatus" NOT NULL DEFAULT 'pending',
    "failure_reason" VARCHAR(64),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "note_library_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_import_batches" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "library_id" UUID,
    "status" "NoteImportBatchStatus" NOT NULL DEFAULT 'scanning',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "note_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_import_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "file_id" UUID,
    "filename" VARCHAR(1024) NOT NULL,
    "path" VARCHAR(1024),
    "action" "NoteImportBatchItemAction" NOT NULL,
    "source_object_id" UUID,
    "note_id" UUID,
    "note_version" INTEGER,
    "diverged" BOOLEAN NOT NULL DEFAULT false,
    "status" "NoteImportBatchItemStatus" NOT NULL DEFAULT 'queued',
    "failure_reason" VARCHAR(64),
    "job_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "note_import_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_libraries_owner_id_created_at_idx" ON "note_libraries"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "note_library_files_note_id_idx" ON "note_library_files"("note_id");

-- CreateIndex
CREATE INDEX "note_library_files_library_id_status_idx" ON "note_library_files"("library_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "note_library_files_library_id_relative_path_key" ON "note_library_files"("library_id", "relative_path");

-- CreateIndex
CREATE INDEX "note_import_batches_owner_id_created_at_idx" ON "note_import_batches"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "note_import_batches_library_id_created_at_idx" ON "note_import_batches"("library_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "note_import_batch_items_batch_id_status_idx" ON "note_import_batch_items"("batch_id", "status");

-- AddForeignKey
ALTER TABLE "note_libraries" ADD CONSTRAINT "note_libraries_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_library_files" ADD CONSTRAINT "note_library_files_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "note_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_library_files" ADD CONSTRAINT "note_library_files_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batches" ADD CONSTRAINT "note_import_batches_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batches" ADD CONSTRAINT "note_import_batches_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "note_libraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batch_items" ADD CONSTRAINT "note_import_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "note_import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batch_items" ADD CONSTRAINT "note_import_batch_items_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "note_library_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batch_items" ADD CONSTRAINT "note_import_batch_items_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_import_batch_items" ADD CONSTRAINT "note_import_batch_items_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
