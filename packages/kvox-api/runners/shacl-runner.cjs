'use strict';

// =============================================================================
// One SHACL validation of a `kg.import` upload (#387, docs/specs/ontology.md §18.3, §18.4)
// =============================================================================
//
// THE ONE IMPLEMENTATION of the validation step, in plain CommonJS so it loads, unbuilt and
// untranspiled, everywhere it runs:
//
//   - as the CHILD `node` process of the default engine (`ChildProcessShaclEngine` in
//     `src/graph-rdf/import/shacl-engine.ts` runs this file as its main module: JSON on
//     stdin, the report JSON on stdout);
//   - in-process, through `runShaclValidation` of `@marinoscar/kvox-api/graph-rdf/shacl-runner`,
//     which a host calls from an isolated process of its own choosing (KVox Desktop, whose
//     Electron binary cannot run Node as a child, calls it from a utility process and hands the
//     engine the call as `GraphRdfModule.forRoot({ shacl: { run } })`).
//
// `rdf-validate-shacl` is ESM-only, so it is loaded with a dynamic `import()` of the `file:` URL
// the engine resolved (`moduleUrl`): the engine's process can always find it, the runner's may
// not.
//
// Protocol: input is JSON `{ moduleUrl, shapes, data, maxResults }`, each quad `[s, p, o]` with
// terms `{ t: 'N'|'B'|'L', v, d?, l? }`; output is JSON
// `{ conforms, violationCount, warningCount, results }`, `results` capped at `maxResults`,
// violations first. `conforms` means "no `sh:Violation`": warnings never fail an import.
//
// Node built-ins only; no Nest, no Prisma, nothing from the rest of the package.
// =============================================================================

/** Messages for the constraint components that carry no `sh:message` of their own. */
const COMPONENT_MESSAGES = {
  ClassConstraintComponent: 'The value is not a node of an allowed type',
  ClosedConstraintComponent: 'The property is not allowed on this node',
  NodeKindConstraintComponent: 'The value is not the right kind of node',
  OrConstraintComponent: 'The value satisfies none of the allowed alternatives',
  DatatypeConstraintComponent: 'The value does not have the required datatype',
};

/**
 * Runs one validation.
 *
 * @param {string} input The protocol's input JSON.
 * @returns {Promise<string>} The report JSON.
 */
async function runShaclValidation(input) {
  const request = JSON.parse(input);
  const { default: SHACLValidator } = await import(request.moduleUrl);
  const f = new SHACLValidator([]).factory;
  const term = (t) => (t.t === 'N' ? f.namedNode(t.v) : t.t === 'B' ? f.blankNode(t.v) : f.literal(t.v, t.l ? t.l : f.namedNode(t.d)));
  const quads = (rows) => rows.map(([s, p, o]) => f.quad(term(s), f.namedNode(p), term(o)));
  const validator = new SHACLValidator(quads(request.shapes), { factory: f });
  const report = await validator.validate(f.dataset(quads(request.data)));

  const name = (t) => (t ? (t.termType === 'BlankNode' ? '_:' + t.value : t.value) : null);
  const local = (t) => (t ? String(t.value).split(/[#/]/).pop() : null);
  const all = report.results.map((r) => ({
    focusNode: name(r.focusNode) ?? '',
    path: name(r.path),
    message:
      (r.message ?? []).map((m) => m.value).join(' ') ||
      COMPONENT_MESSAGES[local(r.sourceConstraintComponent)] ||
      local(r.sourceConstraintComponent) ||
      'Constraint not satisfied',
    severity: local(r.severity) ?? 'Violation',
  }));
  const violations = all.filter((r) => r.severity === 'Violation');
  const others = all.filter((r) => r.severity !== 'Violation');
  return JSON.stringify({
    conforms: violations.length === 0,
    violationCount: violations.length,
    warningCount: others.filter((r) => r.severity === 'Warning').length,
    results: [...violations, ...others].slice(0, request.maxResults),
  });
}

module.exports = { runShaclValidation };

// Run as a child process: stdin in, stdout out. A failure exits non-zero with the reason on
// stderr (engine internals, never the file's content).
if (require.main === module) {
  (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(await runShaclValidation(Buffer.concat(chunks).toString('utf8')));
  })().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}
