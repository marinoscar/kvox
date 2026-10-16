# Runbook: Move the API to the Application Database Role

**Audience:** whoever operates this deployment's database.
**Applies to:** an **existing** database that the API still reaches as `postgres`
(a superuser). A fresh development or test volume needs none of this:
`infra/compose/postgres-init/10-application-role.sh` and
`20-kvox-extensions.sh` create the role and the extensions on its first start.

Source of truth for every claim below:

- `apps/api/scripts/transfer-ownership.sql` — the ownership transfer, with its
  preconditions and its closing check.
- `infra/compose/postgres-init/10-application-role.sh` — the role attributes
  (copied from the platform, never hand-edited) and
  `infra/compose/postgres-init/20-kvox-extensions.sh` — the extensions.
- `docs/SECURITY-ARCHITECTURE.md`, "Tenant isolation (RLS)" — why the role
  matters.
- `docs/ARCHITECTURE.md` section 7.10 — where it sits in the system.

---

## Why this exists

Platform migration `0025_org_scoped_rls` forces row-level security on
`storage_objects`, `storage_object_chunks`, `ai_runs` and `ai_usage_events`, and
`0026` to `0029` do the same for the group, grant and organization-settings
tables. **A superuser skips every policy.** While the API connects as
`postgres`, tenant isolation is inert and the Doctor check `db.rls_role` fails.
Every KVox read of `storage_objects` already goes through `runInOrg` (#469), so
it is safe to connect as an ordinary role.

The target state:

| | |
|---|---|
| Role | `APP_DB_USER` (default `kvox_app`): `LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE` |
| Owns | the database, schema `public`, and every table, sequence, type and function the migrations created |
| Does not own | the extensions `vector`, `pg_trgm` and `uuid-ossp`; they stay with the bootstrap superuser |
| The API signs in with | `POSTGRES_USER` / `POSTGRES_PASSWORD` set to the role's login |
| Bootstrap login | `postgres`, for administration only (this runbook, extensions, restores by hand) |

`CREATEDB` is what restore needs to create, rename and drop databases.
`CREATEROLE` is what the worker-node credential broker needs to mint per-job
roles. The role never gets `SUPERUSER` or `BYPASSRLS`, not even to make a backup
or a restore work: those lift row-level security for their own session with
`--enable-row-security` plus `PGOPTIONS=-c app.rls_bypass=on`
(`docs/specs/database-backup.md` section 17).

---

## 1. Prerequisites

- **A superuser login** to the cluster (the bootstrap `postgres`, or your
  provider's superuser equivalent). The ownership script refuses to run as
  anyone else. The application role must not be used to run it.
- **A recent verified backup**, downloadable. Take a fresh one from
  `/admin/settings/db-backup` and confirm it reaches `completed`. Ownership
  changes are reversible (section 7), but you want a way back that does not
  depend on that argument.
- **The extensions already exist in the database.** They do on every deployment
  that has run the migrations as a superuser:

  ```sql
  SELECT extname, extowner::regrole FROM pg_extension
   WHERE extname IN ('vector', 'pg_trgm', 'uuid-ossp');
  ```

  Three rows, owned by the superuser. If one is missing, create it now as the
  superuser (`CREATE EXTENSION IF NOT EXISTS vector;`). The historical migration
  that creates `vector` says `IF NOT EXISTS`, so it is a no-op for the
  application role **only because the extension is already there**. Never edit
  that migration.
- **A maintenance window.** The API must be stopped while ownership moves. Plan
  for a few minutes on a database of ordinary size; the transfer is one
  transaction and touches only catalog rows.
- **A password for the role**, generated and stored where you keep secrets
  (`openssl rand -base64 24`).
- **Where to edit the environment.** A VPS deployment keeps the canonical file at
  `/opt/infra/apps/<name>/.env` (`docs/deployment/vps.md` section 9); a
  development checkout uses `infra/compose/.env`.
- **Managed PostgreSQL.** Pending agent report: the managed-PostgreSQL
  `CREATEROLE` caveat and what the provider's administrator can and cannot run
  (the script needs a superuser; a provider administrator that is not one has to
  run its statements by hand). The rule that holds everywhere: `ALTER ... OWNER
  TO` requires the executing role to be a member of the new owning role.

Run every `psql` below from a checkout of the repository on a host that reaches
the database, and `export PGPASSWORD` for the superuser first.

---

## 2. Rehearse on a restored copy

Do this once, before the production window, against a copy of production.
The role is cluster-wide, so on the same cluster the rehearsal creates the real
role (harmless: it owns nothing yet); use a different cluster if you would
rather not.

1. **Restore the newest archive into a scratch database**, following
   `docs/runbooks/database-restore.md` section 4.1 to 4.3 (download, sanity
   check, `createdb`, `pg_restore`). As a superuser the restore bypasses
   row-level security by itself; the commands there carry the flag and option
   pair for any other role.
2. **Create the role** (section 3).
3. **Transfer the scratch database**:

   ```bash
   psql -v ON_ERROR_STOP=1 -v app=kvox_app \
     --host=<db host> --port=<db port> --username=postgres --dbname=<scratch> \
     -f apps/api/scripts/transfer-ownership.sql
   ```

4. **Check it**:

   ```sql
   -- Nothing in public is owned by anyone but the role (extension members aside):
   SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1;
   SELECT datname, datdba::regrole FROM pg_database WHERE datname = '<scratch>';
   ```

5. **Run the application's own migrations as the role** against the copy. It must
   report nothing pending and fail on no permission:

   ```bash
   cd apps/api
   POSTGRES_HOST=<db host> POSTGRES_PORT=<db port> POSTGRES_DB=<scratch> \
   POSTGRES_USER=kvox_app POSTGRES_PASSWORD=<app password> \
   npm run prisma:migrate
   ```

6. **Prove isolation** as the role, on the copy:

   ```sql
   -- connected as kvox_app, app.org_id unset: zero rows, not an error.
   SELECT count(*) FROM storage_objects;
   ```

   A count of 0 on a database that has objects is the expected, correct answer.
   Inside the application the same read goes through `runInOrg` and returns the
   real count.
7. **Optionally start an API container** against the copy (`POSTGRES_DB=<scratch>`,
   role login) and open a transcript with media, the library, and the Doctor.
8. **Drop the scratch database** (`DROP DATABASE "<scratch>";`), and write down
   how long step 3 took.

If anything in 3 to 6 fails, stop and read the error: the script's closing check
names every object it could not hand over.

---

## 3. Create the role

As the superuser, connected to the application database:

```bash
psql -v ON_ERROR_STOP=1 \
  -v app_user=kvox_app -v app_password='<the password>' \
  --host=<db host> --port=<db port> --username=postgres --dbname=<POSTGRES_DB> <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE;
-- PostgreSQL 16: makes every role this one creates (the node-offload broker's
-- per-job roles) inherit-and-set for it, so it can DROP OWNED BY them.
ALTER ROLE :"app_user" SET createrole_self_grant = 'inherit, set';
SQL
```

These are the attributes `10-application-role.sh` gives the role on a fresh
volume. The script's two ownership statements (`ALTER DATABASE ... OWNER`,
`ALTER SCHEMA public OWNER`) are in the next section's script, which also covers
every table. On PostgreSQL older than 16 omit the `ALTER ROLE ... SET` line.

If the role already exists, check it instead of creating it:

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = 'kvox_app';
-- want: f, f, t, t
```

The role needs `CONNECT` on the database (granted to `PUBLIC` by default) and no
other grant: it will own everything it uses.

---

## 4. Transfer ownership

In the window, with the API **stopped** (`docker compose ... stop api`, or
`kvox deploy` tooling for a VPS deployment; stop every replica and every
`kvox node` that reads the database):

```bash
psql -v ON_ERROR_STOP=1 -v app=kvox_app \
  --host=<db host> --port=<db port> --username=postgres --dbname=<POSTGRES_DB> \
  -f apps/api/scripts/transfer-ownership.sql
```

What it does, in one transaction:

- refuses to run unless you are a superuser, the role exists, and the role is
  **not** a superuser or `BYPASSRLS` (the point is that row-level security
  applies to it);
- moves the database, schema `public`, and every table, partitioned table, view,
  materialized view, sequence, function (`kg_assert_has_evidence`), enum and
  other type in `public` to the role;
- **skips** the extensions and every object they own;
- ends with a check that fails, and so rolls everything back, if anything the
  application should own is still owned by someone else.

It is idempotent: a re-run, or a run on a database that already belongs to the
role, changes nothing. Output ends with
`transfer-ownership: done; the database and every application-owned object belong to the role`.

The extensions stay owned by the superuser on purpose. An ordinary role cannot
create `vector` (it is not a trusted extension), and an extension's owner is the
one who upgrades it. Pending agent report: extension-ownership findings from the
rehearsal on a scratch cluster (including `pg_restore` of an archive that
contains `CREATE EXTENSION` as the role).

---

## 5. Switch the API login and restart

Set the API's login to the role. In `.env` (see section 1 for where it lives):

```bash
POSTGRES_USER=kvox_app
POSTGRES_PASSWORD=<the role's password>
# Used only when a development or test volume is initialised; keep them equal.
APP_DB_USER=kvox_app
APP_DB_PASSWORD=<the role's password>
```

`infra/compose/.env.example` carries the same variables, with
`POSTGRES_USER=kvox_app` and the `APP_DB_*` pair kept equal to
`POSTGRES_USER` and `POSTGRES_PASSWORD`. A deployment's database already exists,
so `APP_DB_*` are read by `devdb.compose.yml` and `test.compose.yml` only, and
`kvox deploy` never writes them. Pending agent report: the exact `kvox deploy`
behaviour for an existing `.env` (whether `update` leaves `POSTGRES_USER`
alone, and the restart command).

Then restart the API so it reconnects as the role:

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d --force-recreate api
```

(A VPS deployment uses its own file list; `kvox deploy update` rebuilds and
restarts with the right one, and `docs/deployment/vps.md` section 6 describes it.)

Run migrations as the role to confirm it owns what it needs
(`docker compose run --rm api npm run prisma:migrate` should report nothing
pending) and watch the API log for a clean start.

Two things that follow from the switch:

- **A dump or restore still sees every row.** They carry the bypass option and
  flag pair, not the role's attributes. Take one backup right away and confirm
  it completes: Doctor `backup.rls-bypass` compares the counts.
- **The telemetry collector** scrapes PostgreSQL with `POSTGRES_MONITOR_USER` /
  `POSTGRES_MONITOR_PASSWORD`, which fall back to the API's login. Leave them
  blank or give the collector a dedicated `pg_monitor` role.

---

## 6. Check the Doctor

```bash
curl -s -H "Authorization: Bearer $ADMIN" http://localhost:3535/api/admin/doctor \
  | jq '.data.checks[] | select(.id=="db.rls_role" or .id=="backup.rls-bypass")'
```

Or open `/admin/settings/doctor`. Expected:

- `db.rls_role` is `pass` (the role is `rolsuper = false AND rolbypassrls = false`).
- `backup.rls-bypass` is `pass`.
- The overall verdict no longer carries the documented `db.rls_role` failure.

By hand, as the role:

```sql
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- want: kvox_app | f | f
```

Then a short smoke as a real user: sign in, open the library and one transcript
with media, play it, upload a small file, run one note generation, take a
backup. **If rows vanish** (a list that is suddenly empty), a read is bypassing
`runInOrg`: roll back (section 7) and report it; do not widen the role.

---

## 7. Rollback

Set `POSTGRES_USER` and `POSTGRES_PASSWORD` back to the `postgres` login and
restart the API (section 5, reversed). **Ownership can stay as it is**: a
superuser ignores ownership, so nothing needs to be transferred back and no
restore is needed. Row-level security is inert again and the Doctor reports
`db.rls_role` as `fail`, which is the state you started from.

To remove the role entirely afterwards (optional):

```sql
REASSIGN OWNED BY kvox_app TO postgres;
DROP OWNED BY kvox_app;
DROP ROLE kvox_app;
```

Do that only with the API stopped and after the switch back.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Script: `run this as a superuser` | You connected as the application role or another ordinary role. Use the bootstrap login. |
| Script: `refusing a role that is SUPERUSER or BYPASSRLS` | The role was created too privileged. `ALTER ROLE kvox_app NOSUPERUSER NOBYPASSRLS;` as a superuser, then re-run. Never leave it privileged to "make something work". |
| Script: `the role does not exist` | Section 3 first. |
| Script: `objects still not owned by the application role` | The transaction rolled back; the message lists the objects. Usually an object another role created. Fix its owner by hand and re-run. |
| API: `permission denied for table ...` / `must be owner of ...` after the switch | Ownership was not transferred (or a migration ran as `postgres` since). Re-run section 4 with the API stopped. |
| API: `permission denied to create extension "vector"` | The extension is missing from the database. Create it as the superuser (section 1). |
| Lists are empty after the switch | A read outside `runInOrg`. Roll back (section 7) and report it. |
| Restore as `postgres` leaves the API unable to write | `--no-owner` made `postgres` the owner. Run section 4 against the restored database (`docs/runbooks/database-restore.md` section 4.5.1). |
| Doctor `db.rls_role` still `fail` | The API still signs in as a superuser. Check the container's `POSTGRES_USER` (`docker compose exec api printenv POSTGRES_USER`) and that the restart picked up the new `.env`. |

## Related

- `docs/runbooks/database-restore.md` — restoring, including handing a restored database to this role.
- `docs/runbooks/node-job-secrets.md` — the `CREATEROLE` capability and the `guided` answer on managed PostgreSQL.
- `docs/runbooks/database-baseline.md` — the baseline tooling, which runs as a superuser.
- `docs/deployment/vps.md` — the VPS layout and update flow.
