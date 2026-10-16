# Job contracts

`note-source-extract.contract.ts` is the result shape a worker node posts back for the `note.source.extract` job
type. It lives with the module that owns the job type (issue #460), so the
packaged queue (`@marinoscar/platform-api/jobs`) imports no domain code. The job `type`
string is permanent and did not change.

The trust-boundary rationale (why the schema is a contract, what a schema must
stay representable as) is in [`docs/specs/worker-nodes.md`](../../../../docs/specs/worker-nodes.md)
(section 22, the result contract crosses the boundary as data).
