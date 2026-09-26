// The §6 quality bar (docs/specs/ontology.md). Gates on relaxing §7's
// resolution thresholds — NOT gates on shipping; CI reports, `--enforce` fails.
export const KG_EVAL_TARGETS = {
  autoLinkPrecision: 0.95,
  commitmentRecall: 0.85,
  entityCoverage: 0.9,
} as const;

export type KgEvalTargetKey = keyof typeof KG_EVAL_TARGETS;
