---
"@marinoscar/kvox-api": minor
---

`GraphRdfModule.forRoot({ shacl: { run } })`: a host whose binary cannot run Node as a child (KVox Desktop: Electron with the RunAsNode fuse off) runs the import's SHACL validation in an isolated process of its own. `run(input, { signal })` receives the JSON the default child reads on stdin and resolves with the report JSON; the import's timeout still applies. The new light entry `@marinoscar/kvox-api/graph-rdf/shacl-runner` exports `runShaclValidation(input): Promise<string>` (Node built-ins only, no Nest) for that process; it and the default child run one script, `runners/shacl-runner.cjs`, so the inline `-e` module is gone. Without `shacl.run` nothing changes (#586).
