// =============================================================================
// The telemetry slice's app info (issue #471, epic #467)
// =============================================================================
//
// Who this application is, as the assistant's `get_app_context` and the default
// instance id report it: the slug, the OpenTelemetry service name, the API
// version and the deploy document the CLI wrote (`DEPLOY_INFO_PATH`, read from
// disk on every call).
// =============================================================================

import { Injectable } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';
import { readDeployInfo, resolveDeployInfoPath } from '@marinoscar/platform-api/host';
import type { TelemetryAppInfo, TelemetryDeployInfo } from '@marinoscar/platform-api/telemetry';

import { resolveServiceName } from '../../common/otel/telemetry-identity';
import { resolveApiVersion } from '../../openapi/version';

@Injectable()
export class TelemetryAppInfoAdapter implements TelemetryAppInfo {
  readonly slug = APP_SLUG;

  serviceName(): string {
    return resolveServiceName();
  }

  apiVersion(): string {
    return resolveApiVersion();
  }

  async readDeployInfo(): Promise<TelemetryDeployInfo> {
    const result = await readDeployInfo(resolveDeployInfoPath());
    const document = result.document;
    return {
      status: result.status,
      document: document
        ? {
            app: { version: document.app.version, commitSha: document.app.commitSha },
            installedAt: document.installedAt,
            updatedAt: document.updatedAt,
            lastCommand: document.lastCommand,
            run: document.run ? { outcome: document.run.outcome } : null,
          }
        : null,
    };
  }
}
