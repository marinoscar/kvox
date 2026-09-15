/**
 * `2026-09-15 18:02:11 UTC` — an absolute timestamp, in UTC, for a server fact.
 *
 * Issue #126, epic #118. The About page states when this deployment was
 * installed, last updated, and started, and the owner asked for those in UTC
 * rather than the browser's zone: a server fact should read the same on every
 * screen, and "installed at 09:15" is a different claim in London than in
 * Sydney. This is the ONE helper that page renders a timestamp through — no
 * `toLocaleString()` anywhere on it — so the format cannot drift row by row.
 *
 * Hand-assembled from the `getUTC*` accessors rather than `Intl.DateTimeFormat`
 * with `timeZone: 'UTC'`: the output is a fixed, sortable, ISO-shaped string
 * that an operator will paste into a terminal or a ticket, and locale-sensitive
 * formatting (month names, 12-hour clocks, the day/month order) is exactly what
 * that use rules out. The pattern is deliberately `YYYY-MM-DD HH:mm:ss UTC`,
 * with a space rather than a `T` and the zone spelled out, because it is read
 * by a person first and a machine never.
 *
 * Falls back to the input string on an unparseable value rather than rendering
 * `NaN-NaN-NaN`, the same convention `formatRelativeTime` follows: a timestamp
 * this code cannot read is still information, and `Invalid Date` on an About
 * page looks like the deployment is broken.
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * @param iso an ISO-8601 timestamp — `Z`-suffixed as the CLI and the API write
 *        them, but any offset is accepted and normalised to UTC.
 */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

  return `${day} ${time} UTC`;
}
