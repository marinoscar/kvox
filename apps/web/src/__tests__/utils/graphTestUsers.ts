/**
 * Users for the knowledge-graph suites (#373).
 *
 * `graph:read`/`graph:write` are seeded to all three roles, but the shared
 * `mockAdminUser` fixture predates them — adding them there would make every
 * suite that renders Home or a transcript start asking the graph for data.
 * So the graph suites opt in explicitly.
 */

import { mockAdminUser, mockUser } from './test-utils';
import type { MockUser } from './test-utils';

export const graphWriter: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};

export const graphReader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'transcripts:read', 'notes:read', 'graph:read'],
};

export const noGraphUser: MockUser = mockAdminUser;
