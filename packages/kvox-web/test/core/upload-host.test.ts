import { describe, expect, it } from 'vitest';

import { createResumableUpload, startUpload } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';

const PART_SIZE = 10;

function partsFor(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    partNumber: index + 1,
    url: `https://s3.example.com/obj/part-${index + 1}?sig=1`,
  }));
}

function hostWith(parts: number) {
  return createFakeKvoxWebHost({
    routes: {
      'GET /storage/objects/:id/upload/parts': Array.from({ length: parts }, (_, index) => ({
        partNumber: index + 1,
        etag: `"e${index + 1}"`,
        size: PART_SIZE,
      })),
      'POST /storage/objects/:id/upload/complete': undefined,
      'DELETE /storage/objects/:id/upload/abort': undefined,
    },
  });
}

describe('the upload engine over a host that has its own part transport', () => {
  it('sends every part through host.upload.putPart and completes', async () => {
    const host = hostWith(3);
    const file = new File([new Uint8Array(PART_SIZE * 3)], 'a.m4a', { type: 'audio/mp4' });
    const upload = startUpload(host, file, {
      objectId: 'obj',
      uploadId: 'u',
      partSize: PART_SIZE,
      totalParts: 3,
      parts: partsFor(3),
    });

    const outcome = await upload.whenSettled();

    expect(outcome.status).toBe('completed');
    expect(host.uploads.map((part) => part.size)).toEqual([10, 10, 10]);
    expect(host.callsTo('POST /storage/objects/obj/upload/complete')).toHaveLength(1);
    expect(upload.getProgress().percent).toBe(100);
  });

  it('retries a part the host refuses with a status, then fails after the attempts', async () => {
    const host = hostWith(1);
    host.upload = {
      putPart: async () => {
        throw Object.assign(new Error('forbidden'), { status: 500 });
      },
    };
    const file = new File([new Uint8Array(PART_SIZE)], 'a.m4a');
    const upload = startUpload(
      host,
      file,
      { objectId: 'obj', uploadId: 'u', partSize: PART_SIZE, totalParts: 1, parts: partsFor(1) },
      { retry: { maxAttempts: 2, baseMs: 1, maxMs: 2 }, runtime: { concurrency: () => 1 } },
    );

    const outcome = await upload.whenSettled();

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/Part 1 failed after 2 attempts/);
  });
});

describe('createResumableUpload', () => {
  it('builds an idle upload that does nothing until started', async () => {
    const host = hostWith(1);
    const file = new File([new Uint8Array(PART_SIZE)], 'a.m4a');
    const upload = createResumableUpload(host, {
      file,
      objectId: 'obj',
      partSize: PART_SIZE,
      totalParts: 1,
      presignedParts: partsFor(1),
    });

    expect(upload.getProgress().phase).toBe('idle');
    expect(host.uploads).toEqual([]);

    upload.start();
    expect((await upload.whenSettled()).status).toBe('completed');
    expect(host.uploads).toHaveLength(1);
  });
});
