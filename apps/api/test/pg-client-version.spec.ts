import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MIN_PG_CLIENT_MAJOR } from '../src/db-backup/pg-version.util';

// =============================================================================
// The PostgreSQL client major is ONE decision written in TWO files
// =============================================================================
// (issue #280, epic #254)
//
// `apps/api/Dockerfile` installs `postgresql<N>-client`; `MIN_PG_CLIENT_MAJOR`
// in `src/db-backup/pg-version.util.ts` is what the backup believes that N is,
// and what its error messages tell an operator to install. Nothing at runtime
// connects the two - the constant is never compared against the binary that is
// actually on the PATH - so if they drift, everything still compiles, every
// other test still passes, and the version guard starts giving advice that is
// wrong about the image it is running in.
//
// The people involved make that drift likely rather than exotic: the Dockerfile
// line gets bumped by whoever is fixing an image or chasing a CVE, and the
// constant gets read by whoever is debugging a failed backup months later.
// This test is the only thing that brings those two people together, which is
// why it asserts the RULE (a single, explicitly pinned major, in the base
// stage, equal to the constant) rather than the current number.
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
  it('matches MIN_PG_CLIENT_MAJOR exactly', () => {
    const majors = pinnedClientMajors(instructions);

    // Listed rather than looped so a failure prints the number that is
    // actually in the Dockerfile next to the one the code believes.
    expect(majors).toEqual([MIN_PG_CLIENT_MAJOR]);
  });

  it('is installed in the base stage, which every other stage inherits', () => {
    // Production is `FROM base` and so is development. Installing the client
    // only in production would leave `npm run start:dev` unable to take a
    // backup - so the feature would be exercised for the first time in
    // production, by a scheduled job, at 02:00.
    expect(pinnedClientMajors(baseStage(instructions))).toEqual([MIN_PG_CLIENT_MAJOR]);
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
    const install = new RegExp(
      String.raw`RUN apk add --no-cache [^\n]*postgresql${MIN_PG_CLIENT_MAJOR}-client`
    );

    expect(install.test(instructions)).toBe(true);
  });
});
