import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { resolveApiVersion } from '../openapi/version';
import type {
  AboutDatabase,
  AboutResponse,
  AboutRuntime,
  DeployInfoStatus,
} from './about.dto';
import {
  DeployInfo,
  deployInfoSchema,
  resolveDeployInfoPath,
} from './deploy-info.schema';

// =============================================================================
// AboutService (issue #124, epic #118)
// =============================================================================
//
// Assembles the About page's facts from three sources that fail
// INDEPENDENTLY. Each is wrapped on its own, and none of them can turn the
// route into a 5xx: a missing file, a torn write, a schema mismatch and an
// unreachable database are all ordinary states this page is expected to be
// looked at IN — the operator opening About while diagnosing a broken deploy
// is the primary user, not an edge case.
//
// THE FILE IS READ ON EVERY REQUEST. It is a few hundred bytes, the CLI
// rewrites it after every deploy and every `update --check`, and the
// acceptance criterion is "rewriting the mounted file changes the next
// response without restart". A cache with a TTL would trade that guarantee
// for a saving nobody would notice.
//
// NO NETWORK I/O, EVER. `remote` is whatever the CLI last wrote. The API has
// no git checkout, no GitHub credential, and no business making an outbound
// call every time an admin opens a page.
// =============================================================================

/**
 * Keys that must never be relayed, whatever the file says.
 *
 * `deploy-info/info.json` is non-secret BY CONSTRUCTION (epic #118, decision
 * 7): it is 0644, it is not the 0600 state file, and the CLI writes nothing
 * secret into it. This strip is the API refusing to trust that promise with
 * its own output: if a future CLI — or an operator editing the file by hand —
 * ever puts a `password`, a `secret`, a `key` or a `token` in it, the value
 * stops here rather than reaching every admin's browser and the CLI's JSON
 * output. Matched case-insensitively on the KEY, recursively, at every depth
 * `.passthrough()` may have let an unknown object through.
 */
const SECRET_LIKE_KEY = /password|secret|key|token/i;

interface DeployInfoRead {
  info: DeployInfo | null;
  status: DeployInfoStatus;
  detail: string | null;
}

interface DatabaseRead {
  facts: AboutDatabase | null;
  error: string | null;
}

interface MigrationRow {
  name: string;
  finishedAt: Date | string;
  applied: number;
}

@Injectable()
export class AboutService {
  private readonly logger = new Logger(AboutService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AboutResponse> {
    const [deploy, database] = await Promise.all([
      this.readDeployInfo(),
      this.readDatabase(),
    ]);

    const remote = deploy.info?.remote ?? null;
    const commitsBehind = remote?.commitsBehind;

    return {
      deployInfo: deploy.info,
      deployInfoStatus: deploy.status,
      detail: deploy.detail,
      runtime: this.readRuntime(),
      database: database.facts,
      databaseError: database.error,
      // Derived here, once, so the web card and the terminal agree. A `remote`
      // with no usable `commitsBehind` is "unknown" (null), never "no" (false).
      updateAvailable:
        typeof commitsBehind === 'number' ? commitsBehind > 0 : null,
      checkedAt: remote?.checkedAt ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // deploy-info/info.json
  // ---------------------------------------------------------------------------

  private async readDeployInfo(): Promise<DeployInfoRead> {
    const path = resolveDeployInfoPath();

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // The ordinary state everywhere the CLI has not deployed: dev, CI,
        // a container started by hand. Not worth a log line per request.
        return { info: null, status: 'absent', detail: null };
      }
      const detail = errorMessage(error);
      this.logger.warn(`deploy-info unreadable at ${path}: ${detail}`);
      return { info: null, status: 'unreadable', detail };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A torn read mid-rewrite lands here. The CLI writes atomically
      // (rename), so this should be rare — but "rare" is not "never", and the
      // next request will read the finished file.
      const detail = `Not valid JSON: ${errorMessage(error)}`;
      this.logger.warn(`deploy-info unreadable at ${path}: ${detail}`);
      return { info: null, status: 'unreadable', detail };
    }

    const result = deployInfoSchema.safeParse(parsed);
    if (!result.success) {
      const detail = z.prettifyError(result.error);
      this.logger.warn(`deploy-info invalid at ${path}: ${detail}`);
      return { info: null, status: 'invalid', detail };
    }

    return {
      info: stripSecretLikeKeys(result.data) as DeployInfo,
      status: 'ok',
      detail: null,
    };
  }

  // ---------------------------------------------------------------------------
  // What only this process knows
  // ---------------------------------------------------------------------------

  private readRuntime(): AboutRuntime {
    const uptimeSeconds = process.uptime();
    const now = Date.now();
    return {
      apiVersion: resolveApiVersion(),
      nodeVersion: process.version,
      processStartedAt: new Date(now - uptimeSeconds * 1000).toISOString(),
      uptimeSeconds: Math.floor(uptimeSeconds),
      serverTimeUtc: new Date(now).toISOString(),
      environment: process.env.NODE_ENV || 'development',
    };
  }

  // ---------------------------------------------------------------------------
  // What only a live connection can answer
  // ---------------------------------------------------------------------------

  private async readDatabase(): Promise<DatabaseRead> {
    try {
      const [versionRow] = await this.prisma.$queryRaw<
        Array<{ version: string }>
      >`SELECT version() AS "version"`;

      // One round trip for all three migration facts: the window count is
      // evaluated over the filtered set BEFORE `LIMIT 1` applies, so the single
      // row that comes back carries the total alongside the newest name. Zero
      // rows means zero applied migrations, which is a real (if alarming)
      // answer rather than an error. `::int` because Prisma would otherwise
      // hand back a `bigint`, which `JSON.stringify` refuses.
      const rows = await this.prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name AS "name",
               finished_at    AS "finishedAt",
               (count(*) OVER ())::int AS "applied"
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;
      const latest = rows[0];

      return {
        facts: {
          serverVersion: versionRow?.version ?? 'unknown',
          appliedMigrations: latest?.applied ?? 0,
          lastMigrationName: latest?.name ?? null,
          lastMigrationAt: latest
            ? new Date(latest.finishedAt).toISOString()
            : null,
        },
        error: null,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn(`database facts unavailable: ${message}`);
      return { facts: null, error: message };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a deep copy with every key matching {@link SECRET_LIKE_KEY} removed,
 * at every depth. Arrays are walked; primitives pass through.
 */
export function stripSecretLikeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSecretLikeKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_LIKE_KEY.test(key)) continue;
      out[key] = stripSecretLikeKeys(inner);
    }
    return out;
  }
  return value;
}
