// =============================================================================
// Guard: the pgvector Postgres image pin stays in place, and in sync
// (issue #178, epic #165)
// =============================================================================
//
// `CREATE EXTENSION vector` needs the `vector` control file present on the
// SERVER, which plain `postgres:16-alpine` does not carry. Without it, a
// forthcoming semantic-search migration aborts INSIDE `prisma migrate
// deploy` — turning CI (and a developer's `devdb`) red on the migration step
// itself, with a Prisma stack trace instead of a failing test assertion.
//
// Three files were moved together to `pgvector/pgvector:pg16`:
// `infra/compose/test.compose.yml`, `infra/compose/devdb.compose.yml` and
// `.github/workflows/ci.yml`. This spec fails if any ONE of them is reverted
// to a plain postgres image, or if they drift apart from each other (e.g.
// someone bumps only the CI image and forgets the compose files, so CI is
// green but a local `devdb` run is not testing what CI tests).
//
// It also pins the two files that were deliberately left UNCHANGED, so a
// well-meaning "let's just move everything to pgvector for consistency" edit
// gets caught here instead of silently reintroducing an unnecessary pull.
//
// This is a plain unit spec — string/regex reads off disk only, no database,
// no YAML dependency — so it runs under ordinary `npm test`.
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// apps/api/test/integration -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const PGVECTOR_IMAGE = 'pgvector/pgvector:pg16';
const PLAIN_POSTGRES_IMAGE = 'postgres:16-alpine';

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Finds a YAML `<serviceName>:` mapping key at exactly `expectedIndent`
 * leading spaces, then returns the value of the first `image:` line found
 * inside that block (i.e. before a line at or above `expectedIndent`).
 *
 * `expectedIndent` disambiguates a service header from an unrelated key of
 * the same name elsewhere in the file at a different nesting depth — e.g.
 * `otel.compose.yml` has both a top-level `uptrace-pg:` service (indent 2)
 * and a `depends_on: uptrace-pg:` reference to it (indent 6).
 *
 * Deliberately hand-rolled rather than a YAML parser: this repo's testing
 * conventions ask for plain regex/string reads here, not a new dependency.
 */
function extractServiceImage(
  yamlText: string,
  serviceName: string,
  expectedIndent: number,
): string {
  const lines = yamlText.split('\n');
  const headerRegex = new RegExp(`^(\\s*)${serviceName}:\\s*$`);

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = headerRegex.exec(lines[i]);
    if (match && match[1].length === expectedIndent) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) {
    throw new Error(
      `service "${serviceName}" not found at indent ${expectedIndent}`,
    );
  }

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const leading = /^(\s*)/.exec(line)![1].length;
    if (leading <= expectedIndent) break; // left the service's own block

    const imageMatch = /^\s*image:\s*(\S+)\s*$/.exec(line);
    if (imageMatch) return imageMatch[1];
  }

  throw new Error(`no "image:" found inside service "${serviceName}"`);
}

describe('pgvector Postgres image pin (issue #178, epic #165)', () => {
  it('pins infra/compose/test.compose.yml\'s db-test service to pgvector/pgvector:pg16', () => {
    const yaml = readRepoFile('infra/compose/test.compose.yml');
    expect(extractServiceImage(yaml, 'db-test', 2)).toBe(PGVECTOR_IMAGE);
  });

  it('pins infra/compose/devdb.compose.yml\'s db service to pgvector/pgvector:pg16', () => {
    const yaml = readRepoFile('infra/compose/devdb.compose.yml');
    expect(extractServiceImage(yaml, 'db', 2)).toBe(PGVECTOR_IMAGE);
  });

  it('pins .github/workflows/ci.yml\'s postgres service container to pgvector/pgvector:pg16', () => {
    const yaml = readRepoFile('.github/workflows/ci.yml');
    expect(extractServiceImage(yaml, 'postgres', 6)).toBe(PGVECTOR_IMAGE);
  });

  it('keeps the three pins in sync with each other (no partial bump)', () => {
    const testComposeImage = extractServiceImage(
      readRepoFile('infra/compose/test.compose.yml'),
      'db-test',
      2,
    );
    const devdbComposeImage = extractServiceImage(
      readRepoFile('infra/compose/devdb.compose.yml'),
      'db',
      2,
    );
    const ciImage = extractServiceImage(
      readRepoFile('.github/workflows/ci.yml'),
      'postgres',
      6,
    );

    expect(devdbComposeImage).toBe(testComposeImage);
    expect(ciImage).toBe(testComposeImage);
  });

  it('requires .github/workflows/deploy-e2e.yml\'s postgres to carry pgvector, at its own major', () => {
    // A FOURTH PIN, DELIBERATELY NOT PART OF THE THREE-WAY SYNC ABOVE
    // (issue #179, epic #165).
    //
    // The e2e job runs the real `kvox deploy install` pipeline, and
    // `database-vector-extension` is a REQUIRED preflight check — so on a
    // server with no `vector` this job fails at preflight, correctly, before
    // install writes anything. Moving it to pgvector's image (rather than
    // exempting the check for CI) is what makes the job PROVE the check passes
    // against a real server instead of proving it can be bypassed.
    //
    // It is pg17, not the pg16 the three above share, and that is not drift:
    // the three track the PostgreSQL version this application's own migrations
    // and tests run against, while this one tracks the client version baked
    // into the API image (`postgresql17-client`, apps/api/Dockerfile). Pinning
    // it to pg16 would make `prisma migrate` and `pg_dump` in the rehearsed
    // deployment talk to a server of a different major than they were built
    // for — which is the thing that comment was protecting in the first place.
    //
    // So the assertion is deliberately WEAKER than the three-way equality
    // above: it says "pgvector, at the API image's own major", not "this exact
    // string". Asserting the literal would couple this job's major to the
    // other three and re-create the coupling the previous paragraph rules out.
    const yaml = readRepoFile('.github/workflows/deploy-e2e.yml');
    const image = extractServiceImage(yaml, 'postgres', 6);

    expect(image).toMatch(/^pgvector\/pgvector:pg\d+$/);
  });

  it('leaves apps/cli/src/deploy/checks/database.ts\'s PSQL_IMAGE on plain postgres:16-alpine', () => {
    // Deliberately NOT moved: PSQL_IMAGE only runs the `psql` CLIENT binary
    // against a remote server during `kvox deploy doctor` — it never hosts a
    // database of its own, so it has no need for the vector control file.
    const source = readRepoFile('apps/cli/src/deploy/checks/database.ts');
    const match = /const PSQL_IMAGE = '([^']+)';/.exec(source);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(PLAIN_POSTGRES_IMAGE);
  });

  it('leaves infra/compose/otel.compose.yml\'s uptrace-pg on plain postgres:16-alpine', () => {
    // Deliberately NOT moved: uptrace-pg is Uptrace's own metadata store and
    // never sees this application's schema, so giving it an extension it
    // will never load would be a larger pull for nothing.
    const yaml = readRepoFile('infra/compose/otel.compose.yml');
    expect(extractServiceImage(yaml, 'uptrace-pg', 2)).toBe(
      PLAIN_POSTGRES_IMAGE,
    );
  });
});
