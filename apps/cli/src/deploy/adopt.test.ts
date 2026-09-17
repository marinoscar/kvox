import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../package-info.js';
import {
  adoptDeployment,
  deploymentEvidence,
  domainFromAppUrl,
  findVhostDomain,
  hasDeployment,
  renderAdoption,
} from './adopt.js';
import { writeDeployInfo } from './deploy-info.js';
import { envFilePath, writeEnvFile } from './env-file.js';
import type { CommandResult, RunCommandOptions } from './executor.js';
import { DEFAULT_BIND_PORT } from './layout.js';
import { unknownServerFacts } from './server-facts.js';
import { NotInstalledError, DEPLOY_STATE_VERSION, type DeployState } from './state.js';

// =============================================================================
// Adopting a deployment with no state file  (issue #285)
// =============================================================================
//
// The filesystem is real; only `git` is canned, because the facts being
// reconstructed ARE what git answers. Every test below stages a directory and
// asserts on the record that comes back out of it.
// =============================================================================

const HEAD = 'c'.repeat(40);
const ORIGIN = 'https://github.com/acme/demo.git';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-adopt-'));
}

interface GitAnswers {
  origin?: string | undefined;
  head?: string | undefined;
  branch?: string | undefined;
  originHead?: string | undefined;
}

/** A `runCommand` that answers the four git questions adoption asks. */
function gitSaying(answers: GitAnswers = {}): typeof import('./executor.js').runCommand {
  const {
    origin = ORIGIN,
    head = HEAD,
    branch = 'main',
    originHead = 'origin/main',
  } = answers;

  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const joined = argv.join(' ');
    const answer =
      joined === 'git remote get-url origin'
        ? origin
        : joined === 'git rev-parse HEAD'
          ? head
          : joined === 'git rev-parse --abbrev-ref HEAD'
            ? branch
            : joined === 'git symbolic-ref --short refs/remotes/origin/HEAD'
              ? originHead
              : '';
    return {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout: answer === undefined ? '' : `${answer}\n`,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
  }) as typeof import('./executor.js').runCommand;
}

/** A deployment with no state file: a clone, an .env, and nothing else. */
function stageDeployment(
  options: { env?: Record<string, string> | undefined; clone?: boolean | undefined } = {},
): string {
  const root = makeRoot();
  if (options.clone !== false) {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  }
  if (options.env !== undefined) {
    writeEnvFile(
      root,
      `${Object.entries(options.env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );
  }
  return root;
}

const FULL_ENV = {
  APP_BIND_PORT: '3535',
  COMPOSE_PROJECT_NAME: 'demo',
  APP_URL: 'https://app.example.test',
};

function adopt(root: string, extra: Record<string, unknown> = {}) {
  return adoptDeployment({
    deployRoot: root,
    runCommand: gitSaying(),
    now: new Date('2026-09-17T12:00:00.000Z'),
    ...extra,
  } as never);
}

describe('the evidence gate', () => {
  it('needs BOTH a git checkout and a readable .env', () => {
    const both = stageDeployment({ env: FULL_ENV });
    expect(deploymentEvidence(both)).toEqual({ clone: true, env: true });
    expect(hasDeployment(deploymentEvidence(both))).toBe(true);
  });

  it('sees no clone when repo/ is not a git checkout', () => {
    // A `repo/` directory with no `.git` is a leftover, not a deployment: the
    // fetch step would have nothing to fetch into.
    const root = stageDeployment({ env: FULL_ENV, clone: false });
    mkdirSync(join(root, 'repo'), { recursive: true });

    expect(deploymentEvidence(root)).toEqual({ clone: false, env: true });
    expect(hasDeployment(deploymentEvidence(root))).toBe(false);
  });

  it('sees the .env in the pre-#120 layout too, inside the clone', () => {
    const root = stageDeployment();
    mkdirSync(join(root, 'repo', 'infra', 'compose'), { recursive: true });
    writeFileSync(join(root, 'repo', 'infra', 'compose', '.env'), 'APP_BIND_PORT=3535\n');

    expect(deploymentEvidence(root)).toEqual({ clone: true, env: true });
  });

  it('is positive evidence, not the absence of a refusal: an empty directory is not a deployment', () => {
    expect(deploymentEvidence(makeRoot())).toEqual({ clone: false, env: false });
    expect(hasDeployment({ clone: false, env: false })).toBe(false);
  });

  it('refuses a clone with no .env, and an .env with no clone, one piece at a time', () => {
    expect(hasDeployment({ clone: true, env: false })).toBe(false);
    expect(hasDeployment({ clone: false, env: true })).toBe(false);
  });
});

describe('adoptDeployment refusals', () => {
  it('gives an empty directory the message a missing deployment has always got', async () => {
    const root = makeRoot();

    const error = await adopt(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain(`No deployment found at ${root}`);
    expect((error as Error).message).toContain('deploy install');
    expect((error as Error).message).toContain('--root');
    // Nothing to report about half a deployment, because there is no half.
    expect((error as Error).message).not.toContain('but a deployment needs both');
  });

  it('refuses a clone with no .env, and says which half it found', async () => {
    const root = stageDeployment();

    const error = await adopt(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('No deployment found at');
    expect((error as Error).message).toContain(join(root, 'repo'));
    expect((error as Error).message).toContain('a deployment needs both');
  });

  it('refuses an .env with no clone, and says which half it found', async () => {
    const root = stageDeployment({ env: FULL_ENV, clone: false });

    const error = await adopt(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain(envFilePath(root));
    expect((error as Error).message).toContain('a deployment needs both');
  });

  it('refuses a clone with no origin rather than guessing a repository', async () => {
    // Deploying the wrong repository is the failure resolveRepoTarget's rank-3
    // guard exists to make impossible; inventing an origin walks into it.
    const root = stageDeployment({ env: FULL_ENV });

    const error = await adoptDeployment({
      deployRoot: root,
      runCommand: gitSaying({ origin: '' }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('no `origin` remote');
  });

  it('refuses a detached HEAD whose remote has no default branch, naming --ref', async () => {
    // Guessing `main` is how a fork on master or develop gets adopted onto the
    // wrong branch and updated to it on the next run.
    const root = stageDeployment({ env: FULL_ENV });

    const error = await adoptDeployment({
      deployRoot: root,
      runCommand: gitSaying({ branch: 'HEAD', originHead: '' }),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('--ref');
  });

  it('takes --ref for that detached HEAD instead of refusing', async () => {
    const root = stageDeployment({ env: FULL_ENV });

    const { state } = await adoptDeployment({
      deployRoot: root,
      runCommand: gitSaying({ branch: 'HEAD', originHead: '' }),
      ref: 'v2.1.0',
    });

    expect(state.ref).toBe('v2.1.0');
  });

  it('falls back to the remote default branch for a detached HEAD, never to `main`', async () => {
    const root = stageDeployment({ env: FULL_ENV });

    const { state } = await adoptDeployment({
      deployRoot: root,
      runCommand: gitSaying({ branch: 'HEAD', originHead: 'origin/develop' }),
    });

    expect(state.ref).toBe('develop');
  });
});

describe('the reconstructed state', () => {
  it('reads every knowable field off the disk', async () => {
    const root = stageDeployment({ env: FULL_ENV });

    const { state } = await adopt(root);

    expect(state).toMatchObject({
      version: DEPLOY_STATE_VERSION,
      repoUrl: ORIGIN,
      ref: 'main',
      commitSha: HEAD,
      name: 'demo',
      bindPort: 3535,
      domain: 'app.example.test',
      deployRoot: root,
      envPath: envFilePath(root),
      lastCommand: 'update',
      appctlVersion: CLI_VERSION,
      adoptedAt: '2026-09-17T12:00:00.000Z',
    });
  });

  it('invents neither installedAt nor lastDeployedAt', async () => {
    // The regression guard. Neither instant is on this disk anywhere, and
    // stamping `now` would put a fiction on the About page - the class of bug
    // #283 fixed and the reason #284 made lastDeployedAt optional.
    const root = stageDeployment({ env: FULL_ENV });

    const { state } = await adopt(root);

    expect(state.installedAt).toBeUndefined();
    expect(state.lastDeployedAt).toBeUndefined();
    // And it says so out loud rather than leaving a blank field.
    expect(renderAdoption((await adopt(root)).notice).join('\n')).toContain(
      'installed   unknown',
    );
  });

  it('recovers installedAt from a surviving deploy-info, which IS on the disk', async () => {
    const root = stageDeployment({ env: FULL_ENV });
    writeDeployInfo(
      root,
      {
        version: DEPLOY_STATE_VERSION,
        repoUrl: ORIGIN,
        ref: 'main',
        commitSha: HEAD,
        bindPort: 3535,
        deployRoot: root,
        installedAt: '2026-01-01T00:00:00.000Z',
        lastDeployedAt: '2026-02-02T00:00:00.000Z',
        lastCommand: 'install',
        appctlVersion: '1.0.0',
      } as DeployState,
      unknownServerFacts(),
      { appVersion: null },
    );

    const { state } = await adopt(root);

    expect(state.installedAt).toBe('2026-01-01T00:00:00.000Z');
    // `lastDeployedAt` is deliberately NOT recovered the same way: the
    // document's `updatedAt` is written as `lastDeployedAt ?? installedAt`,
    // so reading it back cannot tell the two apart, and #283's
    // failed-first-install document would turn "never deployed" into a deploy
    // that did not happen.
    expect(state.lastDeployedAt).toBeUndefined();
  });

  it('falls back to the directory name and the default port when the .env is thin', async () => {
    const root = stageDeployment({ env: { POSTGRES_HOST: 'db' } });

    const { state } = await adopt(root);

    expect(state.name).toBe(root.split('/').pop());
    expect(state.bindPort).toBe(DEFAULT_BIND_PORT);
    expect(state.domain).toBeUndefined();
  });

  it('records --proxy-container when it was given, and nothing when it was not', async () => {
    const root = stageDeployment({ env: FULL_ENV });

    expect((await adopt(root)).state.proxyContainer).toBeUndefined();
    expect((await adopt(root, { proxyContainer: 'proxy-nginx' })).state.proxyContainer).toBe(
      'proxy-nginx',
    );
  });

  it('never carries an embedded credential into the record or the notice', async () => {
    // `normaliseRepoUrl` strips it on the way in, so the token is not in the
    // recorded URL either - not merely masked when it is printed.
    const root = stageDeployment({ env: FULL_ENV });

    const { state, notice } = await adoptDeployment({
      deployRoot: root,
      runCommand: gitSaying({ origin: 'https://user:token@github.com/acme/demo.git' }),
    });

    expect(state.repoUrl).toBe(ORIGIN);
    expect(notice.detail.join('\n')).not.toContain('token');
    expect(notice.detail.join('\n')).not.toContain('user:');
  });
});

describe('the notice the operator sees', () => {
  it('says the record was rebuilt, and from what', async () => {
    const root = stageDeployment({ env: FULL_ENV });

    const { notice } = await adopt(root);
    const rendered = renderAdoption(notice).join('\n');

    expect(notice.headline).toContain('Adopted this deployment');
    expect(notice.headline).toContain('.appctl-deploy.json');
    expect(notice.headline).toContain('rebuilt from the clone, the .env and the proxy');
    // Every reconstructed field names its own source, so an operator can see
    // what this decided and where it got it.
    expect(rendered).toContain(`repository  ${ORIGIN}  (repo/ origin)`);
    expect(rendered).toContain(`revision    ${HEAD.slice(0, 12)}  (repo/ HEAD)`);
    expect(rendered).toContain('ref         main  (repo/ HEAD)');
    expect(rendered).toContain('name        demo  (.env COMPOSE_PROJECT_NAME)');
    expect(rendered).toContain('bind port   3535  (.env APP_BIND_PORT)');
    expect(rendered).toContain('domain      app.example.test  (.env APP_URL)');
  });

  it('names the directory name and the default port as such when it fell back', async () => {
    const root = stageDeployment({ env: { POSTGRES_HOST: 'db' } });

    const rendered = renderAdoption((await adopt(root)).notice).join('\n');

    expect(rendered).toContain('(directory name)');
    expect(rendered).toContain(`bind port   ${DEFAULT_BIND_PORT}  (default)`);
    expect(rendered).toContain('domain      not published');
  });
});

describe('domainFromAppUrl', () => {
  it('takes the hostname of a public URL', () => {
    expect(domainFromAppUrl('https://app.example.test')).toBe('app.example.test');
    expect(domainFromAppUrl('https://app.example.test/')).toBe('app.example.test');
  });

  it('is undefined for a loopback URL, which is not a published domain', () => {
    // .env.example ships `http://localhost:3535`, so an install made without
    // --domain keeps it; adopting `localhost` would make the publish step try
    // to issue a certificate for it.
    expect(domainFromAppUrl('http://localhost:3535')).toBeUndefined();
    expect(domainFromAppUrl('http://127.0.0.1:3535')).toBeUndefined();
  });

  it('is undefined for nothing, and for something that is not a URL', () => {
    expect(domainFromAppUrl(undefined)).toBeUndefined();
    expect(domainFromAppUrl('')).toBeUndefined();
    expect(domainFromAppUrl('app.example.test')).toBeUndefined();
  });
});

describe('findVhostDomain', () => {
  function proxyWith(vhosts: Record<string, number>): string {
    const root = makeRoot();
    mkdirSync(join(root, 'nginx', 'conf.d'), { recursive: true });
    for (const [domain, port] of Object.entries(vhosts)) {
      writeFileSync(
        join(root, 'nginx', 'conf.d', `${domain}.conf`),
        `server { server_name ${domain}; location / { proxy_pass http://127.0.0.1:${port}; } }\n`,
      );
    }
    return root;
  }

  it('finds the vhost that forwards to this deployment', () => {
    const root = proxyWith({ 'a.example.test': 3535, 'b.example.test': 3536 });

    expect(findVhostDomain(root, 3536)).toBe('b.example.test');
  });

  it('answers nothing when no vhost matches, or when the proxy root is not there', () => {
    expect(findVhostDomain(proxyWith({ 'a.example.test': 3535 }), 3999)).toBeUndefined();
    expect(findVhostDomain(join(makeRoot(), 'nope'), 3535)).toBeUndefined();
  });

  it('answers nothing when two vhosts claim the same port', () => {
    // Adopting one of them would publish this deployment under somebody
    // else's hostname; ambiguity is not an answer.
    const root = proxyWith({ 'a.example.test': 3535, 'b.example.test': 3535 });

    expect(findVhostDomain(root, 3535)).toBeUndefined();
  });

  it('is what supplies the domain when the .env has no usable APP_URL', async () => {
    const root = stageDeployment({ env: { APP_BIND_PORT: '3535', APP_URL: 'http://localhost:3535' } });
    const proxyRoot = proxyWith({ 'adopted.example.test': 3535 });

    const { state, notice } = await adopt(root, { proxyRoot });

    expect(state.domain).toBe('adopted.example.test');
    expect(renderAdoption(notice).join('\n')).toContain('adopted.example.test');
    expect(renderAdoption(notice).join('\n')).toContain('vhost');
  });
});
