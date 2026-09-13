// =============================================================================
// The three ways a job's input can be missing (issue #269, epic #254)
// =============================================================================
//
// THIS SUITE EXISTS TO KEEP ONE SPECIFIC ERROR MESSAGE FROM COMING BACK:
//
//     Error: ENOENT: no such file or directory, open ''
//
// That is how the application this design was extracted from reported a job
// whose input could not be resolved — for all three causes, identically,
// naming nothing. `storage-job-input.ts`'s header tells the story; these
// assertions are what stop it recurring, and they are deliberately
// unglamorous: each case sabotages exactly one precondition against an
// otherwise perfectly resolvable job, so a regression names which one broke.
//
// The `reason` codes are asserted as well as the throw, because the reason is
// what `NodeDataPlaneService` puts in `details.reason` for a node to act on
// and what a person reads in `Job.lastError`. A resolver that threw the right
// exception with the wrong code would leave both consumers guessing.
// =============================================================================

import { Job, StorageObject } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import {
  JobInputResolutionError,
  resolveStorageObjectInput,
  STORAGE_OBJECT_SUBJECT_TYPE,
} from './storage-job-input';

describe('resolveStorageObjectInput', () => {
  let prisma: MockPrismaService;

  const OBJECT_ID = 'object-1';

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: 'job-1',
      type: 'example.checksum',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: OBJECT_ID,
      ...overrides,
    } as Job;
  }

  function makeObject(overrides: Partial<StorageObject> = {}): StorageObject {
    return {
      id: OBJECT_ID,
      name: 'invoice.pdf',
      size: BigInt(12),
      mimeType: 'application/pdf',
      storageKey: 'uploads/1/abc.pdf',
      storageProvider: 's3',
      bucket: 'test-bucket',
      status: 'ready',
      s3UploadId: null,
      metadata: null,
      uploadedById: 'someone-else',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as StorageObject;
  }

  const resolve = (job: Job) =>
    resolveStorageObjectInput(prisma as unknown as PrismaService, job);

  beforeEach(() => {
    prisma = createMockPrismaService();
  });

  it('returns the object when the job names one that exists and has a key', async () => {
    const object = makeObject();
    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(object);

    await expect(resolve(makeJob())).resolves.toBe(object);
    expect(prisma.storageObject.findUnique).toHaveBeenCalledWith({
      where: { id: OBJECT_ID },
    });
  });

  it('throws `missing_subject_id`, without querying, when the job names no subject', async () => {
    // The cheapest of the three to get wrong and the most common in practice:
    // a job enqueued without `subjectId`. Asserting that NOTHING is queried
    // matters — a resolver that passed `undefined` to `findUnique` would ask
    // Prisma for "the object with id undefined", which is an argument error
    // several layers from the actual mistake.
    await expect(resolve(makeJob({ subjectId: null }))).rejects.toMatchObject({
      reason: 'missing_subject_id',
    });

    expect(prisma.storageObject.findUnique).not.toHaveBeenCalled();
  });

  it('throws `input_object_not_found` when the subject names no row', async () => {
    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(resolve(makeJob())).rejects.toMatchObject({
      reason: 'input_object_not_found',
      subjectId: OBJECT_ID,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('throws `input_object_has_no_storage_key` when the key is %s', async (_label, storageKey) => {
    // The exact shape that produced `open ''`. The column is non-nullable, so
    // this is a data possibility rather than a type-system one — which is
    // precisely why it is checked and why it is tested.
    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
      makeObject({ storageKey })
    );

    await expect(resolve(makeJob())).rejects.toMatchObject({
      reason: 'input_object_has_no_storage_key',
    });
  });

  it('names the job, the type and the subject in every message', async () => {
    // The whole point of the rewrite: a message somebody can act on without
    // opening a database client. Asserted for all three reasons at once so a
    // new failure mode added later without a usable message is caught here.
    const cases: Array<[Job, StorageObject | null, string[]]> = [
      [makeJob({ subjectId: null }), null, ['job-1', 'example.checksum', 'subjectId']],
      [makeJob(), null, ['job-1', OBJECT_ID, 'does not exist']],
      [makeJob(), makeObject({ storageKey: '' }), ['job-1', OBJECT_ID, 'storageKey']],
    ];

    for (const [job, object, fragments] of cases) {
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(object);

      const error = await resolve(job).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(JobInputResolutionError);
      for (const fragment of fragments) {
        expect((error as Error).message).toContain(fragment);
      }
      // Never the empty-path failure this file exists to prevent.
      expect((error as Error).message).not.toMatch(/open ''/);
    }
  });

  it('does NOT check `subjectType`, so a fork may name its own', async () => {
    // Deliberate: a subject type is a label, and refusing work over a label
    // would break a fork that calls the same row something else. What the
    // resolver checks is what it needs — an id, a row, and a key.
    const object = makeObject();
    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(object);

    await expect(resolve(makeJob({ subjectType: 'my-fork.document' }))).resolves.toBe(
      object
    );
  });
});
