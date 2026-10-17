import type { NormalizedTranscript } from '@marinoscar/kvox-api/transcription';

// =============================================================================
// The synthetic world the graph and Ask legs run on
// =============================================================================
//
// Two recordings, each with what a meeting "said" (the fake transcription
// provider's script) and what a model would extract from it (the fake model's
// structured answer for `kg_extraction`, see `fake-ai.ts`). Nothing here is
// written to the database directly: a test uploads the recordings, generates a
// note from each, asks for the extraction over HTTP and commits the proposal,
// so every entity, relation and commitment enters the graph through the real
// write path (`ProposalCommitService` -> `GraphWriteService`) with real
// evidence rows, and the deferred `kg_assert_has_evidence` trigger runs.
//
//   "Weekly sync with Maria Lopez"   Maria Lopez, Jenny Kim, Joe Park attend.
//                                    Jenny Kim REPORTS_TO Maria Lopez.
//                                    Joe owns one OPEN commitment (the budget
//                                    draft, owed to Maria) and one DONE one
//                                    (the vendor review) that an "open action
//                                    items" answer must leave out.
//   "Joe and Jenny standup"          Joe and Jenny only: a meeting Maria did
//                                    NOT attend, which "meetings with Jenny's
//                                    boss" must leave out.
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

/** A person a recording mentions, and the words that prove it. */
export interface ScenarioPerson {
  /** The full name, as the graph labels the entity. */
  label: string;
  /** An exact quote from one of the recording's segments. */
  quote: string;
  /** Whether the person took part (an ATTENDED row to the meeting). */
  attended: boolean;
}

/** A relation between two of the recording's people. */
export interface ScenarioRelation {
  type: string;
  from: string;
  to: string;
  quote: string;
}

/** A commitment a person owns. */
export interface ScenarioCommitment {
  owner: string;
  counterparty: string | null;
  title: string;
  statement: string;
  status: 'open' | 'done';
  quote: string;
}

/** One recording of the scenario. */
export interface ScenarioRecording {
  /** The transcript title, which `kg.extract` uses as the meeting title (the fake model keys on it). */
  title: string;
  /** What the fake transcription provider hears. */
  transcript: Omit<NormalizedTranscript, 'provider'>;
  /** What the fake model extracts. */
  people: ScenarioPerson[];
  relations: ScenarioRelation[];
  commitments: ScenarioCommitment[];
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
  title: 'Weekly sync with Maria Lopez',
  transcript: {
    language: 'en',
    durationMs: 16_000,
    speakers: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    segments: segments([
      ['A', "Hi all, I'm Maria Lopez. Jenny Kim reports to me on the platform team."],
      ['B', 'Thanks Maria. Joe Park, can you send the budget draft by Friday?'],
      ['C', 'Yes, I will send the budget draft to Maria by Friday.'],
      ['C', 'I also finished the vendor review last week.'],
    ]),
  },
  people: [
    { label: 'Maria Lopez', quote: "I'm Maria Lopez", attended: true },
    { label: 'Jenny Kim', quote: 'Jenny Kim reports to me', attended: true },
    { label: 'Joe Park', quote: 'Joe Park, can you send the budget draft', attended: true },
  ],
  relations: [{ type: 'REPORTS_TO', from: 'Jenny Kim', to: 'Maria Lopez', quote: 'Jenny Kim reports to me on the platform team.' }],
  commitments: [
    {
      owner: 'Joe Park',
      counterparty: 'Maria Lopez',
      title: 'Send the budget draft',
      statement: 'Joe Park will send the budget draft to Maria Lopez by Friday.',
      status: 'open',
      quote: 'I will send the budget draft to Maria by Friday.',
    },
    {
      owner: 'Joe Park',
      counterparty: null,
      title: 'Finish the vendor review',
      statement: 'Joe Park finished the vendor review.',
      status: 'done',
      quote: 'I also finished the vendor review last week.',
    },
  ],
};

/** A meeting without the boss. */
export const STANDUP: ScenarioRecording = {
  title: 'Joe and Jenny standup',
  transcript: {
    language: 'en',
    durationMs: 8000,
    speakers: [{ label: 'A' }, { label: 'B' }],
    segments: segments([
      ['A', 'Morning Jenny, this is Joe Park with the standup.'],
      ['B', 'Morning Joe, Jenny Kim here. The release notes are ready.'],
    ]),
  },
  people: [
    { label: 'Joe Park', quote: 'this is Joe Park', attended: true },
    { label: 'Jenny Kim', quote: 'Jenny Kim here', attended: true },
  ],
  relations: [],
  commitments: [],
};

/** Every recording, in the order a test commits them (the standup links to the sync's people). */
export const GRAPH_SCENARIO: readonly ScenarioRecording[] = [WEEKLY_SYNC, STANDUP];

/** The two reference questions of the Ask leg. */
export const ASK_QUESTIONS = {
  actionItems: 'What are the action items from Joe?',
  bossMeetings: "What meetings have we had with Jenny's boss?",
} as const;
