import type { NormalizedTranscript } from '@marinoscar/kvox-api/transcription';
import type {
  KvoxScenarioCommitment,
  KvoxScenarioMeeting,
  KvoxScenarioPerson,
  KvoxScenarioRelation,
} from '@marinoscar/kvox-api/testing';

// =============================================================================
// The synthetic world the graph and Ask legs run on
// =============================================================================
//
// Two recordings, each with what a meeting "said" (the fake transcription
// provider's script) and what a model would extract from it (the fake model's
// structured answer for `kg_extraction`: `createScenarioKvoxAi` of
// `@marinoscar/kvox-api/testing`, wired in `fake-ai.ts`). Nothing here is
// written to the database directly: a test uploads the recordings, generates a
// note from each, asks for the extraction over HTTP and commits the proposal,
// so every entity, relation and commitment enters the graph through the real
// write path (`ProposalCommitService` -> `GraphWriteService`) with real
// evidence rows, and the deferred `kg_assert_has_evidence` trigger runs.
//
//   "Weekly sync with Maren Fixture"   Maren Fixture, Jarek Stubbs, Jonty Mockwell attend.
//                                    Jarek Stubbs REPORTS_TO Maren Fixture.
//                                    Jonty owns one OPEN commitment (the budget
//                                    draft, owed to Maren) and one DONE one
//                                    (the vendor review) that an "open action
//                                    items" answer must leave out.
//   "Jonty and Jarek standup"          Jonty and Jarek only: a meeting Maren did
//                                    NOT attend, which "meetings with Jarek's
//                                    boss" must leave out.
//
// NO MEETING SAYS WHO JONTY REPORTS TO. The Ask leg sets it by hand on Jonty's
// entity page (`POST /api/graph/entities/:id/relations`, #586) and asks
// `ASK_QUESTIONS.manualBossMeetings`: the answer follows the manual
// REPORTS_TO, cited "Set by hand".
//
// THE MEETING ITSELF IS NEVER IN THE ANSWER: `kg.extract` adds the Meeting row
// (one per transcript, named after its title) deterministically. The ATTENDED
// rows are the model's here, because the speakers are not named (naming one
// would run `kg.speaker_link`, a second write path this scenario does not need).
//
// A PERSON THE GRAPH ALREADY HOLDS is answered with the `k#` the prompt's
// "Known entities" list gives it (the prompt's own rule 3), so the second
// recording links to the first one's people instead of proposing duplicates.
// When the list does not carry one, the fake proposes a new `e#` and the
// resolution stage's adjudication call (answered `same` for an equal label)
// links it.
// =============================================================================

/** A person a recording mentions (the package's scenario type). */
export type ScenarioPerson = KvoxScenarioPerson;

/** A relation between two of a recording's people. */
export type ScenarioRelation = KvoxScenarioRelation;

/** A commitment a person owns. */
export type ScenarioCommitment = KvoxScenarioCommitment;

/** One recording of the scenario: what the scenario model extracts, plus what the fake speech provider hears. */
export interface ScenarioRecording extends KvoxScenarioMeeting {
  /** What the fake transcription provider hears. */
  transcript: Omit<NormalizedTranscript, 'provider'>;
}

function segments(lines: Array<[label: string, text: string]>): NormalizedTranscript['segments'] {
  return lines.map(([speakerLabel, text], index) => ({
    speakerLabel,
    startMs: index * 4000,
    endMs: index * 4000 + 3500,
    text,
    confidence: 0.97,
    words: [],
  }));
}

/** The meeting the boss attended. */
export const WEEKLY_SYNC: ScenarioRecording = {
  title: 'Weekly sync with Maren Fixture',
  transcript: {
    language: 'en',
    durationMs: 16_000,
    speakers: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    segments: segments([
      ['A', "Hi all, I'm Maren Fixture. Jarek Stubbs reports to me on the platform team."],
      ['B', 'Thanks Maren. Jonty Mockwell, can you send the budget draft by Friday?'],
      ['C', 'Yes, I will send the budget draft to Maren by Friday.'],
      ['C', 'I also finished the vendor review last week.'],
    ]),
  },
  people: [
    { label: 'Maren Fixture', quote: "I'm Maren Fixture", attended: true },
    { label: 'Jarek Stubbs', quote: 'Jarek Stubbs reports to me', attended: true },
    { label: 'Jonty Mockwell', quote: 'Jonty Mockwell, can you send the budget draft', attended: true },
  ],
  relations: [{ type: 'REPORTS_TO', from: 'Jarek Stubbs', to: 'Maren Fixture', quote: 'Jarek Stubbs reports to me on the platform team.' }],
  commitments: [
    {
      owner: 'Jonty Mockwell',
      counterparty: 'Maren Fixture',
      title: 'Send the budget draft',
      statement: 'Jonty Mockwell will send the budget draft to Maren Fixture by Friday.',
      status: 'open',
      quote: 'I will send the budget draft to Maren by Friday.',
    },
    {
      owner: 'Jonty Mockwell',
      counterparty: null,
      title: 'Finish the vendor review',
      statement: 'Jonty Mockwell finished the vendor review.',
      status: 'done',
      quote: 'I also finished the vendor review last week.',
    },
  ],
};

/** A meeting without the boss. */
export const STANDUP: ScenarioRecording = {
  title: 'Jonty and Jarek standup',
  transcript: {
    language: 'en',
    durationMs: 8000,
    speakers: [{ label: 'A' }, { label: 'B' }],
    segments: segments([
      ['A', 'Morning Jarek, this is Jonty Mockwell with the standup.'],
      ['B', 'Morning Jonty, Jarek Stubbs here. The release notes are ready.'],
    ]),
  },
  people: [
    { label: 'Jonty Mockwell', quote: 'this is Jonty Mockwell', attended: true },
    { label: 'Jarek Stubbs', quote: 'Jarek Stubbs here', attended: true },
  ],
  relations: [],
  commitments: [],
};

/** Every recording, in the order a test commits them (the standup links to the sync's people). */
export const GRAPH_SCENARIO: readonly ScenarioRecording[] = [WEEKLY_SYNC, STANDUP];

/** The two reference questions of the Ask leg. */
export const ASK_QUESTIONS = {
  actionItems: 'What are the action items from Jonty?',
  bossMeetings: "What meetings have we had with Jarek's boss?",
  /** Answerable only once Jonty's manager is set by hand (#586): no meeting states it. */
  manualBossMeetings: "What meetings have we had with Jonty's boss?",
} as const;
