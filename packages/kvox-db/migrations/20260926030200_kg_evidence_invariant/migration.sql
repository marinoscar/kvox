-- =============================================================================
-- The knowledge graph's no-orphans invariant, enforced by the database
-- (issue #355, epic #344; docs/specs/ontology.md §3.3, §5.3, §8)
-- =============================================================================
--
-- HAND-WRITTEN, INTENTIONAL SCHEMA DRIFT: Prisma has no DSL for a trigger, so
-- nothing here appears in schema.prisma — the same pattern as the partial
-- unique indexes and CHECK constraints the kg_* migration already carries.
--
-- The invariant: every `accepted`/`edited` entity, relation and item carries
-- at least one `kg_evidence` row. `GraphWriteService` checks it before any SQL
-- runs; this is the BACKSTOP for a writer that bypasses the service (a raw
-- SQL fix, a hurried migration), turning a silent orphan into a failed COMMIT.
--
-- DEFERRED, not immediate: a writer inserts the subject first and its
-- evidence second, inside one transaction — an immediate check would fail
-- between the two statements. `DEFERRABLE INITIALLY DEFERRED` runs every check
-- at COMMIT, against the transaction's final state:
--
--   - The subject's CURRENT review status is re-read at COMMIT, so a subject
--     deleted in the same transaction (purge, forget, revert) finds no row and
--     passes, and a merge tombstone (`merged`) whose evidence was re-pointed at
--     the survivor passes.
--   - `kg_evidence` rows anchoring a proposal item or an import are not graph
--     rows and are never checked (the WHEN clause).
--
-- SQLSTATE 23514 (check_violation). Surfacing it is a writer bug, never a user
-- error: the service maps it to a 500 and logs `kg no-orphans invariant
-- violated` at error level.
-- =============================================================================

CREATE FUNCTION kg_assert_has_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text := TG_ARGV[0]; subj uuid; status text;
BEGIN
  IF TG_TABLE_NAME = 'kg_evidence' THEN subj := OLD.subject_id; kind := OLD.subject_kind::text;
  ELSE subj := NEW.id; END IF;
  -- re-read the subject's CURRENT status; it may have been deleted or tombstoned in the same tx
  EXECUTE format('SELECT review_status::text FROM %I WHERE id = $1',
                 CASE kind WHEN 'entity' THEN 'kg_entities' WHEN 'relation' THEN 'kg_relations' WHEN 'item' THEN 'kg_items' END)
    INTO status USING subj;
  IF status IN ('accepted','edited') AND NOT EXISTS (
       SELECT 1 FROM kg_evidence WHERE subject_kind::text = kind AND subject_id = subj) THEN
    RAISE EXCEPTION 'kg no-orphans invariant: % % has no evidence', kind, subj USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER kg_entities_evidence_trg AFTER INSERT OR UPDATE OF review_status ON kg_entities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kg_assert_has_evidence('entity');

CREATE CONSTRAINT TRIGGER kg_relations_evidence_trg AFTER INSERT OR UPDATE OF review_status ON kg_relations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kg_assert_has_evidence('relation');

CREATE CONSTRAINT TRIGGER kg_items_evidence_trg AFTER INSERT OR UPDATE OF review_status ON kg_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kg_assert_has_evidence('item');

CREATE CONSTRAINT TRIGGER kg_evidence_delete_trg AFTER DELETE OR UPDATE OF subject_id ON kg_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.subject_kind IN ('entity','relation','item'))
  EXECUTE FUNCTION kg_assert_has_evidence('evidence');   -- arg ignored: the kind is read from OLD.subject_kind
