-- =============================================================================
-- `kg_graph_layouts` — whole-graph layout snapshots (issue #371, epic #347)
-- =============================================================================
-- Latest precomputed clusters + positions per owner, produced by the
-- `kg.graph_layout` job (spec §22). A cache of derived data, never a source
-- of truth: entity/relation labels are deliberately NOT stored here, so a
-- renamed or forgotten entity never shows a stale label through this table
-- (spec §15). See the block comment above `KgGraphLayout` in schema.prisma.
-- =============================================================================

-- CreateTable
CREATE TABLE "kg_graph_layouts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "node_count" INTEGER NOT NULL,
    "edge_count" INTEGER NOT NULL,
    "clusters" JSONB NOT NULL,
    "positions" JSONB NOT NULL,
    "ontology_version" TEXT NOT NULL,
    "source_updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "kg_graph_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_graph_layouts_owner_id_computed_at_idx" ON "kg_graph_layouts"("owner_id", "computed_at" DESC);

-- AddForeignKey
ALTER TABLE "kg_graph_layouts" ADD CONSTRAINT "kg_graph_layouts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
