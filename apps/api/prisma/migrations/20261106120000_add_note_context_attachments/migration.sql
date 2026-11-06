-- Note context attachments (issue #810): note_context_attachments and
-- note_generations.context_attachments. Pure DDL; foreign keys target notes and
-- storage_objects only. The kind CHECK is raw SQL (schema-objects.json); no
-- partial or expression index is needed.

-- AlterTable
ALTER TABLE "note_generations" ADD COLUMN     "context_attachments" JSONB;

-- CreateTable
CREATE TABLE "note_context_attachments" (
    "id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" VARCHAR(1024) NOT NULL,
    "mime_type" VARCHAR(255) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_context_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_context_attachments_object_id_idx" ON "note_context_attachments"("object_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_context_attachments_note_id_object_id_key" ON "note_context_attachments"("note_id", "object_id");

-- AddForeignKey
ALTER TABLE "note_context_attachments" ADD CONSTRAINT "note_context_attachments_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_context_attachments" ADD CONSTRAINT "note_context_attachments_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AddCheckConstraint
ALTER TABLE "note_context_attachments" ADD CONSTRAINT "note_context_attachments_kind_chk" CHECK ("kind" IN ('document', 'image'));
