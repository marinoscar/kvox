-- =============================================================================
-- Hand every object in an EXISTING database to the application role
-- =============================================================================
--
-- A database created before the application role existed is owned by the
-- bootstrap superuser, and so is every table the migrations created. Row-level
-- security does not apply to a superuser, so the API cannot be switched to an
-- ordinary role until that ownership moves. A FRESH volume does not need this:
-- the postgres-init scripts create the role first and the migrations then
-- create every object as it. Procedure: docs/runbooks/application-role.md.
--
-- Run it as a SUPERUSER, connected to the application database, in the window
-- where the API is stopped:
--
--   psql -v ON_ERROR_STOP=1 -v app=kvox_app -d "$POSTGRES_DB" \
--        -f apps/api/scripts/transfer-ownership.sql
--
--   app   (required) the application role. It must already exist, and must be
--         NOSUPERUSER NOBYPASSRLS (the script refuses anything else, because
--         the whole point is that row-level security applies to it).
--   db    (optional) the database to hand over; defaults to the one connected
--         to, and must be that one.
--
-- What moves to the role: the database, schema public, and every table,
-- partitioned table, view, materialized view, foreign table, sequence,
-- function, procedure, aggregate and type (enum, domain, range, standalone
-- composite) that is in schema public AND is not a member of an extension.
-- Indexes, constraints, triggers and TOAST tables follow their table.
--
-- What stays with the bootstrap superuser, on purpose: the extensions
-- (uuid-ossp, vector, pg_trgm) and every object they own. An ordinary role
-- cannot always create an extension (vector is not "trusted"), and an
-- extension's owner must be able to upgrade it; the bootstrap login does that.
--
-- Idempotent: an object the role already owns is skipped, so a re-run after a
-- partial failure, or on an already-converted database, changes nothing. The
-- whole transfer is one transaction, and ends with a check that fails (and so
-- rolls back) if anything the application should own is still owned by someone
-- else.
--
-- The statements are generated with \gexec rather than a DO block because psql
-- does not substitute :'app' inside a dollar-quoted body.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- --- Preconditions -----------------------------------------------------------

SELECT current_database() AS current_db,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser \gset

\if :{?app}
\else
  DO $$ BEGIN RAISE EXCEPTION 'transfer-ownership: pass the application role, e.g. -v app=kvox_app'; END $$;
  \quit
\endif

\if :{?db}
\else
  \set db :current_db
\endif

SELECT (:'db' = current_database()) AS db_matches,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') AS role_exists,
       COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = :'app'), false) AS role_privileged \gset

\if :is_superuser
\else
  DO $$ BEGIN RAISE EXCEPTION 'transfer-ownership: run this as a superuser (the bootstrap login), not as the application role'; END $$;
  \quit
\endif

\if :db_matches
\else
  DO $$ BEGIN RAISE EXCEPTION 'transfer-ownership: db must be the database this session is connected to'; END $$;
  \quit
\endif

\if :role_exists
\else
  DO $$ BEGIN RAISE EXCEPTION 'transfer-ownership: the role does not exist; create it first (postgres-init/10-application-role.sh does it on a fresh volume, the runbook shows the CREATE ROLE for an existing one)'; END $$;
  \quit
\endif

\if :role_privileged
  DO $$ BEGIN RAISE EXCEPTION 'transfer-ownership: refusing a role that is SUPERUSER or BYPASSRLS; row-level security would stay inert'; END $$;
  \quit
\endif

-- --- The transfer ------------------------------------------------------------

BEGIN;

-- Carried into the closing check (a DO body cannot see psql variables).
SELECT set_config('transfer_ownership.app', :'app', true) \gset

ALTER DATABASE :"db" OWNER TO :"app";
ALTER SCHEMA public OWNER TO :"app";

-- Tables (ordinary and partitioned), views, materialized views, foreign tables.
-- Before sequences: an owned-by sequence follows its table.
SELECT format('ALTER %s %I.%I OWNER TO %I',
              CASE c.relkind WHEN 'v' THEN 'VIEW'
                             WHEN 'm' THEN 'MATERIALIZED VIEW'
                             WHEN 'f' THEN 'FOREIGN TABLE'
                             ELSE 'TABLE' END,
              n.nspname, c.relname, :'app')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = :'app')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
 ORDER BY c.relkind, c.relname
\gexec

-- Sequences (a sequence that follows its table is already owned by the role).
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, :'app')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'S'
   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = :'app')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
 ORDER BY c.relname
\gexec

-- Types: enums, domains, ranges and standalone composites. An array type, a
-- multirange and a table's row type follow their element, range or table.
SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, :'app')
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public'
   AND (t.typtype IN ('e', 'r')
        OR (t.typtype = 'd')
        OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
   AND t.typowner <> (SELECT oid FROM pg_roles WHERE rolname = :'app')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
 ORDER BY t.typname
\gexec

-- Functions, procedures, aggregates (kg_assert_has_evidence, the knowledge
-- graph evidence trigger, is the only one today).
SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, :'app')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = :'app')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
 ORDER BY p.proname
\gexec

-- --- Closing check -----------------------------------------------------------
-- Anything the application should own but does not fails the script, and the
-- transaction with it.

DO $check$
DECLARE
  app_oid  oid := (SELECT oid FROM pg_roles WHERE rolname = current_setting('transfer_ownership.app'));
  leftover text;
BEGIN
  SELECT string_agg(kind || ' ' || name, E'\n  ' ORDER BY kind, name) INTO leftover FROM (
    SELECT 'relation' AS kind, c.relname::text AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
       AND c.relowner <> app_oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'type', t.typname::text
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typtype IN ('e', 'r', 'd')
       AND t.typowner <> app_oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'routine', p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proowner <> app_oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'schema', nspname::text FROM pg_namespace WHERE nspname = 'public' AND nspowner <> app_oid
    UNION ALL
    SELECT 'database', datname::text FROM pg_database WHERE datname = current_database() AND datdba <> app_oid
  ) s;

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION E'objects still not owned by the application role:\n  %', leftover;
  END IF;
END
$check$;

COMMIT;

\echo 'transfer-ownership: done; the database and every application-owned object belong to the role'
