// `--predictions gold`: predictions synthesised from the labels themselves.
// The harness's self-test — scoring it must print 1.000 everywhere, so any
// other number is a bug in the scorer or an inconsistent fixture, never in a
// model. Resolutions come from `existingId` (a prechecked link) so auto-link
// precision is exercised too.

import type { GoldenFixture } from './fixture-schema';
import type { KgEvalPrediction, PredictedEvidence } from './prediction-schema';

const toPredicted = (ev: GoldenFixture['labels']['entities'][number]['evidence']): PredictedEvidence[] =>
  ev.map((e) => ({ source: e.source, segmentId: e.source === 'segment' ? e.segmentId : null, quote: e.quote }));

export function goldPrediction(fixture: GoldenFixture): KgEvalPrediction {
  return {
    fixtureId: fixture.id,
    model: null,
    entities: fixture.labels.entities.map((e) => ({
      ref: e.key,
      type: e.type,
      label: e.label,
      aliases: [...e.aliases],
      resolution: e.existingId
        ? { outcome: 'linked', entityId: e.existingId, score: 1, prechecked: true }
        : { outcome: 'new', entityId: null, score: null, prechecked: false },
      evidence: toPredicted(e.evidence),
    })),
    relations: fixture.labels.relations.map((r) => ({
      type: r.type,
      from: r.from,
      to: r.to,
      validFrom: r.validFrom,
      validTo: r.validTo,
      precision: r.precision,
      evidence: toPredicted(r.evidence),
    })),
    items: fixture.labels.items.map((i) => ({
      kind: i.kind,
      subject: i.subject,
      owner: i.owner,
      counterparty: i.counterparty,
      title: i.title,
      statement: i.statement,
      occurredAt: i.occurredAt,
      dueAt: i.dueAt,
      sensitivity: i.sensitivity,
      evidence: toPredicted(i.evidence),
    })),
    stats: { uncited: 0, invalid: 0 },
  };
}
