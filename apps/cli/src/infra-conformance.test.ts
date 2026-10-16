import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeFilesForMode } from '@marinoscar/platform-infra';
import { runInfraConformance } from '@marinoscar/platform-infra/testing';
import { afterAll, describe, expect, it } from 'vitest';

// =============================================================================
// The generated infra and this app's overlays hold together  (issue #483, epic #478)
// =============================================================================
//
// `infra/` is rendered by `npm run platform:infra:sync` from
// `@marinoscar/platform-infra`; this app's differences live in four kinds of
// app-owned file:
//
//   infra/compose/app.*.compose.yml    memory limits, no stack agent, pgvector
//   infra/compose/app.env.example      the variables only this app has
//   infra/nginx/app.d/                 streams, uploads, the Permissions-Policy
//   infra/otel/app-collector.yaml      (the platform's comment-only overlay)
//
// `runInfraConformance` proves, in this suite, what the production server would
// otherwise prove first: `sync --check` is clean, every compose mode merges with
// the overlays, and `nginx -t` accepts `app.d/` with both CSP files. It needs
// `docker compose` (a CLI that reads files; no daemon) and `nginx` or a Docker
// daemon; a missing tool registers a passing case NAMED with the reason and
// prints a warning, so a laptop without Docker stays green while CI, which has
// both, runs the checks. The cases after it need only `docker compose config`
// and skip the same way.
// =============================================================================

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPOSE_DIR = join(REPO_ROOT, 'infra', 'compose');

runInfraConformance({
  appRoot: REPO_ROOT,
  testApi: { describe, it, expect },
  // `worker` is not a default mode: its variables carry the CLI's prefix.
  modes: ['dev', 'devdb', 'prod', 'vps', 'worker', 'test'],
  env: { KVOX_SERVER_URL: 'https://app.example.com', KVOX_TOKEN: 'nod_conformance' },
});

function hasComposeCli(): boolean {
  const result = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  return result.error === undefined && result.status === 0;
}

const COMPOSE = hasComposeCli();

interface RenderedService {
  deploy?: { resources?: { limits?: { memory?: string } } };
  volumes?: Array<{ source?: string; target?: string }>;
  image?: string;
}

function render(dir: string, files: readonly string[]): { status: number | null; output: string; services: Record<string, RenderedService> } {
  // No inherited environment: a variable exported in the developer's shell
  // must not make a deployment's `.env` look complete.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir() };
  const args = ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'];
  const result = spawnSync('docker', args, { cwd: dir, encoding: 'utf8', env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  let services: Record<string, RenderedService> = {};
  if (result.status === 0) services = (JSON.parse(result.stdout) as { services: Record<string, RenderedService> }).services;
  return { status: result.status, output, services };
}

/** The environment file a 1.8.0 install wrote for a deployment with no telemetry: no stack-agent token, an older database login. */
const ENV_180 = [
  'APP_URL=https://app.example.com',
  'POSTGRES_HOST=db.internal',
  'POSTGRES_USER=kvox_app',
  'POSTGRES_PASSWORD=secret',
  'POSTGRES_DB=kvox',
  'JWT_SECRET=0123456789abcdef',
  'COOKIE_SECRET=fedcba9876543210',
  'COMPOSE_PROJECT_NAME=kvox',
  'DEPLOY_ROOT=/opt/infra/apps/kvox',
  'API_MEM_LIMIT=1G',
  'WEB_MEM_LIMIT=256M',
  'STORAGE_CSP_ORIGIN=https://bucket.s3.amazonaws.com',
  '',
].join('\n');

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function stackWith(env: string): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'infra-conformance-'));
  scratch.push(dir);
  cpSync(COMPOSE_DIR, dir, { recursive: true });
  writeFileSync(join(dir, '.env'), env);
  // The deploy's own list for a VPS with no telemetry: platform files, then the overlays that apply.
  return { dir, files: composeFilesForMode('vps', { telemetry: false, overlays: readdirSync(dir) }) };
}

describe('the overlays of this app', () => {
  it('are the files the issue lists, and nothing else applies to the vps stack', () => {
    const files = composeFilesForMode('vps', { telemetry: false, overlays: readdirSync(COMPOSE_DIR) });
    expect(files.filter((file) => file.startsWith('app.'))).toEqual([
      'app.prod.memory-limits.compose.yml',
      'app.vps.no-stack-agent.compose.yml',
    ]);
    expect(composeFilesForMode('devdb', { overlays: readdirSync(COMPOSE_DIR) }).filter((file) => file.startsWith('app.'))).toEqual([
      'app.devdb.pgvector.compose.yml',
    ]);
    expect(composeFilesForMode('test', { overlays: readdirSync(COMPOSE_DIR) }).filter((file) => file.startsWith('app.'))).toEqual([
      'app.test.pgvector.compose.yml',
    ]);
  });

  it('carry no secret: an overlay and app.env.example hold sizes and switches only', () => {
    for (const name of readdirSync(COMPOSE_DIR).filter((file) => file.startsWith('app.'))) {
      const body = readFileSync(join(COMPOSE_DIR, name), 'utf8');
      // Only lines that are not comments: the comments name the variables.
      expect(body, name).not.toMatch(/^[^#\n]*(SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z_]*\s*[:=]\s*[^\s$]/m);
    }
  });

  it('keep the nginx files this app owns next to the generated ones', () => {
    for (const name of ['app-streams.conf', 'app-uploads.conf']) {
      expect(existsSync(join(REPO_ROOT, 'infra', 'nginx', 'app.d', 'locations', name)), name).toBe(true);
    }
    // A body-size directive the generated nginx.conf cannot carry for the two multipart routes.
    const uploads = readFileSync(join(REPO_ROOT, 'infra', 'nginx', 'app.d', 'locations', 'app-uploads.conf'), 'utf8');
    expect(uploads).toContain('location = /api/graph/imports');
    expect(uploads).toContain('location = /api/notes/sources/documents');
    expect(uploads).toMatch(/client_max_body_size 21m;/);
  });
});

describe.skipIf(!COMPOSE)('docker compose config, with the overlays', () => {
  it('vps: the memory limits come from the overlay and the .env, and there is no stack-agent', () => {
    const { dir, files } = stackWith(`${ENV_180}STACK_AGENT_TOKEN=${'a1'.repeat(32)}\n`);
    const { status, output, services } = render(dir, files);

    expect(status, output).toBe(0);
    expect(Object.keys(services)).not.toContain('stack-agent');
    expect(services.api?.deploy?.resources?.limits?.memory).toBe(String(1024 ** 3));
    expect(services.web?.deploy?.resources?.limits?.memory).toBe(String(256 * 1024 ** 2));
  });

  it('vps: without API_MEM_LIMIT the limits equal prod.compose.yml (512M and 128M)', () => {
    const env = ENV_180.replace(/^(API|WEB)_MEM_LIMIT=.*\n/gm, '');
    const { dir, files } = stackWith(`${env}STACK_AGENT_TOKEN=${'a1'.repeat(32)}\n`);
    const { status, output, services } = render(dir, files);

    expect(status, output).toBe(0);
    expect(services.api?.deploy?.resources?.limits?.memory).toBe(String(512 * 1024 ** 2));
    expect(services.web?.deploy?.resources?.limits?.memory).toBe(String(128 * 1024 ** 2));
  });

  it('devdb and test use the pgvector image the migrations need', () => {
    const dev = render(COMPOSE_DIR, composeFilesForMode('devdb', { telemetry: false, overlays: readdirSync(COMPOSE_DIR) }));
    expect(dev.status, dev.output).toBe(0);
    expect(dev.services.db?.image).toBe('pgvector/pgvector:pg16');

    const test = render(COMPOSE_DIR, composeFilesForMode('test', { overlays: readdirSync(COMPOSE_DIR) }));
    expect(test.status, test.output).toBe(0);
    expect(test.services['db-test']?.image).toBe('pgvector/pgvector:pg16');
  });
});

// A server deployed by CLI 1.8.0 has neither value the platform's vps file now
// requires. `kvox deploy update` adds both before it runs Compose
// (`DEPLOY_ROOT` is recorded from the deployment root, `STACK_AGENT_TOKEN` is
// generated by the drift step: both are the platform engine's, see
// docs/deployment/vps.md); these cases pin WHY that step matters and that the
// result renders. A plain `docker compose` run by hand against an un-updated
// 1.8.0 `.env` fails, and says which variable to set.
describe.skipIf(!COMPOSE)('a .env written by CLI 1.8.0', () => {
  it('does not render the new vps files until STACK_AGENT_TOKEN is set (the update adds it)', () => {
    const { dir, files } = stackWith(ENV_180);
    const { status, output } = render(dir, files);

    expect(status).not.toBe(0);
    expect(output).toContain('STACK_AGENT_TOKEN');
  });

  it('does not render without DEPLOY_ROOT either, even though the stack agent is disabled (the update records it)', () => {
    const { dir, files } = stackWith(`${ENV_180.replace(/^DEPLOY_ROOT=.*\n/m, '')}STACK_AGENT_TOKEN=${'a1'.repeat(32)}\n`);
    const { status, output } = render(dir, files);

    expect(status).not.toBe(0);
    expect(output).toContain('DEPLOY_ROOT');
  });

  it('renders once the update has added both, and keeps mounting the same deploy-info directory', () => {
    const { dir, files } = stackWith(`${ENV_180}STACK_AGENT_TOKEN=${'a1'.repeat(32)}\n`);
    const { status, output, services } = render(dir, files);

    expect(status, output).toBe(0);
    const mounts = services.api?.volumes ?? [];
    expect(mounts.map((mount) => mount.source)).toContain('/opt/infra/apps/kvox/deploy-info');
  });
});
