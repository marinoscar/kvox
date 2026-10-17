import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunningBareHost } from '../src/bootstrap.js';

// =============================================================================
// The bare host's happy path (issue #505, epic #498)
// =============================================================================
//
// One recording through the whole domain, over real HTTP, on the database leg
// `--db` chose (`BARE_HOST_DB`): upload, transcribe (a fake provider), correct,
// generate a note (a fake model), find it by search, export, delete. Nothing in
// the host is mocked except what has no business being real: the speech provider
// and the language model.
//
// The application is loaded from `dist/` with `require`, not imported: Vitest's
// transformer does not emit decorator metadata, and Nest's dependency injection
// reads it. `dist/` is what `npm run build` made with `tsc`.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const load = createRequire(import.meta.url);
const bootstrap = load('../dist/bootstrap.js') as typeof import('../src/bootstrap.js');
const provider = load('../dist/fake-provider.js') as typeof import('../src/fake-provider.js');
const { startBareHost, FAKE_NOTE_TEXT } = bootstrap;
const { FAKE_TRANSCRIPT } = provider;

const AUDIO = readFileSync(join(here, 'fixtures', 'hello.mp3'));
const NOTE_BODY = FAKE_NOTE_TEXT.join('');

let host: RunningBareHost;
let transcriptId = '';
let objectId = '';
let noteId = '';
let version = 0;
let partUrls: string[] = [];
let segmentRows: Array<{ id: string; rev: number; text: string }> = [];

/** A request as the one local user. */
async function api(path: string, init: RequestInit & { json?: unknown; anonymous?: boolean } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!init.anonymous) headers.set('x-local-user', '1');
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return fetch(`${host.baseUrl}${path}`, { ...init, headers, body });
}

async function json<T = any>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(expected);
  return JSON.parse(text) as T;
}

/** Runs every job that is due (the poll back-off is fast-forwarded) and fails the test on a failed job. */
async function drain(): Promise<void> {
  await host.jobs.drain({ ignoreSchedule: true });
  const failed = await host.prisma.job.findMany({ where: { status: 'failed' }, select: { type: true, lastError: true } });
  expect(failed, `failed jobs: ${JSON.stringify(failed)}`).toEqual([]);
}

beforeAll(async () => {
  host = await startBareHost({
    backgroundJobs: false,
    dataDir: join(here, '..', '.data', `e2e-${process.pid}`),
    log: (line) => console.log(line),
  });
});

afterAll(async () => {
  await host?.close();
});

describe('the bare host, end to end', () => {
  it('1. answers 401 without the local-user header and offers transcription with it', async () => {
    const anonymous = await api('/api/transcription/config', { anonymous: true });
    expect(anonymous.status).toBe(401);

    const config = await json(await api('/api/transcription/config'));
    expect(config.available).toBe(true);
    expect(config.providerLabel).toContain('fake');
  });

  it('2. creates a transcript and receives the upload part URLs', async () => {
    const created = await json(
      await api('/api/transcripts', {
        method: 'POST',
        json: { title: 'Bare host recording', source: { name: 'hello.mp3', size: AUDIO.length, mimeType: 'audio/mpeg' } },
      }),
      201,
    );
    transcriptId = created.transcript.id;
    objectId = created.upload.objectId;
    expect(created.transcript.status).toBe('uploading');
    expect(created.upload.totalParts).toBe(1);
    expect(created.upload.parts).toHaveLength(1);
    expect(created.upload.parts[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/local-store\/parts\/[0-9a-f-]+\/1\?exp=\d+&sig=[0-9a-f]+$/);
    partUrls = created.upload.parts.map((part: { url: string }) => part.url);
  });

  it('3. uploads the bytes to the part URL and completes the upload', async () => {
    // A tampered signature is refused before a byte is stored.
    const forged = await fetch(partUrls[0].replace(/sig=[0-9a-f]{4}/, 'sig=0000'), { method: 'PUT', body: AUDIO, headers: { 'content-type': 'audio/mpeg' } });
    expect(forged.status).toBe(401);

    const put = await fetch(partUrls[0], { method: 'PUT', body: AUDIO, headers: { 'content-type': 'audio/mpeg' } });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);

    await json(await api(`/api/storage/objects/${objectId}/upload/complete`, { method: 'POST', json: {} }));
    const stored = readdirSync(host.objectStore.objectFolder, { recursive: true }).filter((entry) => String(entry).endsWith('.mp3'));
    expect(stored).toHaveLength(1);
  });

  it('4. runs the jobs until the transcript is ready, with the fake provider’s segments', async () => {
    await drain();

    const detail = await json(await api(`/api/transcripts/${transcriptId}`));
    expect(detail.status).toBe('ready');
    version = detail.currentVersion;

    const segments = await json(await api(`/api/transcripts/${transcriptId}/segments`));
    const items = segments.items ?? segments.segments ?? segments;
    expect(items.map((segment: { text: string }) => segment.text)).toEqual(FAKE_TRANSCRIPT.segments.map((segment) => segment.text));
    segmentRows = items;
  });

  it('5. applies a correction and the version rises', async () => {
    const first = segmentRows[0];
    const result = await json(
      await api(`/api/transcripts/${transcriptId}/operations`, {
        method: 'POST',
        json: {
          baseVersion: version,
          clientBatchId: 'bare-host-batch-1',
          ops: [{ op: 'segment.update_text', segmentId: first.id, rev: first.rev, text: 'Welcome to the corrected zebracorn smoke test.' }],
        },
      }),
      201,
    );
    expect(JSON.stringify(result)).toContain('"version"');

    const detail = await json(await api(`/api/transcripts/${transcriptId}`));
    expect(detail.currentVersion).toBe(version + 1);
    version = detail.currentVersion;
  });

  it('6. generates a note from the transcript and replays its stream', async () => {
    const templates = await json(await api('/api/note-templates'));
    const template = templates.items[0];

    const created = await json(
      await api('/api/notes', {
        method: 'POST',
        json: { templateId: template.id, source: { type: 'transcript', transcriptId } },
      }),
      201,
    );
    noteId = created.note?.id ?? created.id;
    expect(noteId).toBeTruthy();

    await drain();

    const note = await json(await api(`/api/notes/${noteId}`));
    expect(note.status).toBe('ready');
    expect(note.body).toBe(NOTE_BODY);

    const stream = await api(`/api/notes/${noteId}/stream`, { headers: { accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);
    const frames = await stream.text();
    expect(frames).toContain('event: delta');
    expect(frames).toContain('event: done');
    expect(frames.indexOf('event: delta')).toBeLessThan(frames.indexOf('event: done'));
  });

  it('7. finds the note by search, on full text, saying why meaning is off', async () => {
    await drain();

    const result = await json(await api('/api/search?q=zebracorn'));
    expect(result.semantic).toBe(false);
    expect(['embeddings_unavailable', 'ai_not_configured']).toContain(result.semanticReason);
    expect(result.results.map((hit: { type: string; id: string }) => `${hit.type}:${hit.id}`)).toEqual(
      expect.arrayContaining([`note:${noteId}`, `transcript:${transcriptId}`]),
    );
    const states = await host.prisma.$queryRaw<Array<{ document_type: string; status: string; reason: string | null }>>`
      SELECT document_type, status::text AS status, reason FROM search_index_state ORDER BY document_type`;
    // The two `search.index` jobs ran and, with no embeddings model, recorded why nothing was embedded.
    expect(states).toEqual([
      { document_type: 'note', status: 'skipped', reason: 'embedding_unsupported' },
      { document_type: 'transcript', status: 'skipped', reason: 'embedding_unsupported' },
    ]);
  });

  it('8. exports the transcript as Markdown', async () => {
    const created = await json(
      await api(`/api/transcripts/${transcriptId}/exports`, { method: 'POST', json: { format: 'markdown' } }),
      202,
    );
    await drain();

    const done = await json(await api(`/api/transcripts/${transcriptId}/exports/${created.id}`));
    expect(done.status).toBe('ready');
    const download = await fetch(done.downloadUrl);
    expect(download.status).toBe(200);
    const markdown = await download.text();
    expect(markdown).toContain('Every port is a small local implementation.');
    expect(markdown).toContain('corrected zebracorn');
  });

  it('9. deletes the note and the transcript, and the rows and the files are gone', async () => {
    expect((await api(`/api/notes/${noteId}`, { method: 'DELETE' })).status).toBe(204);
    await drain();
    expect((await api(`/api/transcripts/${transcriptId}`, { method: 'DELETE' })).status).toBe(204);
    await drain();

    expect(await host.prisma.note.count()).toBe(0);
    expect(await host.prisma.transcript.count()).toBe(0);
    expect(await host.prisma.storageObject.count({ where: { id: objectId } })).toBe(0);
    const leftovers = existsSync(host.objectStore.objectFolder)
      ? readdirSync(host.objectStore.objectFolder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(leftovers.map((entry) => entry.name)).toEqual([]);
    expect((await api(`/api/transcripts/${transcriptId}`)).status).toBe(404);
  });
});
