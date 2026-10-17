/**
 * Shared test kit of the ask slice: the graph kit (host-mounting `render` and
 * `renderHook` over the fake host, the viewers, the graph handlers the
 * citation chips and the entity page read) plus the Ask handlers.
 */

import { beforeEach } from 'vitest';

import { askHandlers } from './handlers.js';
import { server } from '../graph/msw-compat.js';

export {
  render,
  renderHook,
  makeHost,
  mockAdminUser,
  mockUser,
  server,
  http,
  HttpResponse,
} from '../graph/helpers.js';
export type { MockUser, RenderOptions } from '../graph/helpers.js';

// The default answers of every ask suite; a test overrides one with `server.use`.
beforeEach(() => {
  server.use(...askHandlers);
});
