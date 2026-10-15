import { Injectable } from '@nestjs/common';
import type { PrismaClient, StorageObject } from '@prisma/client';
import { NodeJobInputError } from '@marinoscar/platform-api/nodes';
import type { NodeJobInputObject, NodeJobInputs } from '@marinoscar/platform-api/nodes';
import { JobScope } from '@marinoscar/platform-api/jobs';
import type { Job } from '@marinoscar/platform-api/jobs';

import {
  JobInputResolutionError,
  resolveStorageObjectInput,
} from '../../storage/storage-job-input';

/**
 * The node data plane's `NODE_JOB_INPUTS`: which stored object a held job reads.
 *
 * Both node-eligible job types (`media.audio.transcode`, `note.source.extract`)
 * name a `storage_objects` row as their subject, so the resolution is the one
 * the handlers themselves use (`resolveStorageObjectInput`), run in the job's
 * organization scope. A job that names no usable object is a permanent failure:
 * the three reasons map one to one onto the platform's `NodeJobInputError`, and
 * the data plane answers 422 with `details.reason` as before.
 */
@Injectable()
export class NodeJobInputsAdapter implements NodeJobInputs {
  constructor(private readonly scope: JobScope) {}

  async resolve(job: Job): Promise<NodeJobInputObject> {
    try {
      const object = await this.scope.run<StorageObject, Pick<PrismaClient, 'storageObject'>>(
        job,
        (tx) => resolveStorageObjectInput(tx, job),
      );
      return {
        id: object.id,
        storageKey: object.storageKey,
        size: object.size,
        mimeType: object.mimeType,
      };
    } catch (error) {
      if (error instanceof JobInputResolutionError) {
        throw new NodeJobInputError(error.reason, error.message, error.jobId, error.subjectId);
      }
      throw error;
    }
  }
}
