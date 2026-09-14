/**
 * `services/transcription.ts` (issue #23, epic #19).
 *
 * The `api` transport is mocked; what is under test is the CONTRACT this
 * module puts on the wire — the paths, the `If-Match` handling, and above all
 * that `apiKey` travels in exactly one direction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));

import { api } from '../../services/api';
import {
  getTranscriptionConfig,
  getTranscriptionSettings,
  removeTranscriptionCredential,
  testTranscriptionConnection,
  updateTranscriptionSettings,
} from '../../services/transcription';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('services/transcription', () => {
  it('reads the admin settings from /transcription-settings', async () => {
    mockApi.get.mockResolvedValue({} as never);

    await getTranscriptionSettings();

    expect(mockApi.get).toHaveBeenCalledWith('/transcription-settings');
  });

  it('reads the capability probe from /transcription/config', async () => {
    // A DIFFERENT PATH PREFIX, deliberately: the two authorities are visibly
    // different things rather than two decorators in one file.
    mockApi.get.mockResolvedValue({} as never);

    await getTranscriptionConfig();

    expect(mockApi.get).toHaveBeenCalledWith('/transcription/config');
  });

  it('sends If-Match on a save, including version 0', async () => {
    // `0` asserts "I believe nothing is stored yet". A truthiness check would
    // silently make a first save the one unprotected write.
    mockApi.put.mockResolvedValue({} as never);

    await updateTranscriptionSettings({ enabled: true }, 0);

    expect(mockApi.put).toHaveBeenCalledWith(
      '/transcription-settings',
      { enabled: true },
      { headers: { 'If-Match': '0' } },
    );
  });

  it('omits If-Match when no version is given', async () => {
    mockApi.put.mockResolvedValue({} as never);

    await updateTranscriptionSettings({ enabled: true });

    expect(mockApi.put).toHaveBeenCalledWith(
      '/transcription-settings',
      { enabled: true },
      { headers: undefined },
    );
  });

  it('passes a deep-partial body through untouched', async () => {
    // `{ playback: { bitrateKbps: 96 } }` must reach the API as-is, or the page
    // has to send the whole namespace to change one control.
    mockApi.put.mockResolvedValue({} as never);

    await updateTranscriptionSettings({ playback: { bitrateKbps: 96 } }, 2);

    expect(mockApi.put.mock.calls[0][1]).toEqual({ playback: { bitrateKbps: 96 } });
  });

  it('posts a probe to /test, carrying the unsaved key', async () => {
    mockApi.post.mockResolvedValue({} as never);

    await testTranscriptionConnection({
      provider: 'assemblyai',
      region: 'eu',
      apiKey: 'unsaved-key',
    });

    expect(mockApi.post).toHaveBeenCalledWith('/transcription-settings/test', {
      provider: 'assemblyai',
      region: 'eu',
      apiKey: 'unsaved-key',
    });
  });

  it('URL-encodes the provider id when removing a credential', async () => {
    // A provider id with a slash must not escape the path segment it belongs
    // in and address a different route.
    mockApi.delete.mockResolvedValue(undefined as never);

    await removeTranscriptionCredential('weird/id');

    expect(mockApi.delete).toHaveBeenCalledWith(
      '/transcription-settings/credentials/weird%2Fid',
    );
  });

  it('never sends a key on a read or a delete', async () => {
    mockApi.get.mockResolvedValue({} as never);
    mockApi.delete.mockResolvedValue(undefined as never);

    await getTranscriptionSettings();
    await getTranscriptionConfig();
    await removeTranscriptionCredential('assemblyai');

    for (const call of [...mockApi.get.mock.calls, ...mockApi.delete.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('apiKey');
    }
  });
});
