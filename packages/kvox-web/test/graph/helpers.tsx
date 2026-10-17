/**
 * Shared test kit of the graph slice: the host-mounting `render` and `renderHook`
 * (over the fake host, with the handlers registered through `server.use`), the
 * viewer fixtures and the viewport helper, in one import.
 */

import { beforeEach } from 'vitest';

import { graphHandlers } from './handlers.js';
import { server } from './msw-compat.js';

export {
  render,
  renderHook,
  makeHost,
  mockAdminUser,
  mockUser,
} from '../notes/helpers.js';
export type { MockUser, RenderOptions } from '../notes/helpers.js';
export { server, http, HttpResponse } from './msw-compat.js';

// The default answers of every graph suite; a test overrides one with `server.use`.
beforeEach(() => {
  server.use(...graphHandlers);
});
