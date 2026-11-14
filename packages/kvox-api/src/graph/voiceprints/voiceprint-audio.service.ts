// =============================================================================
// VoiceprintAudioService (#825, epic #820): audio in, voiceprints out
// =============================================================================
//
// The pure COMPUTE half of both voiceprint jobs: for the given speakers of one
// transcript, pick their speech windows, decode them to 16 kHz mono through
// ffmpeg and embed them through the `KVOX_VOICEPRINTS` port. It writes nothing,
// which is what keeps the jobs' `process` split into compute and persist (the
// shape a node-side executor would need).
//
// ⚠ BIOMETRIC. Neither audio nor a vector is logged, put in an error message or
// returned beyond this call: a speaker that cannot be embedded is skipped with
// its id and a reason code only.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  KVOX_OBJECT_STORE,
  KVOX_PRISMA,
  KVOX_VOICEPRINTS,
  type KvoxObjectStorePort,
  type KvoxVoiceprintsPort,
} from '../../ports/index.js';
import { FfmpegService } from '../../transcripts/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';

/** A speaker with less speech than this is not worth a voiceprint (spec: 3 s). */
export const VOICEPRINT_MIN_SPEECH_MS = 3000;

/** One speaker's voiceprint. */
export interface SpeakerVoice {
  speakerId: string;
  /** The L2-normalised vector; never logged. */
  embedding: number[];
  /** Speech the vector was computed from. */
  speechMs: number;
}

/** What `computeSpeakerVoices` returns. */
export interface SpeakerVoiceResult {
  speakers: SpeakerVoice[];
  /** Why the whole run produced nothing, when it did not run at all. */
  skipped: 'unavailable' | 'no_audio' | 'no_ffmpeg' | null;
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const DECODE_TIMEOUT_MS = 4 * 60_000;

@Injectable()
export class VoiceprintAudioService {
  private readonly logger = new Logger(VoiceprintAudioService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
    @Inject(KVOX_VOICEPRINTS) private readonly voiceprints: KvoxVoiceprintsPort,
    @Optional() private readonly ffmpeg?: FfmpegService,
  ) {}

  /**
   * Computes the voiceprint of each given speaker of a transcript.
   *
   * @param input.transcriptId - the transcript.
   * @param input.ownerId - its owner (the transcript must belong to them).
   * @param input.speakerIds - the speakers to embed.
   * @returns the speakers that had enough speech and embedded cleanly.
   */
  async computeSpeakerVoices(input: {
    transcriptId: string;
    ownerId: string;
    speakerIds: string[];
  }): Promise<SpeakerVoiceResult> {
    const none = (skipped: SpeakerVoiceResult['skipped']): SpeakerVoiceResult => ({ speakers: [], skipped });
    if (input.speakerIds.length === 0) return none(null);
    if (!this.ffmpeg) return none('no_ffmpeg');
    // The model may be downloaded here, inside the job.
    if (!(await this.voiceprints.available())) return none('unavailable');

    const transcript = await this.prisma.transcript.findFirst({
      where: { id: input.transcriptId, ownerId: input.ownerId, deletedAt: null },
      select: { playbackObjectId: true, playbackStatus: true, sourceObjectId: true },
    });
    if (!transcript) return none('no_audio');

    const objectIds = [
      transcript.playbackStatus === 'ready' ? transcript.playbackObjectId : null,
      transcript.sourceObjectId,
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const described = await this.store.describe(objectIds);
    const objectId = objectIds.find((id) => described.get(id)?.state === 'ready');
    if (!objectId) return none('no_audio');

    const segments = (await this.prisma.transcriptSegment.findMany({
      where: { transcriptId: input.transcriptId, speakerId: { in: input.speakerIds } },
      select: { speakerId: true, startMs: true, endMs: true },
      orderBy: [{ ordinal: 'asc' }],
    })) as Array<{ speakerId: string; startMs: number; endMs: number }>;

    const speakers: SpeakerVoice[] = [];
    for (const speakerId of input.speakerIds) {
      const mine = segments.filter((s) => s.speakerId === speakerId);
      const { windows, speechMs } = this.voiceprints.selectWindows(mine);
      if (windows.length === 0 || speechMs < VOICEPRINT_MIN_SPEECH_MS) {
        this.logger.debug(`voiceprint: speaker ${speakerId} has too little speech`);
        continue;
      }
      try {
        // A fresh URL per speaker: a long recording can outlive one URL.
        const url = await this.store.signedDownloadUrl(objectId, { ttlSeconds: SIGNED_URL_TTL_SECONDS });
        const samples = await this.ffmpeg.decodePcm16kMono({ input: url, windows, timeoutMs: DECODE_TIMEOUT_MS });
        if (samples.length === 0) continue;
        const vector = await this.voiceprints.embed(samples);
        speakers.push({ speakerId, embedding: Array.from(vector), speechMs });
      } catch (error) {
        // Reason only: an ffmpeg error is already URL-free, an embed error names no audio.
        this.logger.warn(
          `voiceprint: speaker ${speakerId} skipped: ${error instanceof Error ? error.constructor.name : 'error'}`,
        );
      }
    }
    return { speakers, skipped: null };
  }
}

/** A pgvector text literal for a vector, bound as TEXT and cast with `::vector`. */
export function toVectorLiteral(values: ReadonlyArray<number>): string {
  return `[${values.join(',')}]`;
}
