import { Navigate, useLocation } from 'react-router-dom';

/**
 * `/graph/overview` → `/graph`, keeping the query string and the hash (#782).
 *
 * @remarks
 * The whole-graph overview became the knowledge landing at `/graph`; its old
 * address stays reachable for bookmarks and links, so `?layer=`, `?cluster=`
 * and `?view=list` survive the hop. A route's `redirectTo` is only the
 * permission fallback, and a plain `<Navigate to="/graph">` drops the search,
 * hence this component. It replaces the history entry, so Back does not land
 * on the redirect.
 *
 * @stability experimental
 */
export function GraphOverviewRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/graph', search, hash }} replace />;
}
