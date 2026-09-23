import { StorageObject } from '@prisma/client';

/**
 * A MANAGED object's multipart upload was aborted by its uploader (issue #322).
 *
 * Emitted by `ObjectsService.abortUpload` INSTEAD of deleting the row, and only
 * for an object whose `managedBy` is set. The generic storage layer cannot
 * delete a managed object: the owning module's table points at it with a
 * `Restrict` foreign key (`transcripts.source_object_id`, for one), so the
 * delete would fail and the client's cancel with it. The row is marked `failed`
 * instead, and the module named by `managedBy` listens for this event and
 * reconciles its own record — which, for a transcript, means soft-deleting it
 * and queueing `transcript.purge`, the one path allowed to free the object.
 *
 * Unmanaged objects never emit this; their abort still deletes the row.
 */
export class ObjectUploadAbortedEvent {
  constructor(public readonly object: StorageObject) {}

  get objectId(): string {
    return this.object.id;
  }

  /** The owning module. Never null — unmanaged aborts do not emit this event. */
  get managedBy(): string | null {
    return this.object.managedBy;
  }

  get uploadedById(): string | null {
    return this.object.uploadedById;
  }

  get storageKey(): string {
    return this.object.storageKey;
  }

  get name(): string {
    return this.object.name;
  }
}

export const OBJECT_UPLOAD_ABORTED_EVENT = 'storage.object.upload_aborted';
