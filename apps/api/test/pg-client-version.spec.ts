import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MIN_PG_CLIENT_MAJOR } from '@marinoscar/platform-api/db-backup/testing';

// =============================================================================
// The PostgreSQL client major in the API image
// =============================================================================
// (issue #280, epic #254; reworked in #471 when the backup stack became the platform's)
//
// `apps/api/Dockerfile` installs `postgresql<N>-client`: that is `pg_dump` and
// `pg_restore` for the database backup, which the platform's db-backup slice
// spawns. The slice refuses to dump with a client older than its
// `MIN_PG_CLIENT_MAJOR` (the platform's floor, not this app's pin), and `pg_dump`
// refuses a server newer than itself. So the image must carry one explicit major
// that is AT LEAST that floor.
//
// What this app owns is the Dockerfile line, so that is what is asserted: a single,
// explicitly pinned major, in the base stage, never the floating meta-package.
// The pin is not compared for equality with the platform floor on purpose: this
// image may run a newer client than the floor (and does), and a platform bump of the
// floor must fail HERE, loudly, rather than as a refused backup at 02:00.
//
// Modelled on `production-image.spec.ts`, which guards the same class of
// failure one layer down: a Dockerfile whose contents nothing else verifies.
// =============================================================================

const apiRoot = resolve(__dirname, '..');
const dockerfile = readFileSync(resolve(apiRoot, 'Dockerfile'), 'utf8');

/**
 * The Dockerfile's INSTRUCTIONS, with its comments removed.
 *
 * Necessary rather than tidy: the comment above the `apk add` explains the pin
 * by naming both `postgresql<N>-client` and the floating `postgresql-client`
 * meta-package it exists to avoid. Matching over the raw text would count the
 * prose as a second pin and read the warning as the mistake it warns about -
 * so the file would have to choose between being explained and being checked.
 */
const instructions = dockerfile
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** Everything from `AS base` up to the next stage; later stages inherit it. */
function baseStage(text: string): string {
  const start = text.indexOf('AS base');
  expect(start).toBeGreaterThan(-1);

  const rest = text.slice(start);
  const nextStage = rest.indexOf('\nFROM ');

  return nextStage === -1 ? rest : rest.slice(0, nextStage);
}

/** Every explicitly-pinned client package named anywhere in the Dockerfile. */
function pinnedClientMajors(text: string): number[] {
  return [...text.matchAll(/postgresql(\d+)-client\b/g)].map((match) =>
    Number.parseInt(match[1], 10)
  );
}

describe('the pinned PostgreSQL client major', () => {
  it('is one explicit major, at least the platform backup floor (MIN_PG_CLIENT_MAJOR)', () => {
    const majors = pinnedClientMajors(instructions);

    expect(majors).toHaveLength(1);
    expect(majors[0]).toBeGreaterThanOrEqual(MIN_PG_CLIENT_MAJOR);
  });

  it('is installed in the base stage, which every other stage inherits', () => {
    // Production is `FROM base` and so is development. Installing the client
    // only in production would leave `npm run start:dev` unable to take a
    // backup - so the feature would be exercised for the first time in
    // production, by a scheduled job, at 02:00.
    expect(pinnedClientMajors(baseStage(instructions))).toEqual(pinnedClientMajors(instructions));
  });

  it('never uses the floating postgresql-client meta-package', () => {
    // The meta-package tracks whatever major the Alpine release underneath
    // node:24-alpine happens to ship, so a base-image refresh - which nobody
    // reviews as a database change - can move the client without a line of
    // this repository changing. pg_dump refuses to dump a server newer than
    // itself, and the server here is external and upgraded separately.
    const floating = /postgresql-client\b/.exec(instructions);

    expect(floating).toBeNull();
  });

  it('installs it with the same --no-cache apk invocation as everything else', () => {
    // Not style: without --no-cache the apk index stays in the image, and this
    // package lands in the BASE layer that every stage - production included -
    // inherits.
    const [major] = pinnedClientMajors(instructions);
    const install = new RegExp(String.raw`RUN apk add --no-cache [^\n]*postgresql${major}-client`);

    expect(install.test(instructions)).toBe(true);
  });
});
