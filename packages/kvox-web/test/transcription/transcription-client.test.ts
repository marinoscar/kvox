/**
 * The transcription admin client (issue #23, epic #19).
 *
 * The host transport is the fake host; what is under test is the CONTRACT this
 * module puts on the wire: the paths, the `If-Match` handling, and above all
 * that `apiKey` travels in exactly one direction.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost } from '../../src/core/testing/index.js';
import { KvoxApiError } from '../../src/core/headless/index.js';
import {
  getTranscriptionConfig,
  getTranscriptionSettings,
  removeTranscriptionCredential,
  testTranscriptionConnection,
  updateTranscriptionSettings,
} from '../../src/transcription/headless/index.js';

let host: FakeKvoxWebHost;

beforeEach(() => {
  host = createFakeKvoxWebHost({
    routes: {
      'GET /transcription-settings': {},
      'GET /transcription/config': {},
      'PUT /transcription-settings': {},
      'POST /transcription-settings/test': { ok: true, latencyMs: 1, detail: 'fine' },
      'DELETE /transcription-settings/credentials/:provider': undefined,
    },
  });
});

describe('transcription client', () => {
  it('reads the admin settings from /transcription-settings', async () => {
    await getTranscriptionSettings(host);

    expect(host.callsTo('GET /transcription-settings')).toHaveLength(1);
  });

  it('reads the capability probe from /transcription/config', async () => {
    // A DIFFERENT PATH PREFIX, deliberately: the two authorities are visibly
    // different things rather than two decorators in one file.
    await getTranscriptionConfig(host);

    expect(host.callsTo('GET /transcription/config')).toHaveLength(1);
  });

  it('sends If-Match on a save, including version 0', async () => {
    // `0` asserts "I believe nothing is stored yet". A truthiness check would
    // silently make a first save the one unprotected write.
    await updateTranscriptionSettings(host, { enabled: true }, 0);

    const [call] = host.callsTo('PUT /transcription-settings');
    expect(call?.body).toEqual({ enabled: true });
    expect(call?.headers).toEqual({ 'If-Match': '0' });
  });

  it('omits If-Match when no version is given', async () => {
    await updateTranscriptionSettings(host, { enabled: true });

    const [call] = host.callsTo('PUT /transcription-settings');
    expect(call?.headers ?? {}).not.toHaveProperty('If-Match');
  });

  it('passes a deep-partial body through untouched', async () => {
    // `{ playback: { bitrateKbps: 96 } }` must reach the API as-is, or the page
    // has to send the whole namespace to change one control.
    await updateTranscriptionSettings(host, { playback: { bitrateKbps: 96 } }, 2);

    expect(host.callsTo('PUT /transcription-settings')[0]?.body).toEqual({
      playback: { bitrateKbps: 96 },
    });
  });

  it('posts a probe to /test, carrying the unsaved key', async () => {
    await testTranscriptionConnection(host, {
      provider: 'assemblyai',
      region: 'eu',
      apiKey: 'unsaved-key',
    });

    expect(host.callsTo('POST /transcription-settings/test')[0]?.body).toEqual({
      provider: 'assemblyai',
      region: 'eu',
      apiKey: 'unsaved-key',
    });
  });

  it('URL-encodes the provider id when removing a credential', async () => {
    // A provider id with a slash must not escape the path segment it belongs
    // in and address a different route.
    await removeTranscriptionCredential(host, 'weird/id');

    expect(host.calls.at(-1)?.path).toBe('/transcription-settings/credentials/weird%2Fid');
  });

  it('never sends a key on a read or a delete', async () => {
    await getTranscriptionSettings(host);
    await getTranscriptionConfig(host);
    await removeTranscriptionCredential(host, 'assemblyai');

    for (const call of host.calls) {
      expect(JSON.stringify(call)).not.toContain('apiKey');
    }
  });

  it('rejects with a KvoxApiError that keeps the status and the server reason', async () => {
    host.setRoute('PUT /transcription-settings', () => {
      throw fakeApiError(409, 'stale', { reason: 'version_conflict' });
    });

    const error = await updateTranscriptionSettings(host, { enabled: true }, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvoxApiError);
    expect(error).toMatchObject({ status: 409, reason: 'version_conflict' });
  });
});
