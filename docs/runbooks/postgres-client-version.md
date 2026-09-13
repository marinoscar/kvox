# Runbook: Diagnose and Fix a PostgreSQL Client/Server Version Mismatch

This runbook covers one failure: the `pg_dump` / `pg_restore` binaries inside
the API image are older than the PostgreSQL server they have to work with, so
database backups cannot run. It tells you how to confirm that is what you are
looking at, and how to bump the two places the client major is written down —
which must move together.

Source of truth for every claim below:

- `apps/api/Dockerfile` — the `postgresql<N>-client` package installed in the
  `base` stage.
- `apps/api/src/db-backup/pg-version.util.ts` — `MIN_PG_CLIENT_MAJOR`, the
  version parsers, and the block/warn decision.
- `apps/api/test/pg-client-version.spec.ts` — the test that fails when those
  two disagree.
- `apps/api/src/db-backup/pg-dump.util.ts` — how the client is invoked, and how
  the connection is derived from the `POSTGRES_*` environment.
- `infra/compose/base.compose.yml` — note what is *not* there: no `db` service.

**This deployment's PostgreSQL server is external.** The compose stack runs the
API, the web app and Nginx; the database is yours, or your cloud provider's.
That is the whole reason this runbook exists: the client ships in an image this
repository builds, the server is upgraded by someone else on their own
schedule, and nothing forces the two to move together.

---

## 1. The failure, and why it is silent

`pg_dump` refuses to dump a server whose major version is newer than its own.
It is not a warning and not a degraded mode — every invocation fails, exits
non-zero, and writes nothing.

The dangerous part is the timing. Nothing fails at the moment the server is
upgraded: the application keeps serving traffic, Prisma keeps working (the
wire protocol is compatible), migrations keep applying. Only the backups stop,
and they stop *quietly*, on a schedule, at an hour nobody is watching. The
first person to notice is usually the person who needed a restore.

The reverse direction is fine and fully supported: a **newer** client dumping
an **older** server is normal and is what you will be running for most of the
life of a deployment.

## 2. Confirming the diagnosis

### 2.1 Ask the two sides directly

The client, from inside the running API container:

```bash
docker compose exec api pg_dump --version
```

The server, from anywhere that can reach it (`psql`, any SQL console, or the
API's own database credentials):

```sql
SHOW server_version_num;   -- e.g. 180001  → major 18
```

`server_version_num` packs the major as `major * 10000 + minor`, so integer
division by 10000 is the major: `180001` is 18, `170004` is 17.

**If the client major is lower than the server major, that is the failure.**

### 2.2 What the application already told you

The backup checks this pair before it starts a dump, so a blocked run records a
message naming both versions and the package to install (see
`checkPgClientVersion`). Three outcomes are possible, and they are deliberately
asymmetric:

| Situation | What happens |
| --- | --- |
| client major **<** server major | **Blocked.** No dump is attempted; the run records why. |
| client major **>=** server major | Proceeds. |
| either version unreadable | **Proceeds anyway**, with a warning logged. |

That last row is intentional: an unparseable version banner or a failed probe
query is not evidence that the backup would fail, and it must never be the
reason a backup did not happen. If you see the warning, treat it as "check this
by hand" — not as a broken backup.

## 3. The fix: bump both places, together

The client major is written in **two** files, and they are held equal by a
test. Change one without the other and `npm test --workspace=api` fails with
both numbers printed side by side.

1. **`apps/api/Dockerfile`**, in the `base` stage:

   ```dockerfile
   RUN apk add --no-cache openssl postgresql18-client
   ```

2. **`apps/api/src/db-backup/pg-version.util.ts`**:

   ```ts
   export const MIN_PG_CLIENT_MAJOR = 18;
   ```

Then rebuild and redeploy the API image:

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml build api
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d api
```

Confirm the new client is what is actually running — a rebuild that silently
reused a cached layer is the commonest way this "fix" fails to take:

```bash
docker compose exec api pg_dump --version
```

### 3.1 Prove the pair works, rather than waiting for the schedule

Run the same dump the application would, straight from the container, and throw
the archive away:

```bash
docker compose exec api sh -c '\
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --no-password -Fc --no-owner --no-acl -Z 6 > /dev/null'
```

The password goes through `PGPASSWORD` here for the same reason the application
never puts it in an argument: argv is world-readable through `ps` and
`/proc/<pid>/cmdline`. An exit code of 0 means the version pair is fixed.

### 3.2 Choose a client that is equal to or newer than the server

Pick the major that matches the server you are running, or a newer one. There
is no advantage to being conservative here: a newer client dumps older servers
correctly, so pinning the client to the newest major your base image offers is
the configuration that needs attention least often.

### 3.3 If the Alpine release has no package for that major

`apk add postgresql18-client` fails when the Alpine release underneath
`node:24-alpine` does not carry that major yet. Options, in order of
preference:

1. Wait for the base image to move to an Alpine release that has it, if the
   server upgrade is still ahead of you.
2. Move the base image to a newer Node Alpine tag that carries it.
3. Add the package from a newer Alpine repository branch — a real option, but
   one that mixes package sets in the image and needs its own review; do not do
   it casually.

Do **not** work around it by switching to the unpinned `postgresql-client`
meta-package. See the next section.

## 4. Why the major is pinned explicitly

`postgresql-client` (no number) is a meta-package that tracks whatever major
the Alpine release currently ships. It looks tidier and it is exactly the
failure mode this feature is guarding against: a routine base-image refresh —
a CVE bump, a Node patch release — would move the PostgreSQL client version
without a single line of this repository changing, in a pull request nobody
would review as a database change.

`apps/api/test/pg-client-version.spec.ts` therefore asserts three things about
the Dockerfile: that exactly one explicitly-numbered client package is
installed, that it is installed in the `base` stage (so development and
production both have it), and that the floating meta-package is not used
anywhere.

## 5. What this runbook does not cover

- **A restore that fails part way through.** That is a different failure with a
  different guard (`--exit-on-error`, in
  `apps/api/src/db-backup/pg-restore.util.ts`).
- **Dumping a server much older than the client** — supported, and not a
  version problem.
- **Extension or locale mismatches between two servers.** A dump taken from one
  server and restored onto another can fail for reasons that have nothing to do
  with client versions; the error text will name the extension or collation
  rather than a version.

## 6. Summary checklist

- [ ] Client major read from the running container (`pg_dump --version`), not
      assumed from the Dockerfile
- [ ] Server major read from the server (`SHOW server_version_num`), not
      assumed from the provider's console
- [ ] Confirmed the client major is genuinely **lower** than the server major
- [ ] `postgresql<N>-client` bumped in `apps/api/Dockerfile` (`base` stage)
- [ ] `MIN_PG_CLIENT_MAJOR` bumped in
      `apps/api/src/db-backup/pg-version.util.ts` to the same number
- [ ] `npm test --workspace=api` passes (the two are compared by a test)
- [ ] Image rebuilt **and** redeployed, then `pg_dump --version` re-checked
      inside the running container
- [ ] A dump run by hand from inside the container (section 3.1) exits 0,
      rather than waiting for the next scheduled backup to prove it
