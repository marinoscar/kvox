import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_SLUG } from '@app/shared';
import type { KvoxVoiceprintsPort, KvoxVoiceWindow } from '@marinoscar/kvox-api/ports';
import {
  VOICEPRINT_DIMENSIONS,
  VOICEPRINT_MANIFEST,
  VOICEPRINT_MAX_SAMPLES_PER_PERSON,
  createThreadedVoiceprintEmbedder,
  decideVoiceSuggestion,
  downloadVoiceprintModel,
  selectVoiceprintWindows,
  voiceprintModelStatus,
  type VoiceprintEmbedder,
} from '@marinoscar/kvox-ai/voiceprints';

// =============================================================================
// KVOX_VOICEPRINTS -> `@marinoscar/kvox-ai/voiceprints` (issue #825)
// =============================================================================
//
// The web edition's binding of the voiceprint port. The CAM++ model (about 30 MB) is
// installed on first use INSIDE a queue job (`kg.voiceprint_enroll` / `kg.voice_match`
// call `available()`), which is where long work belongs; the embedder then runs in a
// worker thread so the event loop is never blocked.
//
// Model folder: a `<app slug>-models` directory under the OS temp directory. No environment
// variable (root rule); a container restart re-downloads the model once, and a deployment
// that wants it persistent can mount a volume at that path.
//
// A download failure is thrown (not swallowed as "unavailable") so the job retries.
// Biometric data: nothing here logs audio or vectors.
// =============================================================================

@Injectable()
export class PlatformKvoxVoiceprintsAdapter implements KvoxVoiceprintsPort, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformKvoxVoiceprintsAdapter.name);

  readonly modelId = VOICEPRINT_MANIFEST.model;

  readonly dimensions = VOICEPRINT_DIMENSIONS;

  readonly maxSamplesPerPerson = VOICEPRINT_MAX_SAMPLES_PER_PERSON;

  private readonly directory = join(tmpdir(), `${APP_SLUG}-models`);

  private embedder: VoiceprintEmbedder | null = null;

  private installing: Promise<VoiceprintEmbedder> | null = null;

  async available(): Promise<boolean> {
    await this.ensureEmbedder();
    return true;
  }

  async embed(samples: Float32Array): Promise<Float32Array> {
    const embedder = await this.ensureEmbedder();
    return embedder.embed(samples);
  }

  selectWindows(segments: ReadonlyArray<KvoxVoiceWindow>): { windows: KvoxVoiceWindow[]; speechMs: number } {
    const { windows, totalSpeechMs } = selectVoiceprintWindows(segments);
    return { windows: windows.map((w) => ({ startMs: w.startMs, endMs: w.endMs })), speechMs: totalSpeechMs };
  }

  decide(candidates: ReadonlyArray<{ entityId: string; score: number }>) {
    const best = decideVoiceSuggestion(candidates);
    return best ? { entityId: best.entityId, score: best.score, margin: best.margin } : null;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.embedder?.dispose();
    this.embedder = null;
  }

  private ensureEmbedder(): Promise<VoiceprintEmbedder> {
    if (this.embedder) return Promise.resolve(this.embedder);
    this.installing ??= this.install().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async install(): Promise<VoiceprintEmbedder> {
    const status = await voiceprintModelStatus(this.directory);
    let path = status.path;
    if (!status.installed || !path) {
      this.logger.log('Installing the speaker voiceprint model (one-time download)');
      path = (await downloadVoiceprintModel({ directory: this.directory })).path;
    }
    this.embedder = createThreadedVoiceprintEmbedder({ modelPath: path });
    return this.embedder;
  }
}
