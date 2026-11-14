// =============================================================================
// KVOX_VOICEPRINTS web binding (#825): the model is installed on first use inside a job, a
// download failure is thrown (so the job retries, it is not "unavailable"), concurrent callers
// share one install, and the policy defaults come from `@marinoscar/kvox-ai/voiceprints`.
//
// The download, the status probe and the worker-thread embedder are replaced; the policy
// functions (`decideVoiceSuggestion`, `selectVoiceprintWindows`) stay the real ones.
// =============================================================================

import { Logger } from '@nestjs/common';

const downloadVoiceprintModel = jest.fn();
const voiceprintModelStatus = jest.fn();
const createThreadedVoiceprintEmbedder = jest.fn();

jest.mock('@marinoscar/kvox-ai/voiceprints', () => ({
  ...jest.requireActual('@marinoscar/kvox-ai/voiceprints'),
  downloadVoiceprintModel: (...args: unknown[]) => downloadVoiceprintModel(...args),
  voiceprintModelStatus: (...args: unknown[]) => voiceprintModelStatus(...args),
  createThreadedVoiceprintEmbedder: (...args: unknown[]) => createThreadedVoiceprintEmbedder(...args),
}));

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VOICEPRINT_DIMENSIONS,
  VOICEPRINT_MANIFEST,
  VOICEPRINT_MAX_SAMPLES_PER_PERSON,
  VOICEPRINT_SUGGESTION_DEFAULTS,
} from '@marinoscar/kvox-ai/voiceprints';

import { PlatformKvoxVoiceprintsAdapter } from '../../src/platform-kvox/voiceprints/platform-kvox-voiceprints.adapter';

const MODEL_DIR = join(tmpdir(), 'kvox-models');

function embedder() {
  return { embed: jest.fn().mockResolvedValue(new Float32Array([0.6, 0.8])), dispose: jest.fn().mockResolvedValue(undefined) };
}

describe('PlatformKvoxVoiceprintsAdapter', () => {
  beforeEach(() => {
    downloadVoiceprintModel.mockReset().mockResolvedValue({ path: '/models/fresh' });
    voiceprintModelStatus.mockReset().mockResolvedValue({ installed: false });
    createThreadedVoiceprintEmbedder.mockReset().mockImplementation(() => embedder());
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('policy defaults', () => {
    it('exposes the model id, the vector width and the per-person cap of kvox-ai', () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      expect(adapter.modelId).toBe(VOICEPRINT_MANIFEST.model);
      expect(adapter.dimensions).toBe(VOICEPRINT_DIMENSIONS);
      expect(adapter.dimensions).toBe(512);
      expect(adapter.maxSamplesPerPerson).toBe(VOICEPRINT_MAX_SAMPLES_PER_PERSON);
      expect(adapter.maxSamplesPerPerson).toBe(10);
    });

    it('decides with the 0.52 threshold and the 0.05 margin', () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      expect(VOICEPRINT_SUGGESTION_DEFAULTS).toEqual({ threshold: 0.52, margin: 0.05 });

      expect(adapter.decide([{ entityId: 'a', score: 0.51 }])).toBeNull();
      expect(adapter.decide([{ entityId: 'a', score: 0.52 }])).toEqual({ entityId: 'a', score: 0.52, margin: 0.52 });
      expect(
        adapter.decide([
          { entityId: 'a', score: 0.7 },
          { entityId: 'b', score: 0.66 },
        ]),
      ).toBeNull();
      expect(
        adapter.decide([
          { entityId: 'b', score: 0.55 },
          { entityId: 'a', score: 0.7 },
        ]),
      ).toEqual({ entityId: 'a', score: 0.7, margin: expect.closeTo(0.15, 10) });
      expect(adapter.decide([])).toBeNull();
    });

    it('selects windows through kvox-ai and returns plain windows and the speech total', () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      const { windows, speechMs } = adapter.selectWindows([
        { startMs: 0, endMs: 6000 },
        { startMs: 6000, endMs: 12_000 },
      ]);
      expect(speechMs).toBeGreaterThanOrEqual(6000);
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) expect(Object.keys(w).sort()).toEqual(['endMs', 'startMs']);
      expect(adapter.selectWindows([])).toEqual({ windows: [], speechMs: 0 });
    });
  });

  describe('available()', () => {
    it('downloads the model when it is not installed, then builds the embedder on the installed path', async () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await expect(adapter.available()).resolves.toBe(true);

      expect(voiceprintModelStatus).toHaveBeenCalledWith(MODEL_DIR);
      expect(downloadVoiceprintModel).toHaveBeenCalledWith({ directory: MODEL_DIR });
      expect(createThreadedVoiceprintEmbedder).toHaveBeenCalledWith({ modelPath: '/models/fresh' });
    });

    it('does not download when the model is already installed', async () => {
      voiceprintModelStatus.mockResolvedValue({ installed: true, path: '/models/there' });
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await expect(adapter.available()).resolves.toBe(true);

      expect(downloadVoiceprintModel).not.toHaveBeenCalled();
      expect(createThreadedVoiceprintEmbedder).toHaveBeenCalledWith({ modelPath: '/models/there' });
    });

    it('downloads when the status says installed but names no path', async () => {
      voiceprintModelStatus.mockResolvedValue({ installed: true });
      await new PlatformKvoxVoiceprintsAdapter().available();
      expect(downloadVoiceprintModel).toHaveBeenCalledTimes(1);
    });

    it('THROWS when the download fails (the job retries; it is not reported as unavailable)', async () => {
      downloadVoiceprintModel.mockRejectedValue(new Error('network down'));
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await expect(adapter.available()).rejects.toThrow('network down');
      expect(createThreadedVoiceprintEmbedder).not.toHaveBeenCalled();
    });

    it('retries the install on the next call after a failure', async () => {
      downloadVoiceprintModel.mockRejectedValueOnce(new Error('network down'));
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await expect(adapter.available()).rejects.toThrow('network down');
      await expect(adapter.available()).resolves.toBe(true);
      expect(downloadVoiceprintModel).toHaveBeenCalledTimes(2);
    });

    it('installs once for concurrent callers, and not again afterwards', async () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await Promise.all([adapter.available(), adapter.available(), adapter.embed(new Float32Array(4))]);
      await adapter.available();
      expect(downloadVoiceprintModel).toHaveBeenCalledTimes(1);
      expect(createThreadedVoiceprintEmbedder).toHaveBeenCalledTimes(1);
    });
  });

  describe('embed()', () => {
    it('installs on first use and returns the embedder vector', async () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      const samples = new Float32Array(48_000);
      const vector = await adapter.embed(samples);

      expect(Array.from(vector)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
      const built = createThreadedVoiceprintEmbedder.mock.results[0]!.value as ReturnType<typeof embedder>;
      expect(built.embed).toHaveBeenCalledWith(samples);
    });

    it('propagates an install failure', async () => {
      downloadVoiceprintModel.mockRejectedValue(new Error('network down'));
      await expect(new PlatformKvoxVoiceprintsAdapter().embed(new Float32Array(4))).rejects.toThrow('network down');
    });
  });

  describe('shutdown', () => {
    it('disposes the embedder once, and does nothing when none was built', async () => {
      const idle = new PlatformKvoxVoiceprintsAdapter();
      await expect(idle.onApplicationShutdown()).resolves.toBeUndefined();

      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await adapter.available();
      const built = createThreadedVoiceprintEmbedder.mock.results[0]!.value as ReturnType<typeof embedder>;
      await adapter.onApplicationShutdown();
      await adapter.onApplicationShutdown();
      expect(built.dispose).toHaveBeenCalledTimes(1);
    });

    it('installs again after a shutdown (a fresh embedder, the model files stay)', async () => {
      const adapter = new PlatformKvoxVoiceprintsAdapter();
      await adapter.available();
      await adapter.onApplicationShutdown();
      voiceprintModelStatus.mockResolvedValue({ installed: true, path: '/models/fresh' });
      await adapter.available();
      expect(createThreadedVoiceprintEmbedder).toHaveBeenCalledTimes(2);
    });
  });
});
