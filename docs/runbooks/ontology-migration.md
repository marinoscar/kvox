# Runbook: ontology migrations (`kg.migrate`)

**Audience:** whoever changes the ontology definition, and whoever operates the
deployment that ships the change.
**Applies to:** `packages/shared/src/ontology/migrations.ts` and the
`kg.migrate` job (`apps/api/src/graph/migrate/`, issue #384). Design:
[`docs/specs/ontology.md`](../specs/ontology.md) §11 and §17.4.

The knowledge graph tables never change shape when the ontology does — `props`
is JSONB and `type` is a plain string. So when a release **renames an attribute,
retags a deprecated type, corrects an attribute's kind or retires a status**,
the rows already stored under the old shape are reshaped by a **job**, per user
and per row, never by a Prisma migration. This runbook covers the three things
that involves: writing the migration, watching it run, and re-running it for
one user.

A release that only **adds** types or attributes (a minor bump) or only edits
descriptions (a patch bump) needs no migration at all. `ONTOLOGY_MIGRATIONS`
ships empty for exactly that reason.

---

## 1. Authoring a migration

Every step below goes in the same pull request.

1. **Deprecate, never delete.** Mark the old key `deprecated: { since, reason }`
   in its domain module. Keys are permanent (§17.1) — the parity test's rule 4
   fails if a shipped key disappears.
2. **Declare the replacement** (a new type, attribute or status) and append any
   new key to `SHIPPED_KEYS`.
3. **Bump `ONTOLOGY_VERSION`** and append a `CHANGELOG` entry with today's
   date. A retag of a type or relation changes what existing rows *mean*, so it
   must be a **major** version (`X.0.0`) — parity rule 16.
4. **Append the migration** to `ONTOLOGY_MIGRATIONS`, its `to` equal to that
   CHANGELOG version:

   ```ts
   {
     to: '2.0.0',
     description: 'Workstream is retired in favour of Project',
     steps: [
       { op: 'retag_entity_type', from: 'Workstream', to: 'Project' },
       { op: 'rename_attribute', typeKey: 'Project', from: 'kickoff', to: 'startDate' },
     ],
   }
   ```

   The step vocabulary (spec §17.4):

   | Step | Does | Parity requires |
   |---|---|---|
   | `retag_entity_type { from, to }` | changes `kg_entities.type` | `from` deprecated, `to` a live entity type, major bump |
   | `retag_relation_type { from, to }` | changes `kg_relations.type` | same, for relations |
   | `rename_attribute { typeKey, from, to }` | moves a built-in attribute's value; an existing `to` value wins and the `from` value is dropped | `from` deprecated, `to` declared on the type |
   | `coerce_attribute { typeKey, key, to, map? }` | converts a value to the attribute's new kind; with a `map`, unmapped values are dropped | the attribute's declared kind is `to`; every map target is a declared choice |
   | `drop_attribute { typeKey, key }` | removes a retired attribute | `key` deprecated |
   | `retag_item_status { itemKind, from, to }` | changes `kg_items.status` | `to` is one of the item type's statuses |

   No step may name a user attribute (`u_*`, rule 17): those are keyed by their
   definition id and are never renamed.
5. **Rebuild** the compiled output and commit it with the source:

   ```bash
   npm run build:ontology --workspace=@app/shared
   ```

6. **Run the parity test** (`apps/api/test/ontology/ontology-parity.spec.ts`).
   Rules 14–17 check the migration against the CHANGELOG, the registry and
   `SHIPPED_KEYS`; every failure message names the migration, the step and the
   rule.

Every op is idempotent (applying it to its own output changes nothing), and
`apps/api/test/ontology/migrations.spec.ts` asserts that per op — keep it true
for any new op.

---

## 2. What happens after the deploy

Nothing needs to be run by hand.

- Every hour, at minute 17, each API process's scheduler looks for owners who
  still have a row that a declared migration touches, and queues one
  `kg.migrate` job per owner (at most 200 owners per tick; a larger backlog
  drains over the following hours). The scheduler only queues — the work runs
  on a worker slot like any other job.
- The job walks that owner's entities, then relations, then items, in batches of
  500. A row is reshaped, validated against the ontology (every domain, plus the
  owner's own attribute definitions), and written together with its new
  `ontology_version`. Rows no step touches keep their version: it records what
  the row was written against.
- Draft proposals created before a **major** migration get the
  `stale_ontology` flag on each item, so the review panel can say the draft was
  made with an older ontology. Committing still validates against the current
  one.
- No AI provider is called and no user's key is spent.

To turn the hourly tick off on a process (for instance to leave scheduling to
one replica), set `KG_MIGRATE_SCHEDULE_ENABLED` to `false` in its environment.
Anything else, including unset, leaves it on. Turning it off everywhere stops
new jobs being queued; it does not stop jobs already queued.

---

## 3. Watching it

Open **Console → Settings → Jobs** (`/admin/settings/jobs`) and filter by the
type **Knowledge graph migration** (`kg.migrate`). Each row is one owner (its
subject is `user` + the owner id).

When a job finishes it logs one line with numbers only:

```
kg.migrate job <id>: {"ownerId":"…","targetVersion":"2.0.0","scanned":1200,
"changed":1180,"needsAttention":3,"droppedValues":7,"staleDraftItems":12,"ms":840}
```

- **`needsAttention`** — rows whose reshaped props would not validate. They are
  left exactly as they were, and their ids (never their contents) are logged at
  `warn`. Common causes: a user attribute defined on a type that was retagged
  away (the attribute still belongs to the old type), or a value the new kind
  cannot hold. Such rows remain candidates, so the owner is queued again every
  hour until the row is fixed — by editing it on its entity page, or by a
  follow-up migration.
- **`droppedValues`** — values a step deliberately discarded (an unmapped
  `coerce_attribute` value, a dropped attribute, a rename whose target was
  already set). Expected, and counted so it is never silent.

A job that fails (a database error) retries up to three times; everything it
committed before failing stays committed, and the retry picks up only the rows
still pending.

---

## 4. Re-running for one user

Find that owner's most recent `kg.migrate` row in `/admin/settings/jobs` and
press **Retry**. The job is idempotent: it re-selects only rows still below a
migration target and cannot apply a step twice. Retrying a job whose owner has
nothing left to migrate is harmless — it finishes with `changed: 0`.
