import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';
import type { CopilotSettings, CopilotStatus } from '@marinoscar/kvox-contract/copilot';

/**
 * One row of the "which features run on Copilot" list.
 *
 * @stability experimental
 */
export interface CopilotCapability {
  /** The feature name. */
  label: string;
  /** Whether it runs on Copilot. */
  available: boolean;
  /** Why not, when it does not. */
  note?: string;
}

const ROWS: readonly { label: string; tasks: readonly string[]; always: boolean }[] = [
  { label: 'Notes', tasks: ['notes.generate', 'notes.title'], always: true },
  { label: 'Knowledge extraction', tasks: ['graph.extract', 'graph.adjudicate', 'graph.digest'], always: true },
  { label: 'Name check', tasks: ['transcripts.name_check'], always: true },
  { label: 'Ask', tasks: ['ask.respond'], always: true },
  { label: 'Search by meaning', tasks: ['search.embed', 'graph.embed'], always: false },
];

/**
 * The note shown beside an unavailable feature.
 *
 * @stability experimental
 */
export const COPILOT_UNAVAILABLE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  needs_tool_calling: 'Needs a provider with tool calling. Add an OpenAI key to keep Ask.',
  needs_embeddings: 'Needs a provider with embeddings. Add an OpenAI key to keep it.',
});

/**
 * The capability rows for a status: Notes, Knowledge extraction, Name check and
 * Ask always, and Search by meaning only while it is unavailable.
 *
 * @remarks
 * A row is unavailable when any of its tasks is in `status.unavailableTasks`;
 * the note comes from that entry's `reason`.
 *
 * @param status - The Copilot status.
 * @stability experimental
 */
export function buildCopilotCapabilities(status: Pick<CopilotStatus, 'unavailableTasks'>): CopilotCapability[] {
  const rows: CopilotCapability[] = [];
  for (const row of ROWS) {
    const blocked = status.unavailableTasks.find((t) => row.tasks.includes(t.task));
    if (!blocked && !row.always) continue;
    rows.push(
      blocked
        ? { label: row.label, available: false, note: COPILOT_UNAVAILABLE_NOTES[blocked.reason] }
        : { label: row.label, available: true },
    );
  }
  return rows;
}

/**
 * Whether the user has accepted the CURRENT consent text.
 *
 * @param settings - The stored setting.
 * @stability experimental
 */
export function hasCopilotConsent(settings: Pick<CopilotSettings, 'consentedAt' | 'consentVersion'>): boolean {
  return !!settings.consentedAt && settings.consentVersion === COPILOT_CONSENT_VERSION;
}
