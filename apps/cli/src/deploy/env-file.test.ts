import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composeEnvLinkTarget,
  composeEnvPath,
  ensureComposeEnvLink,
  envFilePath,
  readEnvFile,
  writeEnvFile,
} from './env-file.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-env-'));
}

/** The clone's compose directory, as `git clone` would have left it. */
function makeClone(root: string): string {
  const compose = join(root, 'repo', 'infra', 'compose');
  mkdirSync(compose, { recursive: true });
  return compose;
}

describe('the .env paths', () => {
  it('put the real file at the app root, next to repo/', () => {
    expect(envFilePath('/opt/infra/apps/demo')).toBe('/opt/infra/apps/demo/.env');
  });

  it('link it from where compose looks', () => {
    expect(composeEnvPath('/opt/infra/apps/demo')).toBe(
      '/opt/infra/apps/demo/repo/infra/compose/.env',
    );
  });

  it('use a relative link target, so a moved app folder still resolves', () => {
    expect(composeEnvLinkTarget('/opt/infra/apps/demo')).toBe('../../../.env');
  });
});

describe('writeEnvFile', () => {
  it('writes 0600 at the app root', () => {
    const root = makeRoot();

    const path = writeEnvFile(root, 'A=1\n');

    expect(path).toBe(envFilePath(root));
    expect(readFileSync(path, 'utf8')).toBe('A=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps 0600 when rewriting a file that was world-readable', () => {
    // `writeFileSync(path, data, { mode })` only applies the mode on creation;
    // the temp-and-rename discipline is what makes this hold.
    const root = makeRoot();
    writeFileSync(envFilePath(root), 'A=old\n', { mode: 0o644 });

    writeEnvFile(root, 'A=new\n');

    expect(readFileSync(envFilePath(root), 'utf8')).toBe('A=new\n');
    expect(statSync(envFilePath(root)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    const root = makeRoot();
    writeEnvFile(root, 'A=1\n');

    expect(readdirSync(root)).toEqual(['.env']);
  });
});

describe('ensureComposeEnvLink', () => {
  it('creates a relative symlink into the clone', () => {
    const root = makeRoot();
    makeClone(root);
    writeEnvFile(root, 'A=1\n');

    const result = ensureComposeEnvLink(root);

    expect(result).toEqual({ migrated: false, linked: true });
    const link = composeEnvPath(root);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../../.env');
    // And it resolves: compose reads through it.
    expect(readFileSync(link, 'utf8')).toBe('A=1\n');
  });

  it('is a no-op when the link is already right', () => {
    const root = makeRoot();
    makeClone(root);
    ensureComposeEnvLink(root);

    expect(ensureComposeEnvLink(root)).toEqual({ migrated: false, linked: false });
  });

  it('repoints a link that goes somewhere else', () => {
    const root = makeRoot();
    const compose = makeClone(root);
    symlinkSync('/somewhere/else/.env', join(compose, '.env'));

    const result = ensureComposeEnvLink(root);

    expect(result).toEqual({ migrated: false, linked: true });
    expect(readlinkSync(composeEnvPath(root))).toBe('../../../.env');
  });

  it('migrates a pre-#120 regular file: moved to the root, 0600, and linked back', () => {
    const root = makeRoot();
    const compose = makeClone(root);
    writeFileSync(join(compose, '.env'), 'POSTGRES_PASSWORD=s3cret\n', { mode: 0o644 });

    const result = ensureComposeEnvLink(root);

    expect(result).toEqual({ migrated: true, linked: true });
    expect(readFileSync(envFilePath(root), 'utf8')).toBe('POSTGRES_PASSWORD=s3cret\n');
    expect(statSync(envFilePath(root)).mode & 0o777).toBe(0o600);
    expect(lstatSync(composeEnvPath(root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(composeEnvPath(root))).toBe('../../../.env');
  });

  it('only migrates once', () => {
    const root = makeRoot();
    const compose = makeClone(root);
    writeFileSync(join(compose, '.env'), 'A=1\n');

    ensureComposeEnvLink(root);

    expect(ensureComposeEnvLink(root)).toEqual({ migrated: false, linked: false });
  });

  it('lets the app-root file win when both exist', () => {
    // The root file is the one the wizard reads and rewrites; two files that
    // disagree is the state this module exists to rule out.
    const root = makeRoot();
    const compose = makeClone(root);
    writeEnvFile(root, 'A=root\n');
    writeFileSync(join(compose, '.env'), 'A=clone\n');

    const result = ensureComposeEnvLink(root);

    expect(result).toEqual({ migrated: false, linked: true });
    expect(readFileSync(envFilePath(root), 'utf8')).toBe('A=root\n');
    expect(readFileSync(composeEnvPath(root), 'utf8')).toBe('A=root\n');
  });

  it('refuses something that is neither a file nor a link', () => {
    const root = makeRoot();
    const compose = makeClone(root);
    mkdirSync(join(compose, '.env'));

    expect(() => ensureComposeEnvLink(root)).toThrow(/neither a file nor a symlink/);
  });
});

describe('readEnvFile', () => {
  it('reads the app-root file', () => {
    const root = makeRoot();
    writeEnvFile(root, 'A=1\nB=two\n');

    expect(readEnvFile(root)).toEqual(new Map([['A', '1'], ['B', 'two']]));
  });

  it('returns undefined before a first install', () => {
    expect(readEnvFile(makeRoot())).toBeUndefined();
  });

  it('falls back to a pre-#120 file inside the clone without moving it', () => {
    // `doctor` and `status` must read an older deployment, and a check never
    // writes - the migration is install's and update's to do.
    const root = makeRoot();
    const compose = makeClone(root);
    writeFileSync(join(compose, '.env'), 'A=clone\n');

    expect(readEnvFile(root)).toEqual(new Map([['A', 'clone']]));
    expect(lstatSync(join(compose, '.env')).isFile()).toBe(true);
    expect(() => statSync(envFilePath(root))).toThrow();
  });
});
