// =============================================================================
// What a name check will cost, before it runs (issues #328 and #330)
// =============================================================================
//
// Thorough mode reads the whole transcript through the model — for a two-hour
// recording that is tens of thousands of input tokens on the USER'S OWN
// account, so the UI shows the number before the button is pressed.
//
// PURE, and built from the SAME functions the job calls (`findCandidates`,
// `packDiscoveryChunks`, `buildAdjudicationPrompt`), so the estimate is the
// job's own prompt text counted by the job's own tokenizer — not a formula
// that agrees with it today.
//
// ⚠ A LOWER BOUND FOR THOROUGH MODE. Discovery's own findings are adjudicated
// too, and how many there will be is exactly what discovery is for finding
// out. The estimate counts the discovery pass plus adjudicating the phonetic
// candidates; output tokens are not counted at all.
// =============================================================================

import { findCandidates, type CandidateSegment, type NameTarget } from './candidates';
import {
  batch,
  buildAdjudicationPrompt,
  buildDiscoveryPrompt,
  capCandidates,
  DISCOVERY_CHUNK_TOKENS,
  packDiscoveryChunks,
  type CountTokens,
  type NameCheckPrompt,
  type SourcedCandidate,
} from './prompts';

export interface NameCheckEstimate {
  /** Input tokens across every request, as the active provider counts them. */
  inputTokens: number;
  /** Provider requests, not counting retries. */
  requests: number;
  /** Phonetic candidates that would be adjudicated (after the cap). */
  candidates: number;
}

export interface EstimateInput {
  mode: 'standard' | 'thorough';
  segments: readonly CandidateSegment[];
  speakerNames: ReadonlyMap<string, string>;
  segmentIndex: ReadonlyMap<string, number>;
  targets: readonly NameTarget[];
  countTokens: CountTokens;
  chunkTokens?: number;
}

export function promptTokens(prompt: NameCheckPrompt, countTokens: CountTokens): number {
  return countTokens(`${prompt.systemPrompt}\n${prompt.userContent}`);
}

/** Stage 1 as the job runs it, tagged with its source. */
export function phoneticCandidates(
  segments: readonly CandidateSegment[],
  targets: readonly NameTarget[],
): SourcedCandidate[] {
  return findCandidates([...segments], [...targets]).candidates.map((c) => ({ ...c, source: 'phonetic' }));
}

export function estimateNameCheck(input: EstimateInput): NameCheckEstimate {
  let inputTokens = 0;
  let requests = 0;

  if (input.mode === 'thorough') {
    const chunks = packDiscoveryChunks(
      input.segments,
      input.speakerNames,
      input.countTokens,
      input.chunkTokens ?? DISCOVERY_CHUNK_TOKENS,
    );
    for (const chunk of chunks) {
      inputTokens += promptTokens(buildDiscoveryPrompt(chunk, input.targets), input.countTokens);
      requests += 1;
    }
  }

  const { candidates } = capCandidates(phoneticCandidates(input.segments, input.targets));
  for (const group of batch(candidates)) {
    const { prompt } = buildAdjudicationPrompt(group, input.segments, input.segmentIndex, input.speakerNames);
    inputTokens += promptTokens(prompt, input.countTokens);
    requests += 1;
  }

  return { inputTokens, requests, candidates: candidates.length };
}
