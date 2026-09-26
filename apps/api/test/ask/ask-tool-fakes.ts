// =============================================================================
// Shared fakes for the Ask tool specs (#377)
// =============================================================================

import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { AskToolContext } from '../../src/ask/tools/ask-tool';
import { HandleRegistry } from '../../src/ask/tools/handle-registry';

/** Any RFC 4122-shaped uuid, anywhere in a string. */
export const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A deterministic uuid: `uid(7)` → `00000000-0000-4000-8000-000000000007`. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const OWNER_ID = uid(0xaa);

export function makeUser(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: OWNER_ID,
    email: 'owner@example.test',
    roles: ['Viewer'],
    permissions: ['graph:read', 'transcripts:read', 'notes:read'],
    isActive: true,
    ...over,
  };
}

export function makeCtx(over: Partial<AskToolContext> = {}): AskToolContext {
  return {
    user: makeUser(),
    handles: new HandleRegistry(),
    personalFactsAllowed: false,
    scopeEntityId: null,
    now: new Date('2026-09-26T12:00:00.000Z'),
    ...over,
  };
}

/** Register an entity the way an earlier `search` would have, returning its handle. */
export function seedEntity(ctx: AskToolContext, id: string, label = 'Acme'): string {
  return ctx.handles.register({ kind: 'ent', id, label });
}

/** Assert a tool's serialised output carries no uuid at all. */
export function expectNoUuid(value: unknown): void {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  expect(json).not.toMatch(UUID_ANYWHERE);
}
