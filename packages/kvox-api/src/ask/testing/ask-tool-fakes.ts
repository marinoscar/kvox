// =============================================================================
// Shared fakes for the Ask tool specs (#377; moved into the package by #497)
// =============================================================================

import type { GraphActor } from '../../graph/index.js';
import type { AskToolContext } from '../tools/ask-tool.js';
import { HandleRegistry } from '../tools/handle-registry.js';

/**
 * Any RFC 4122-shaped uuid, anywhere in a string.
 *
 * @stability experimental
 */
export const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A deterministic uuid: `uid(7)` is `00000000-0000-4000-8000-000000000007`.
 *
 * @param n - the number the uuid ends with.
 * @returns the uuid.
 * @stability experimental
 */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** The owner every fake context is for. @stability experimental */
export const OWNER_ID = uid(0xaa);

/**
 * The asker, with the permissions the tools consult.
 *
 * @param over - fields to change.
 * @returns the actor.
 * @stability experimental
 */
export function makeUser(over: Partial<GraphActor> = {}): GraphActor {
  return {
    id: OWNER_ID,
    permissions: ['graph:read', 'transcripts:read', 'notes:read'],
    ...over,
  };
}

/**
 * A tool context for one turn.
 *
 * @param over - fields to change.
 * @returns the context.
 * @stability experimental
 */
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

/**
 * Registers an entity the way an earlier `search` would have.
 *
 * @param ctx - the turn's context.
 * @param id - the entity id.
 * @param label - its label.
 * @returns the handle.
 * @stability experimental
 */
export function seedEntity(ctx: AskToolContext, id: string, label = 'Acme'): string {
  return ctx.handles.register({ kind: 'ent', id, label });
}

/**
 * Asserts a tool's serialised output carries no uuid at all.
 *
 * @param value - the output (a string or anything JSON-serialisable).
 * @throws Error naming the uuid found.
 * @stability experimental
 */
export function expectNoUuid(value: unknown): void {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const found = UUID_ANYWHERE.exec(json);

  if (found) throw new Error(`Expected no uuid in the tool output, found ${found[0]}`);
}
