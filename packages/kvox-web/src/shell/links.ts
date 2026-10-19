import type { KvoxLinks } from '../core/headless/index.js';

/**
 * The in-app links the packaged pages build, for the route table
 * {@link renderKvoxRoutes} serves: a transcript at `/transcripts/:id`, a note at
 * `/notes/:id`, a graph entity at `/graph/entities/:id` and an Ask conversation at
 * `/ask/:id`.
 *
 * @remarks
 * Hand it to the host binding's `links` (`KvoxWebHost.links`). A host that serves
 * the slices under other paths writes its own `KvoxLinks`; both hosts today (KVox
 * web and KVox Desktop) serve these.
 *
 * @stability experimental
 */
export const defaultKvoxLinks: KvoxLinks = {
  transcript: (id) => `/transcripts/${id}`,
  note: (id) => `/notes/${id}`,
  entity: (id) => `/graph/entities/${id}`,
  conversation: (id) => `/ask/${id}`,
};
