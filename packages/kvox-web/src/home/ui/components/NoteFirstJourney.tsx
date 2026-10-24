// =============================================================================
// The note-first journey of Home (marinoscar/kvox#731, epic #728)
// =============================================================================
//
// A host without audio capture or transcription (KVox Desktop, ADR-0006) has no
// "Upload a recording" to offer a new account: its notes come from documents and
// folders it imports (and from KVox transcript JSON). Its first run is told as
// what happens to those notes: import them, review what the AI found, see the
// graph they build, ask questions of them. `KvoxHomePage` draws this journey
// instead of the classic one when the host's `features().transcription` is
// `false`; a host can also pass the pieces itself (`journeyStages`,
// `journeyIntro`, `journeySteps`).
// =============================================================================

import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';

import { ImportNotesButton } from '../../../notes/ui/index.js';
import type { KvoxJourneyProgress, KvoxJourneyStep } from '../../headless/index.js';
import type { JourneyStage } from './JourneyEmptyState.js';

/**
 * The sentence under "Start here" in the note-first journey.
 *
 * @stability experimental
 */
export const KVOX_NOTE_FIRST_JOURNEY_INTRO = 'Bring in the notes you already have. Here is what happens next.';

/**
 * The stage cards of the note-first journey, in order: import, review, the
 * graph, Ask. What `KvoxHomePage` draws for a host without transcription.
 *
 * @stability experimental
 */
export const KVOX_NOTE_FIRST_JOURNEY: readonly JourneyStage[] = [
  {
    key: 'import',
    label: 'Import your notes',
    description: 'Word, PowerPoint, PDF, Markdown or text — a file or a whole folder.',
    icon: <FileUploadOutlinedIcon />,
  },
  {
    key: 'review',
    label: 'Review',
    description: 'Approve what the AI found, in one click with the Review Queue.',
    icon: <FactCheckOutlinedIcon />,
  },
  {
    key: 'graph',
    label: 'Your graph',
    description: 'People, projects, decisions and how they connect.',
    icon: <HubOutlinedIcon />,
  },
  {
    key: 'ask',
    label: 'Ask',
    description: 'Questions answered from your notes, with citations.',
    icon: <QuestionAnswerOutlinedIcon />,
  },
];

/**
 * The steps under the note-first journey: "Add your notes folder" (the note
 * libraries, the primary action) and "Import notes" (the notes slice's
 * `ImportNotesButton`: pick files, upload them, follow the import).
 *
 * @remarks
 * Both need `notes:write`, the permission the library and import routes enforce;
 * a viewer without it sees the stage cards alone. Neither step is ever done:
 * the journey is drawn only while the account has no notes.
 *
 * @param _progress - what the person has done so far (unused today; kept so the
 *   signature matches `defaultJourneySteps`).
 * @returns the steps, unfiltered (`resolveJourneySteps` filters them).
 *
 * @stability experimental
 */
export function noteFirstJourneySteps(_progress: KvoxJourneyProgress): KvoxJourneyStep[] {
  return [
    {
      key: 'add-notes-folder',
      title: 'Add your notes folder',
      body: 'Choose the folder your notes live in. Every file becomes a note, and changes come in when you sync.',
      done: false,
      action: { label: 'Add your notes folder', to: '/notes/libraries', icon: <CreateNewFolderOutlinedIcon /> },
      permission: 'notes:write',
    },
    {
      key: 'import-notes',
      title: 'Import notes',
      body: 'Or start with a few files: Word, PowerPoint, PDF, Markdown or text.',
      done: false,
      action: { label: 'Import notes', element: <ImportNotesButton /> },
      permission: 'notes:write',
    },
  ];
}
