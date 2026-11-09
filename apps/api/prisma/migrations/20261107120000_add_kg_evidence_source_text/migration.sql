-- AlterTable
ALTER TABLE "kg_evidence" ADD COLUMN     "source_object_id" UUID,
ADD COLUMN     "source_text_length" INTEGER;

-- CreateIndex
CREATE INDEX "kg_evidence_source_object_id_idx" ON "kg_evidence"("source_object_id");

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_source_object_id_fkey" FOREIGN KEY ("source_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HAND-WRITTEN (issue #789): a source-text citation anchors a span of the text
-- extracted from the document a note was generated from. `source_object_id`
-- names that text object (SetNull, like every other anchor, so the citation
-- survives the text being purged); `source_text_length` is the length of the
-- text `char_start`/`char_end` were measured against and is the DURABLE marker
-- of this anchor kind, because it survives the SetNull. The CHECK keeps the pair
-- coherent: a named text object always carries a length, and the span never runs
-- past the text it indexes. It does NOT require an anchor to be present (see the
-- "WHY THERE IS NO ANCHOR CHECK" note on kg_evidence).
--
-- The deferred no-orphans trigger (kg_assert_has_evidence, migration
-- 20260926030200) is unchanged and stays satisfied: it asks only that SOME
-- kg_evidence row exists for an accepted/edited entity, relation or item, and a
-- source-text citation is a kg_evidence row like any other.
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_source_text_chk"
  CHECK (
    ("source_object_id" IS NULL OR "source_text_length" IS NOT NULL)
    AND ("source_text_length" IS NULL OR "source_text_length" >= 0)
    AND ("source_text_length" IS NULL OR "char_end" IS NULL OR "char_end" <= "source_text_length")
  );
