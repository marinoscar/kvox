// =============================================================================
// Keyset cursors for the graph read routes (#370)
// =============================================================================
//
// base64url JSON `{ v: 1, r: <route>, k: <sort key>, id }`. A keyset cursor
// names the LAST row of the previous page by its sort key and id, so a row
// inserted between two page loads never shifts the next page (the reason these
// lists are not offset-paged).
//
// THIS CURSOR REFUSES, like `search-cursor.ts`: a malformed cursor, a cursor
// of another version, or one minted by a different route (the entity list
// sorted by `updated` vs by `viewed`, the timeline, the mentions list) is a
// `GraphCursorError`, which every caller maps to a 400. Silently restarting at
// page 1 would hand a client the same rows under a "next page" it asked for.
// =============================================================================

export const GRAPH_CURSOR_VERSION = 1;

/** Every paged graph read, one discriminator each. */
export type GraphCursorRoute = 'entities:updated' | 'entities:viewed' | 'timeline' | 'mentions';

const ROUTES: ReadonlySet<string> = new Set<GraphCursorRoute>([
  'entities:updated',
  'entities:viewed',
  'timeline',
  'mentions',
]);

/** The position a cursor names: the previous page's last sort key and id. */
export interface GraphCursorPosition {
  /** An ISO timestamp, or `null` for a NULLS LAST tail. */
  k: string | null;
  id: string;
}

interface GraphCursorPayload extends GraphCursorPosition {
  v: number;
  r: GraphCursorRoute;
}

export class GraphCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphCursorError';
  }
}

const UNREADABLE = 'This cursor is not readable. Reload the list from the start.';

export function encodeGraphCursor(route: GraphCursorRoute, position: GraphCursorPosition): string {
  const payload: GraphCursorPayload = { v: GRAPH_CURSOR_VERSION, r: route, k: position.k, id: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The position, or a `GraphCursorError` for anything that is not this route's own cursor. */
export function decodeGraphCursor(cursor: string, route: GraphCursorRoute): GraphCursorPosition {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new GraphCursorError(UNREADABLE);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GraphCursorError(UNREADABLE);
  }

  const p = payload as Record<string, unknown>;
  if (p.v !== GRAPH_CURSOR_VERSION) throw new GraphCursorError(UNREADABLE);
  if (typeof p.r !== 'string' || !ROUTES.has(p.r)) throw new GraphCursorError(UNREADABLE);
  if (p.r !== route) {
    throw new GraphCursorError('This cursor belongs to a different list. Reload the list from the start.');
  }
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 200) throw new GraphCursorError(UNREADABLE);
  if (p.k !== null && (typeof p.k !== 'string' || Number.isNaN(Date.parse(p.k)))) {
    throw new GraphCursorError(UNREADABLE);
  }

  return { k: p.k as string | null, id: p.id };
}
