-- Ontology 1.3.0 (GIC-03, #664): the `Risk` item type is stored in `kg_items`
-- with kind 'risk'. `kg_item_kind` is a PostgreSQL enum, so the new kind needs
-- its own value. Additive only: no row changes, no table rewrite, and the
-- kind-specific CHECK constraints (`kg_items_subject_required_chk`,
-- `kg_items_sensitivity_chk`) already treat any other kind like a
-- commitment/decision (subject optional, no sensitivity).
ALTER TYPE "kg_item_kind" ADD VALUE IF NOT EXISTS 'risk';
