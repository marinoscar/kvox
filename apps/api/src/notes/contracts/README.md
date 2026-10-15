# Job contracts

`note-source-extract.contract.ts` is the result shape a worker node posts back for the `note.source.extract` job
type. It lives with the module that owns the job type, not in `jobs/contracts/`
(issue #460), so the base `jobs/` folder imports no domain code. The job `type`
string is permanent and did not change.

The trust-boundary rationale (why the schema is a contract, why it is not a
shared package, what a schema must stay representable as) is in
[`../../jobs/contracts/README.md`](../../jobs/contracts/README.md).
