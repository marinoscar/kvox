// =============================================================================
// `selectTranscriptionInput()` — original, rendition, or wait (issue #25, §2.4)
// =============================================================================
//
// ONE PURE FUNCTION, called from two places that must agree exactly:
//
//   • the upload listener, deciding whether transcription can start the moment
//     the audio lands, or has to wait for `media.audio.transcode`;
//   • `transcription.submit` itself, re-deciding at RUN TIME — because the job
//     may have sat `pending` while the rendition finished, and pointing the
//     provider at a file the listener chose minutes ago is a decision made
//     against state that has since moved.
//
// Issue #26 extends it rather than replaces it: the `rendition` branch is
// already written here, and what #26 adds is a handler that makes the
// rendition exist. Until then `rendition` is simply never `ready` and this
// function answers `wait` for the formats that need one — which is the correct
// answer, not a stub.
//
// -----------------------------------------------------------------------------
// WHY `presigned_url` IS PART OF THE CONDITION FOR USING THE ORIGINAL
// -----------------------------------------------------------------------------
//
// The spec's rule is "the original, when the provider accepts it directly AND
// the delivery mode is `presigned_url`". The second half looks redundant and
// is not: in `presigned_url` mode the PROVIDER fetches the bytes, so the
// original's size costs this deployment nothing, and waiting for a transcode
// would add latency for no benefit. In `upload` mode the API SERVER RELAYS THE
// BYTES (§2.6) — it downloads the input and re-uploads it to the provider —
// and relaying a 5 GB original where a 60 MB rendition would transcribe
// identically is exactly the cost that mode exists under protest to pay. So
// `upload` mode waits for the small file.
//
// ⚠ THE CONSEQUENCE, STATED RATHER THAN DISCOVERED: a deployment that sets
// `audioDelivery: 'upload'` and has no `media.audio.transcode` handler
// registered (a build with #25 but not #26) will leave transcription in
// `waiting_input` indefinitely. `transcripts.housekeeping` is what notices
// that and says so — it is not silent — and `upload` mode is not the default.
//
// -----------------------------------------------------------------------------
// RETURNS A DECISION, NOT AN ID
// -----------------------------------------------------------------------------
//
// Every branch carries a `reason` string written for a human. It reaches
// `transcripts.failure_reason` and the job log, so "why is this transcript
// waiting?" is answerable from the row rather than by re-deriving the decision
// from the provider's capability table by hand.
// =============================================================================

import type { TranscriptionProviderCapabilities } from '../transcription/providers/transcription-provider.interface';

/** How the provider receives the audio. Mirrors `transcription.audioDelivery`. */
export type AudioDeliveryMode = 'presigned_url' | 'upload';

/** The one storage object this decision is about. */
export interface TranscriptionInputCandidate {
  id: string;
  mimeType: string;
  /** Byte length. `number`, not `bigint` — callers convert at the boundary. */
  size: number;
}

/** What the caller knows, at the moment it asks. */
export interface SelectTranscriptionInputOptions {
  /** The ACTIVE provider's declared limits. Never probed, always declared. */
  capabilities: TranscriptionProviderCapabilities;
  /** `transcription.audioDelivery` as configured right now. */
  audioDelivery: AudioDeliveryMode;
  /** The file the user uploaded. Always present — a transcript cannot exist without one. */
  original: TranscriptionInputCandidate;
  /**
   * The playback rendition, when one exists.
   *
   * `null` covers three distinct situations that need no distinguishing here:
   * no transcode has been enqueued, one is running, or one failed. All three
   * mean "there is no rendition to point at", and the `wait` branch's reason
   * says which by naming the playback status separately.
   */
  rendition?: TranscriptionInputCandidate | null;
  /**
   * Whether a rendition can still be expected.
   *
   * `false` when the transcode has permanently failed or was never going to
   * run — the difference between "wait, it is coming" and "wait forever",
   * which is the difference between a transcript that finishes late and one
   * that has to be failed with a reason.
   */
  renditionExpected?: boolean;
}

/** The decision. `objectId` is present exactly when there is something to submit. */
export type TranscriptionInputSelection =
  | { kind: 'original'; objectId: string; mimeType: string; size: number; reason: string }
  | { kind: 'rendition'; objectId: string; mimeType: string; size: number; reason: string }
  | { kind: 'wait'; objectId: null; reason: string }
  | { kind: 'impossible'; objectId: null; reason: string };

/** Case-insensitive membership in the provider's declared accept list. */
function accepts(capabilities: TranscriptionProviderCapabilities, mimeType: string): boolean {
  const wanted = mimeType.trim().toLowerCase();

  return capabilities.acceptedMimeTypes.some(
    (accepted) => accepted.trim().toLowerCase() === wanted,
  );
}

/** Does this candidate fit under the provider's hard byte ceiling? */
function fits(capabilities: TranscriptionProviderCapabilities, size: number): boolean {
  return size <= capabilities.maxInputBytes;
}

/**
 * Which object should `transcription.submit` point the provider at?
 *
 * TOTAL: every combination of inputs produces one of the four kinds, and none
 * of them throws. A caller acting on `wait` leaves `transcription_status` at
 * `waiting_input`; a caller acting on `impossible` fails the transcript with
 * the returned reason, because no future event can change the answer.
 */
export function selectTranscriptionInput(
  options: SelectTranscriptionInputOptions,
): TranscriptionInputSelection {
  const {
    capabilities,
    audioDelivery,
    original,
    rendition = null,
    renditionExpected = true,
  } = options;

  const originalAccepted = accepts(capabilities, original.mimeType);
  const originalFits = fits(capabilities, original.size);

  // The fast path, and the one nearly every upload takes: the provider takes
  // this format at this size, and it fetches the bytes itself.
  if (audioDelivery === 'presigned_url' && originalAccepted && originalFits) {
    return {
      kind: 'original',
      objectId: original.id,
      mimeType: original.mimeType,
      size: original.size,
      reason:
        `the provider accepts ${original.mimeType} at this size and fetches the bytes ` +
        'itself, so there is no reason to wait for a rendition',
    };
  }

  if (rendition) {
    if (!accepts(capabilities, rendition.mimeType)) {
      // A rendition the provider will not take is a configuration fault, not a
      // transient one: the same transcode will produce the same format forever.
      return {
        kind: 'impossible',
        objectId: null,
        reason:
          `the playback rendition is ${rendition.mimeType}, which this provider does not ` +
          'accept, and the original is unusable too',
      };
    }

    if (!fits(capabilities, rendition.size)) {
      return {
        kind: 'impossible',
        objectId: null,
        reason:
          `the playback rendition is ${rendition.size} bytes, above this provider's ` +
          `${capabilities.maxInputBytes}-byte limit`,
      };
    }

    return {
      kind: 'rendition',
      objectId: rendition.id,
      mimeType: rendition.mimeType,
      size: rendition.size,
      reason:
        audioDelivery === 'upload'
          ? 'this deployment relays the bytes itself, so the smaller rendition is used'
          : `the provider does not accept the original (${original.mimeType}, ` +
            `${original.size} bytes) directly`,
    };
  }

  // No rendition, and none coming. Whether that is fatal depends on why the
  // original was rejected — a size problem cannot be fixed by any transcode
  // this application would produce, but neither can a format problem once the
  // transcode is known not to run.
  if (!renditionExpected) {
    if (!originalFits) {
      return {
        kind: 'impossible',
        objectId: null,
        reason:
          `the audio is ${original.size} bytes, above this provider's ` +
          `${capabilities.maxInputBytes}-byte limit, and no playback rendition was produced`,
      };
    }

    return {
      kind: 'impossible',
      objectId: null,
      reason:
        `this provider does not accept ${original.mimeType}` +
        (originalAccepted ? '' : ' directly') +
        ', and no playback rendition was produced to transcribe instead',
    };
  }

  return {
    kind: 'wait',
    objectId: null,
    reason:
      audioDelivery === 'upload'
        ? 'this deployment relays audio to the provider itself and is waiting for the ' +
          'smaller playback rendition'
        : `this provider does not accept the original (${original.mimeType}, ` +
          `${original.size} bytes) directly; waiting for the playback rendition`,
  };
}
