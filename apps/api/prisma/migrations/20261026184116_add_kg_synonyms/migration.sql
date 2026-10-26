-- CreateTable
CREATE TABLE "kg_synonyms" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "terms" TEXT[] NOT NULL,
    "normalized" TEXT[] NOT NULL,
    "entity_type" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_synonyms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_synonyms_owner_id_idx" ON "kg_synonyms"("owner_id");

-- AddForeignKey
ALTER TABLE "kg_synonyms" ADD CONSTRAINT "kg_synonyms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HAND-WRITTEN: a synonym set holds 2..20 terms and `normalized` is index-aligned with `terms`.
ALTER TABLE "kg_synonyms" ADD CONSTRAINT "kg_synonyms_cardinality_chk" CHECK (cardinality("terms") BETWEEN 2 AND 20 AND cardinality("normalized") = cardinality("terms"));

-- HAND-WRITTEN: "which sets contain this normalized form" (GIN array containment); Prisma has no DSL for it.
CREATE INDEX "kg_synonyms_normalized_gin_idx" ON "kg_synonyms" USING GIN ("normalized");
