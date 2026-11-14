/**
 * The voiceprint client (#827, epic #820): voice-based speaker-name suggestions
 * and the per-person and per-user voiceprint state.
 *
 * One exported function per endpoint. The wire shapes are IMPORTED from
 * `@marinoscar/kvox-contract/graph` (`graph-voiceprint.ts`) rather than
 * re-declared, so a drift fails `tsc`. BIOMETRIC: no response carries a vector
 * or audio, only counts, durations, ids and a suggestion's scores.
 */

import type {
  DeleteAllVoiceprintsResponse as ContractDeleteAllVoiceprintsResponse,
  PersonVoiceprint as ContractPersonVoiceprint,
  SpeakerSuggestion as ContractSpeakerSuggestion,
  SpeakerSuggestionDecision as ContractSpeakerSuggestionDecision,
  VoiceprintsSummary as ContractVoiceprintsSummary,
} from '@marinoscar/kvox-contract/graph';

import { KvoxApiError, kvoxDelete, kvoxGet, kvoxPost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

/**
 * One pending suggestion that a still-unnamed speaker is a Person in the viewer's graph.
 *
 * @stability experimental
 */
export type SpeakerSuggestion = ContractSpeakerSuggestion;

/**
 * The answer of an accept or a dismiss.
 *
 * @stability experimental
 */
export type SpeakerSuggestionDecision = ContractSpeakerSuggestionDecision;

/**
 * What the server has learned of one Person's voice.
 *
 * @stability experimental
 */
export type PersonVoiceprint = ContractPersonVoiceprint;

/**
 * The viewer's voiceprint opt-in and how much has been learned.
 *
 * @stability experimental
 */
export type VoiceprintsSummary = ContractVoiceprintsSummary;

/**
 * What "Delete all voiceprints" removed.
 *
 * @stability experimental
 */
export type DeleteAllVoiceprintsResult = ContractDeleteAllVoiceprintsResponse;

/**
 * The `details.reason` of the 409 an accept answers when the speaker has been named since.
 *
 * @stability experimental
 */
export const SPEAKER_ALREADY_NAMED = 'SPEAKER_ALREADY_NAMED';

const enc = encodeURIComponent;

/**
 * `GET /api/graph/speaker-suggestions?transcriptId=`: the pending suggestions of one transcript, best first.
 *
 * @stability experimental
 */
export function listSpeakerSuggestions(
  host: KvoxWebHost,
  transcriptId: string,
  signal?: AbortSignal,
): Promise<SpeakerSuggestion[]> {
  return kvoxGet<SpeakerSuggestion[]>(host, `/graph/speaker-suggestions?transcriptId=${enc(transcriptId)}`, {
    signal,
  });
}

/**
 * `POST /api/graph/speaker-suggestions/:id/accept`: names the speaker with the Person's name.
 *
 * @stability experimental
 */
export function acceptSpeakerSuggestion(host: KvoxWebHost, id: string): Promise<SpeakerSuggestionDecision> {
  return kvoxPost<SpeakerSuggestionDecision>(host, `/graph/speaker-suggestions/${enc(id)}/accept`, {});
}

/**
 * `POST /api/graph/speaker-suggestions/:id/dismiss`: the same pair is never suggested again.
 *
 * @stability experimental
 */
export function dismissSpeakerSuggestion(host: KvoxWebHost, id: string): Promise<SpeakerSuggestionDecision> {
  return kvoxPost<SpeakerSuggestionDecision>(host, `/graph/speaker-suggestions/${enc(id)}/dismiss`, {});
}

/**
 * `GET /api/graph/entities/:id/voiceprint`: one Person's voiceprint state.
 *
 * @stability experimental
 */
export function getEntityVoiceprint(host: KvoxWebHost, entityId: string, signal?: AbortSignal): Promise<PersonVoiceprint> {
  return kvoxGet<PersonVoiceprint>(host, `/graph/entities/${enc(entityId)}/voiceprint`, { signal });
}

/**
 * `DELETE /api/graph/entities/:id/voiceprint` (204): forgets that Person's voice.
 *
 * @stability experimental
 */
export function forgetEntityVoiceprint(host: KvoxWebHost, entityId: string): Promise<void> {
  return kvoxDelete<void>(host, `/graph/entities/${enc(entityId)}/voiceprint`);
}

/**
 * `GET /api/graph/voiceprints/summary`: the opt-in and the counts.
 *
 * @stability experimental
 */
export function getVoiceprintsSummary(host: KvoxWebHost, signal?: AbortSignal): Promise<VoiceprintsSummary> {
  return kvoxGet<VoiceprintsSummary>(host, '/graph/voiceprints/summary', { signal });
}

/**
 * `DELETE /api/graph/voiceprints`: deletes every voiceprint sample and pending suggestion of the viewer.
 *
 * @stability experimental
 */
export function deleteAllVoiceprints(host: KvoxWebHost): Promise<DeleteAllVoiceprintsResult> {
  return kvoxDelete<DeleteAllVoiceprintsResult>(host, '/graph/voiceprints');
}

/**
 * Whether an accept failed because the speaker was named in the meantime.
 *
 * @stability experimental
 */
export function isSpeakerAlreadyNamed(err: unknown): boolean {
  return err instanceof KvoxApiError && err.status === 409 && err.reason === SPEAKER_ALREADY_NAMED;
}
