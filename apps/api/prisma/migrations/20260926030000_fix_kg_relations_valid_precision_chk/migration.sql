-- =============================================================================
-- Fix kg_relations_valid_precision_chk's NULL hole (issue #398, epic #344)
-- =============================================================================
--
-- 20260926012548_add_knowledge_graph (#351) wrote this CHECK as
--
--   ("valid" IS NULL) = ("valid_precision" IS NULL) OR "valid_precision" = 'unknown'
--
-- With `valid` set and `valid_precision` NULL, the equality is false and
-- `"valid_precision" = 'unknown'` is NULL, so the whole expression is
-- `false OR NULL` = NULL. PostgreSQL treats a NULL CHECK result as SATISFIED
-- (only an explicit false fails a CHECK), so the one row this constraint
-- exists to reject — a range with no stated precision — was silently accepted.
--
-- `IS NOT DISTINCT FROM` is never NULL: a NULL precision makes that branch
-- false, and the row is rejected. The intended exemption is unchanged — a
-- relation whose time is admittedly unknown may still carry 'unknown' with
-- no range.
--
-- Safe to replace in place: nothing writes kg_relations yet (#355 is the
-- first writer), so no existing row can violate the corrected constraint.
-- Hand-written, like the original: Prisma cannot express a CHECK.
-- =============================================================================

ALTER TABLE "kg_relations" DROP CONSTRAINT "kg_relations_valid_precision_chk";

ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_valid_precision_chk"
  CHECK (("valid" IS NULL) = ("valid_precision" IS NULL)
         OR "valid_precision" IS NOT DISTINCT FROM 'unknown');
