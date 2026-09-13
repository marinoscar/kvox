# Runbook: per-job database credentials for worker nodes

**Audience:** whoever operates this deployment's database and its worker node
fleet.
**Applies to:** the `postgres.readonly` credential kind minted by
`apps/api/src/db-backup/pg-job-role.broker.ts` (issue #350, epic #345).

A worker node has no database access of its own. When it is asked to run a job
whose handler declares a **secret broker** — today only `db.backup.run`, because
`pg_dump` needs a connection and no amount of presigning produces one — the API
mints a **short-lived, SELECT-only PostgreSQL login role** for that one job,
hands it over in exactly one HTTP response, and drops it again when the job
settles.

This runbook covers the three things an operator actually has to do: decide
whether to turn it on, find and remove grants that outlived their job, and
diagnose a deployment that cannot mint at all.

---

## 1. What is created, and what it can do

| | |
|---|---|
| Role name | `appjob_<first 8 of the job id>_<6 random hex>` |
| Privileges | `CONNECT` on the application database, `USAGE` on `public`, `SELECT` on its tables and sequences |
| Attributes | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 4` |
| Lifetime | `VALID UNTIL` = the job's lease expiry + 60 seconds |
| Password | 43 random `[A-Za-z0-9]` characters, returned once and never stored |

It can read. It cannot write, cannot create anything, cannot create databases or
roles, and cannot replicate. `pg_dump` needs nothing more than this: the archive
is taken with `--no-owner --no-acl`, so ownership and grants are not in it, and
a dump is a read.

**The password is never persisted.** `job_node_secrets` records the role NAME
(the handle), the job, the node, and the expiry — there is no column that could
hold credential material, in plaintext or encrypted. If a node loses it, it asks
again and the API rotates the password on the same role; the previous one stops
working at that moment.

---

## 2. Turning it on

Two independent switches, and both must be on:

1. **Capability** — this API's database role must hold `CREATEROLE`.
   Check it, without changing anything:

   ```
   GET /api/admin/db-backup/node-credential-preflight       (db_backup:read)
   ```

   `outcome: "ok"` means it can mint. `outcome: "guided"` means it cannot, and
   the response carries the SQL that fixes it — see §5. **A `guided` answer is a
   `200`, not an error.** Nothing is broken; node offload is simply off and the
   API takes its own backups, exactly as it did before this feature existed.

2. **Policy** — an administrator must set the `nodes.jobSecretBrokerEnabled`
   system setting to `true`. It ships **off**, and while it is off no node is
   even offered a job of a type that needs a credential (the type is withheld
   from the claim), so nothing fails and nothing is refused mid-run. The
   pre-flight above reports this as `brokerEnabled`.

### ⚠ The node also needs a network route to PostgreSQL

The credential names the host and port **this API** connects to. Whether a node
can reach that address is a fact about your network — for most deployments it
means the node has to sit inside the same private network as the database.

**There is deliberately no tunnelling.** Proxying database traffic through the
API would put the API in the data path for every byte of every dump, which is
exactly what the presigned-URL data plane exists to avoid. If your nodes cannot
reach the database, leave `nodes.jobSecretBrokerEnabled` off. That is a
supported configuration, not a degraded one.

---

## 3. Finding outstanding grants

Every role this broker creates carries the `appjob_` prefix, precisely so that
the cluster can be audited with no application state at all:

```sql
SELECT rolname,
       rolvaliduntil,
       rolvaliduntil < now() AS expired,
       rolconnlimit
FROM pg_roles
WHERE rolname LIKE 'appjob\_%'
ORDER BY rolvaliduntil;
```

In a healthy deployment this returns **nothing**, or one row per backup job
currently running on a node. A row whose `expired` is `true` is a role that no
longer works but has not been cleaned up.

The application's own view of the same grants:

```sql
SELECT id, job_id, node_id, kind, handle, expires_at, revoked_at
FROM job_node_secrets
WHERE revoked_at IS NULL
ORDER BY expires_at;
```

The two lists should agree. Where they do not:

| `pg_roles` | `job_node_secrets` | What it means |
|---|---|---|
| present | present, `revoked_at IS NULL` | Normal. A job is holding it. |
| absent | present, `revoked_at IS NULL` | The role was dropped by hand or by another process. The sweeper will mark the row on its next tick; harmless. |
| present | absent | **An orphan.** Nothing in the application can find it. Drop it by hand — §4. |
| present, expired | present | Revocation has not run (see §4). The credential is already worthless; the name is litter. |

---

## 4. Removing a grant by hand

Three revocation mechanisms exist and they are not redundant:

1. **The settle listener** — fires milliseconds after the job settles. Covers
   almost everything.
2. **The sweeper** — a cron that revokes grants whose job is no longer held.
   Covers the cases that emit no settle event at all: a job reaped after its
   executor died, an API replica that died between settling and revoking, a
   terminal write that failed. Gated by `NODE_SECRET_SWEEP_ENABLED`; only the
   literal `false` turns it off.
3. **`VALID UNTIL`** — enforced by PostgreSQL itself. This one cannot be
   switched off, cannot be missed by a dead process, and is why even total
   revocation failure leaves a credential that stops working on a clock.

**If the sweeper is disabled** (or a role is an orphan with no row), nothing will
remove the NAME. The role is already inert once its `VALID UNTIL` has passed,
but roles accumulate, so clear them:

```sql
-- 1. In the APPLICATION database. Without this the DROP below fails with
--    "role ... cannot be dropped because some objects depend on it": granted
--    privileges are dependencies, and this is the documented way to clear them.
DROP OWNED BY "appjob_1234abcd_a1b2c3";

-- 2. In any database (roles are cluster-wide).
DROP ROLE IF EXISTS "appjob_1234abcd_a1b2c3";
```

To disconnect a session the role currently holds *before* dropping it — `DROP
ROLE` does **not** disconnect an established session:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'appjob_1234abcd_a1b2c3';
```

To clear every expired grant at once, after confirming with the query in §3:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles
    WHERE rolname LIKE 'appjob\_%' AND rolvaliduntil < now()
  LOOP
    EXECUTE format('DROP OWNED BY %I', r.rolname);   -- run in the app database
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END $$;
```

⚠ **Only drop roles carrying the `appjob_` prefix.** That prefix is the whole
safety story: the application itself refuses to drop anything else, and so
should you.

---

## 5. When the API cannot `CREATEROLE`

This is the **ordinary** configuration on managed PostgreSQL — the provider owns
role management and does not hand it to application roles. It is not a fault,
and the pre-flight reports it as `guided` with a ready-to-paste block rather than
as an error.

Run **one** of these as a superuser (or your provider's administrative role),
substituting your application's database user:

```sql
-- Option A (simplest):
ALTER ROLE "appuser" CREATEROLE;

-- Option B (least privilege - a dedicated minter the app must SET ROLE into):
CREATE ROLE app_job_minter NOINHERIT CREATEROLE;
GRANT app_job_minter TO "appuser";
```

Then call the pre-flight again — it takes a fresh probe every time, so a grant
you just ran shows up immediately.

**If your platform will not grant `CREATEROLE` at all**, that is a real answer:
leave `nodes.jobSecretBrokerEnabled` off. Backups keep running on the API
process. Nothing fails, no job errors, and no node ever sees a job it cannot
execute — the type is withheld from the claim rather than offered and then
refused.

---

## 6. Diagnosing a refusal

| Symptom | Cause | Fix |
|---|---|---|
| `403`, `details.reason: "job_secret_broker_disabled"` | `nodes.jobSecretBrokerEnabled` is off | §2, switch 2 |
| `503`, `details.reason: "broker_unusable"` | The broker's `usable()` said no. `details.remedy` carries the SQL | §5 |
| `503` naming an unreachable maintenance database | The API cannot open a session on `postgres`/`template1` | Fix connectivity; the privilege could not even be checked |
| `404`, `details.reason: "no_broker_for_type"` | The job's type declares no broker | Run the job without a credential; this will not change on a retry |
| `500`, `details.reason: "grant_not_recorded"` | The role was minted but its handle could not be written down, so it was revoked again | Retry. If it persists, the job cannot run on a node here |
| Node connects, then fails part-way through a long dump | The lease expired and was not renewed, so the credential lapsed | Look at the node's lease renewal, not at the credential |

The API logs the role name, the job, the node and the expiry on every issue and
every revoke. **It never logs the password**, on any path or level — if you find
one in a log, that is a bug worth reporting.

---

## See also

- [`docs/specs/worker-nodes.md`](../specs/worker-nodes.md) — the fleet, the
  claim, the lease, and why a node holds no persisted credentials
- [`docs/specs/database-backup.md`](../specs/database-backup.md) — what a backup
  is and why it is not an ordinary queue job
- [`docs/deployment/worker-nodes.md`](../deployment/worker-nodes.md) — running a
  node
- [`docs/runbooks/postgres-client-version.md`](postgres-client-version.md) — a
  `pg_dump` client/server version mismatch
