import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Doctor check: the PostgreSQL extensions the schema needs (issue #464)
// =============================================================================
//
// The migrations create `vector` (embeddings and HNSW indexes) and `pg_trgm`
// (trigram search). Creating an extension needs a superuser on most managed
// clusters, so a restore into a fresh cluster, or a deployment whose database
// user cannot run `CREATE EXTENSION`, fails here before it fails inside a
// migration or a search query.
//
// READ-ONLY: one `SELECT` on `pg_extension`. The details expose extension NAMES
// only: no host, version, role or connection string.
// =============================================================================

/** The extensions the schema's migrations require. */
export const REQUIRED_DB_EXTENSIONS = ['vector', 'pg_trgm'] as const;

/** The rule, separated from the query so a test can drive it without a database. */
export function decideDbExtensions(installed: readonly string[]): DoctorCheckOutcome {
  const present = new Set(installed);
  const missing = REQUIRED_DB_EXTENSIONS.filter((name) => !present.has(name));
  const data = {
    required: REQUIRED_DB_EXTENSIONS.join(','),
    missing: missing.join(','),
  };

  if (missing.length > 0) {
    return {
      status: 'fail',
      detail: `Required PostgreSQL extension(s) not installed: ${missing.join(', ')}`,
      remedy: 'create the extension as a superuser before migrating',
      data,
    };
  }

  return {
    status: 'pass',
    detail: `PostgreSQL extensions installed: ${REQUIRED_DB_EXTENSIONS.join(', ')}`,
    data,
  };
}

@Injectable()
export class DbExtensionsDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = `${APP_SLUG}.db.extensions`;
  readonly category = 'core';
  readonly label = 'Database extensions';
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const rows = await this.prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')`;
    return decideDbExtensions(rows.map((row) => row.extname));
  }
}
