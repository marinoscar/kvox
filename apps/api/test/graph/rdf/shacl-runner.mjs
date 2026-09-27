// =============================================================================
// SHACL validation in a child `node` process (#385/#386 specs)
// =============================================================================
//
// `rdf-validate-shacl` and `rdf-ext` are ESM-only. Loading them from the
// CommonJS Jest suite needs a dynamic `import()` inside Jest's `vm` context,
// which only works when Node was started with `--experimental-vm-modules` AND
// the import binds to the right test environment — a combination that held or
// failed depending on which worker first loaded the helper. A plain Node
// process has neither problem: this file is native ESM, run with
// `process.execPath`, so validation is deterministic under any Jest launcher.
//
// Protocol: stdin is JSON `{ "shapes": <N-Quads>, "data": <N-Quads> }`; stdout
// is JSON `{ conforms, results: [{ focusNode, path, sourceConstraintComponent,
// message }] }`, each term as `{ value }` or null, `message` as `[{ value }]` —
// the same shape the specs read off rdf-validate-shacl's own report.
// =============================================================================

import SHACLValidator from 'rdf-validate-shacl';
import rdf from 'rdf-ext';
import { Parser } from 'n3';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const dataset = (nquads) => rdf.dataset(new Parser({ format: 'N-Quads' }).parse(nquads));
const term = (t) => (t ? { value: t.value } : null);

const report = await new SHACLValidator(dataset(input.shapes)).validate(dataset(input.data));
process.stdout.write(
  JSON.stringify({
    conforms: report.conforms,
    results: report.results.map((r) => ({
      focusNode: term(r.focusNode),
      path: term(r.path),
      sourceConstraintComponent: term(r.sourceConstraintComponent),
      message: (r.message ?? []).map((m) => ({ value: m.value })),
    })),
  }),
);
