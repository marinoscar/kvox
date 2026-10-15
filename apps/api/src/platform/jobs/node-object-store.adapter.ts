import { Inject, Injectable } from '@nestjs/common';
import type {
  NodeObjectStore,
  SignedPutUrlOptions,
  SignedUrlOptions,
} from '@marinoscar/platform-api/nodes';

import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';

/**
 * The node data plane's `NODE_OBJECT_STORE` over this app's CURRENT storage
 * provider.
 *
 * PLATFORM-ADOPTION-SHIM(2.2): the platform storage slice (issue #469) owns the
 * object store, and switches this binding to the platform's
 * `nodeObjectStoreBinding`. Until then the data plane signs URLs through the
 * provider this app already runs. Delete the file with that switch.
 *
 * A signed URL is a bearer capability: never log one.
 */
@Injectable()
export class NodeObjectStoreAdapter implements NodeObjectStore {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return this.storage.getSignedDownloadUrl(key, options);
  }

  getSignedPutUrl(key: string, options?: SignedPutUrlOptions): Promise<string> {
    return this.storage.getSignedPutUrl(key, options);
  }
}
