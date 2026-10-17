import { server } from './msw-compat.js';

/**
 * Counts the entity searches a test made (`GET /api/graph/entities`), from the
 * moment of the call. Call it inside the test, before rendering.
 *
 * @returns A function giving the URLs asked so far.
 */
export function graphSearchRequests(): () => URL[] {
  const seen: URL[] = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/graph/entities')) seen.push(url);
  });
  return () => seen;
}
