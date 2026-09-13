# Job contracts

The result shapes a **worker node** may post back, one file per node-eligible
job type (epic #254, issue #269).

A node computes off-machine and POSTs a result to
`POST /api/nodes/{id}/jobs/{jobId}/result`. The server validates that body
against the handler's `nodeResultSchema` before `persistNodeResult` writes
anything — so these schemas are a **trust boundary**, not a convenience. They
are the only thing standing between an arbitrary remote body and a write.

## Why the schemas live here and not in the handler file

Two readers need them and only one of them is the handler:

1. The handler, which exposes one as `nodeResultSchema` (that is what makes
   its type node-eligible — see `../job-handler.interface.ts`).
2. **Clients**, through `GET /api/nodes/job-types`, which converts each one
   with `z.toJSONSchema()` and publishes it. That is how `appctl` validates a
   result *before* posting it, against the server's own definition rather than
   against a copy it carries.

A directory keeps "the contract" separable from "the code that runs the work",
which matters because the second reader is a different program on a different
machine, quite possibly on a different release.

## Why NOT a shared `packages/job-contracts` workspace

This is the obvious alternative — publish the Zod schemas as a fourth
workspace package and have the API, the CLI and the web app all import the same
TypeScript. It is wrong for this repository, and the reasons are already
written down in [`packages/shared/index.js`](../../../../../packages/shared/index.js),
which is the one package that *did* have to solve this problem:

* `apps/api` compiles with `tsc -p tsconfig.build.json` under `rootDir: ./src`.
  Importing TypeScript **source** from outside that root widens it, and tsc
  then emits `dist/src/main.js` — which no longer matches `start:prod`'s
  `node dist/main`. The build stays green and the container breaks.
* `apps/api`'s Jest config has no `moduleNameMapper` and the default
  `transformIgnorePatterns` (`/node_modules/`). A workspace symlink resolving
  to `.ts` would not be transformed, and every API suite would die at import
  time.
* CI (`.github/workflows/ci.yml`) runs `npm ci` and goes straight to typecheck.
  Nothing builds a fourth workspace first, so a package that needed compiling
  would have to add a step to several separate jobs.

`packages/shared` sidesteps all of that by shipping committed `.js` plus a
hand-written `.d.ts` — which works for a string constant and does **not** work
for a Zod schema, whose whole value is the runtime object.

So the contract crosses the boundary the way contracts between separately
deployed programs normally do: **as data, over HTTP**. `z.toJSONSchema()` on
this directory's schemas, served by `GET /api/nodes/job-types`, gives a client
the server's live definition with no build step, no shared package, and no
possibility of a client validating against a schema the server stopped using
two releases ago.

## Adding one

1. Export the schema (and its inferred type) from a new file here.
2. Set it as `nodeResultSchema` on the handler, alongside `persistNodeResult`.
   Both members or neither — see `../job-handler.interface.ts`.
3. There is no step 3. `GET /api/nodes/job-types` derives its whole answer
   from the registry, so the new type appears there with no list to edit.

Keep a schema **JSON-Schema representable**: plain objects, strings, numbers,
booleans, arrays and enums. `z.date()`, `z.bigint()`, `z.custom()` and
transforms either cannot be expressed as JSON Schema or lose their meaning on
the way out — and the value arrives as JSON anyway, so a shape JSON cannot
carry was never going to survive the trip.

**A count backed by a `BigInt` column is a decimal string, not a number.**
`z.bigint()` is off the table for the reason above, and a plain `z.number()`
is exact only below 2^53 — a JSON number silently rounds above it, which lands
the corruption on exactly the largest results a fork is likely to care about
(a multi-gigabyte dump, an export). `db-backup-run.contract.ts`'s `bytes:
z.string().regex(/^\d{1,20}$/)`, converted with `BigInt()` once in the
handler, is the worked example — see its file header for the full argument,
and contrast `example-checksum.contract.ts`'s plain `number`, which is correct
there because that count is bounded by `Number.MAX_SAFE_INTEGER` and lands in
a JSONB column rather than a `BigInt` one.
