import { Test } from '@nestjs/testing';

import { KVOX_OBJECT_STORE, KvoxObjectMissingError } from '../../src/ports/index.js';
import { createInMemoryKvoxObjectStore } from '../../src/testing/index.js';
import { TRANSCRIPTS_MANAGED_BY } from '../../src/transcripts/job-types.js';
import { TRANSCRIPTS_MODULE_OPTIONS, resolveTranscriptsOptions } from '../../src/transcripts/transcripts.options.js';
import {
  MissingUploadedObjectError,
  TranscriptObjectsService,
} from '../../src/transcripts/transcript-objects.service.js';

// =============================================================================
// `recordUploaded` — recording bytes this process never held (issue #26)
// =============================================================================
//
// The method exists for one case `put` structurally cannot serve: a worker
// node PUTs the playback rendition straight to a presigned URL, so the API
// server never sees a byte of it and there is nothing to hand `put`.
//
// Two properties, and both of them are about what happens when something has
// already gone wrong elsewhere:
//
//   • THE READ-BACK CHECK. A node whose upload silently failed would otherwise
//     leave `playback_object_id` aimed at an empty key and a transcript whose
//     audio element plays nothing. The object-store port's `adopt` makes the check
//     (and the in-memory store throws `KvoxObjectMissingError` for a key nothing
//     landed under); the service reports it as `MissingUploadedObjectError`.
//   • IDEMPOTENCE ON THE KEY. The queue is at-least-once and the rendition's
//     key is a pure function of the job, so a retry after a committed record
//     arrives here with a key that already has a row.
// =============================================================================

async function build() {
  const store = createInMemoryKvoxObjectStore();
  const module = await Test.createTestingModule({
    providers: [
      TranscriptObjectsService,
      { provide: KVOX_OBJECT_STORE, useValue: store },
      { provide: TRANSCRIPTS_MODULE_OPTIONS, useValue: resolveTranscriptsOptions({}) },
    ],
  }).compile();

  return { store, service: module.get(TranscriptObjectsService) };
}

describe('TranscriptObjectsService.recordUploaded', () => {
  const input = {
    storageKey: 'transcripts/t-1/renditions/j-1.m4a',
    name: 'playback.m4a',
    mimeType: 'audio/mp4',
    size: 512_000,
    ownerId: 'user-1',
    metadata: { transcriptId: 't-1' },
  };

  it('checks the bytes really landed, then records them as a MANAGED object', async () => {
    const { store, service } = await build();

    store.landBytes(input.storageKey, Buffer.alloc(8));

    const recorded = await service.recordUploaded(input);

    expect(recorded.size).toBe(512_000);

    // Recorded as a `transcripts`-owned object: the host writes the ownership marker with
    // the row, so the object is absent from the generic file list and undeletable through
    // the generic DELETE — the ownership boundary a transcript's files need.
    expect(store.objects.get(recorded.id)).toMatchObject({
      key: input.storageKey,
      managedBy: TRANSCRIPTS_MANAGED_BY,
      mimeType: 'audio/mp4',
      ownerId: 'user-1',
      name: 'playback.m4a',
      metadata: { transcriptId: 't-1' },
    });
  });

  it('refuses a key that holds nothing, with a message naming the key', async () => {
    const { service } = await build();

    await expect(service.recordUploaded(input)).rejects.toThrow(MissingUploadedObjectError);
    await expect(service.recordUploaded(input)).rejects.toThrow(input.storageKey);
  });

  it('translates the port\'s missing-object error, and no other', async () => {
    const { store, service } = await build();

    jest.spyOn(store, 'adopt').mockRejectedValueOnce(new KvoxObjectMissingError(input.storageKey));
    await expect(service.recordUploaded(input)).rejects.toBeInstanceOf(MissingUploadedObjectError);

    jest.spyOn(store, 'adopt').mockRejectedValueOnce(new Error('boom'));
    await expect(service.recordUploaded(input)).rejects.toThrow('boom');
  });

  it('reuses the existing object for a key already recorded, creating no duplicate', async () => {
    const { store, service } = await build();

    store.landBytes(input.storageKey, Buffer.alloc(8));

    const first = await service.recordUploaded(input);
    const second = await service.recordUploaded(input);

    expect(second.id).toBe(first.id);
    expect(store.objects.size).toBe(1);
  });

  it('stores bytes with `put`, which records them in the same call', async () => {
    const { store, service } = await build();

    const stored = await service.put({
      storageKey: 'transcripts/t-1/raw/x.json.gz',
      name: 'x.json.gz',
      mimeType: 'application/gzip',
      body: Buffer.from('hello'),
      ownerId: 'user-1',
    });

    expect(stored.size).toBe(5);
    expect(store.objects.get(stored.id)).toMatchObject({ managedBy: TRANSCRIPTS_MANAGED_BY, name: 'x.json.gz' });
  });
});

describe('TranscriptObjectsService.putStream', () => {
  it('meters the size as the bytes pass and settles with the recorded object', async () => {
    const { store, service } = await build();

    const { body, done } = service.putStream({
      storageKey: 'transcripts/t-1/exports/e-1.md',
      name: 'e.md',
      mimeType: 'text/markdown',
      ownerId: 'user-1',
    });

    body.end('# a title');

    const object = await done;

    expect(object.size).toBe(9);
    expect(store.objects.get(object.id)?.bytes.toString()).toBe('# a title');
  });
});

describe('TranscriptObjectsService.signedUrlFor', () => {
  it('answers null for an object that is gone or not ready, and a URL for a ready one', async () => {
    const { store, service } = await build();

    await expect(service.signedUrlFor('missing', 60)).resolves.toBeNull();

    const stored = await store.put({
      ownerId: 'u',
      key: 'k',
      body: Buffer.from('abc'),
      contentType: 'audio/mp4',
      managedBy: TRANSCRIPTS_MANAGED_BY,
    });
    const signed = await service.signedUrlFor(stored.objectId, 60, 'a b.m4a');

    expect(signed?.url).toContain(stored.objectId);
    expect(signed?.url).toContain('filename=a%20b.m4a');
    expect(signed?.object).toEqual({ mimeType: 'audio/mp4', size: 3 });
  });
});

// =============================================================================
// `deleteIfPresent` — purge is re-entrant, so a delete that fails must not
// blow up the caller (issue #101's abort-before-delete can surface a fresh
// kind of failure here: a non-NoSuchUpload abort error rethrown by the host's delete).
// =============================================================================
describe('TranscriptObjectsService.deleteIfPresent', () => {
  it('returns false, and does not throw, when the underlying delete rejects', async () => {
    const { store, service } = await build();

    const stored = await store.put({
      ownerId: 'u',
      key: 'k',
      body: Buffer.from('abc'),
      contentType: 'audio/mp4',
      managedBy: TRANSCRIPTS_MANAGED_BY,
    });
    jest.spyOn(store, 'delete').mockRejectedValue(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    );

    await expect(service.deleteIfPresent(stored.objectId)).resolves.toBe(false);
    expect(store.delete).toHaveBeenCalledWith(stored.objectId);
  });

  it('returns true when the delete succeeds, and false for an object that is already gone', async () => {
    const { store, service } = await build();

    const stored = await store.put({
      ownerId: 'u',
      key: 'k',
      body: Buffer.from('abc'),
      contentType: 'audio/mp4',
      managedBy: TRANSCRIPTS_MANAGED_BY,
    });

    await expect(service.deleteIfPresent(stored.objectId)).resolves.toBe(true);
    await expect(service.deleteIfPresent(stored.objectId)).resolves.toBe(false);
  });

  it('returns false without calling the delete at all for a null/undefined id', async () => {
    const { store, service } = await build();
    const spy = jest.spyOn(store, 'delete');

    await expect(service.deleteIfPresent(null)).resolves.toBe(false);
    await expect(service.deleteIfPresent(undefined)).resolves.toBe(false);

    expect(spy).not.toHaveBeenCalled();
  });
});
