import { createScenarioKvoxAi, type FakeKvoxAi } from '@marinoscar/kvox-api/testing';

import { GRAPH_SCENARIO, type ScenarioRecording } from './graph-scenario.js';

// =============================================================================
// The language model of the bare host
// =============================================================================
//
// `createScenarioKvoxAi` from `@marinoscar/kvox-api/testing`: the package's
// scenario-driven fake. It READS THE REQUEST rather than replaying a fixed
// list — `kg_extraction` answers from the scenario meeting the prompt's title
// names, cited by the prompt's own line ids; adjudication compares labels; the
// digest cites one fact per statement; the Ask chat drives the two reference
// questions' tool loops from the conversation (the module header in the package
// says exactly how). The prompt-reading code lives in the package, never here
// (ADR-0001): a host supplies only its scenario data (`graph-scenario.ts`) and
// this wiring.
// =============================================================================

/** What {@link createBareHostAi} takes. */
export interface BareHostAiOptions {
  /** The text every note "is written" as. */
  noteText: string[];
  /** The recordings `kg_extraction` answers for; default the scenario. */
  recordings?: readonly ScenarioRecording[];
}

/**
 * The host's `KVOX_AI`.
 *
 * @param options - the note text and the scenario recordings.
 * @returns the fake; `calls` records every call, including the routed ones.
 */
export function createBareHostAi(options: BareHostAiOptions): FakeKvoxAi {
  return createScenarioKvoxAi({ noteText: options.noteText, meetings: options.recordings ?? GRAPH_SCENARIO });
}
