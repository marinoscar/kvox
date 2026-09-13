import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// The production image must contain the scripts its npm scripts shell into
// =============================================================================
// (issue #208, epic #168)
//
// `prisma:migrate` is `node scripts/prisma-env.js migrate deploy`, and the
// deploy pipeline runs it INSIDE the production image. When that directory was
// not copied, the image still started perfectly - CMD runs `node dist/main`
// and never touches it - and then could not migrate. Nothing caught it: the
// API suite never builds the image, and CI runs migrations from the checkout.
//
// So this asserts the RULE rather than the one line that was missing: every
// `node <dir>/<file>` an npm script invokes must live in a directory the
// production stage copies. Adding a new script-backed entry point cannot
// silently break the image again.
// =============================================================================

const apiRoot = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(apiRoot, relativePath), 'utf8');
}

/** The `production` stage only; earlier stages copy the whole workspace. */
function productionStage(dockerfile: string): string {
  const index = dockerfile.indexOf('AS production');
  expect(index).toBeGreaterThan(-1);
  return dockerfile.slice(index);
}

/** Directories referenced as `node <dir>/<file>` by any npm script. */
function scriptDirectories(packageJson: string): string[] {
  const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, string> })
    .scripts;
  const directories = new Set<string>();

  for (const command of Object.values(scripts ?? {})) {
    for (const match of command.matchAll(/\bnode\s+([\w./-]+)\//g)) {
      const directory = match[1];
      // `node dist/main` is the built output, copied from the build stage by a
      // different line; only source-tree directories are in question here.
      if (directory !== undefined && directory !== 'dist') directories.add(directory);
    }
  }

  return [...directories];
}

describe('the api production image', () => {
  const dockerfile = read('Dockerfile');
  const stage = productionStage(dockerfile);

  it('copies every directory an npm script shells into', () => {
    const directories = scriptDirectories(read('package.json'));

    // Guards the real regression: prisma:migrate and prisma:seed both run
    // `node scripts/prisma-env.js` inside this image.
    expect(directories).toContain('scripts');

    // Compared as lists rather than in a loop, so a failure names the missing
    // directory instead of just reporting `false`.
    const uncopied = directories.filter(
      (directory) => !stage.includes(`COPY apps/api/${directory}`),
    );

    expect(uncopied).toEqual([]);
  });

  it('still copies prisma and its config, which migrations also need', () => {
    expect(stage).toContain('COPY apps/api/prisma');
    expect(stage).toContain('COPY apps/api/prisma.config.ts');
  });

  it('resolves the migration script relative to the image WORKDIR', () => {
    // package.json says `node scripts/...`, and the WORKDIR is /app/apps/api,
    // so the copy has to land at apps/api/scripts - not at the root.
    expect(stage).toContain('WORKDIR /app/apps/api');
    expect(stage).toContain('COPY apps/api/scripts ./apps/api/scripts/');
  });
});


describe('the api image installs no build-only packages', () => {
  const dockerfile = read('Dockerfile');

  it('does not install any -dev package', () => {
    // A `-dev` package is headers and static libraries, for COMPILING against
    // a library. Nothing in this image compiles: `npm ci` runs with
    // --ignore-scripts so no postinstall or node-gyp step can run, and no
    // build toolchain (make, g++, python3) is installed - so anything that
    // genuinely needed compiling would already fail.
    //
    // openssl-dev was carried here for years for "Prisma compatibility".
    // Prisma needs the OpenSSL RUNTIME to select its musl query engine, not
    // its headers, so it was ~2 MB of build-only files inherited by every
    // stage including production - and it is what the apk add in #203 failed
    // on.
    const installs = [...dockerfile.matchAll(/apk add[^\n]*/g)].map((match) => match[0]);
    const devPackages = installs.filter((line) => /\b[\w.+-]+-dev\b/.test(line));

    expect(devPackages).toEqual([]);
  });

  it('still installs the OpenSSL runtime Prisma needs', () => {
    // Removing this would break Prisma's engine selection on musl, which is a
    // runtime failure rather than a build one - much later, and much harder to
    // trace back here.
    expect(dockerfile).toMatch(/apk add --no-cache[^\n]*\bopenssl\b/);
  });

  it('keeps --ignore-scripts, which is what makes the above true', () => {
    expect(dockerfile).toContain('--ignore-scripts');
  });
});
