import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests, runPlatformConformance } from '@marinoscar/platform-cli/testing';

import { describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';

// =============================================================================
// The platform CLI's conformance suites  (issue #482, epic #478)
// =============================================================================
//
// `runPlatformConformance` is the executable form of the extension rules this
// app's CLI composition has to keep:
//
//   cli                  every env template fragment declares no commented
//                        `# KEY=value` line beyond the ones listed here, and
//                        every executor the worker would run (the platform's and
//                        this app's `media.audio.transcode`) passes the
//                        credential-hygiene check on a fake job holding a
//                        credential: it never reaches the node log, the state
//                        directory, HOME, the result or an error.
//   deployRegistrations  every env key names a registered group and generator,
//                        both deploy plans resolve, no edge-config file is listed
//                        twice and the vhost renders with the app's stream paths.
//
// The CLI must be built first: the executors the `cli` suite checks by default
// are the ones registered by `createCli`.
// =============================================================================

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_EXAMPLE = join(REPO_ROOT, 'infra', 'compose', '.env.example');

resetCliForTests();
createCli(APP_CLI_OPTIONS);

runPlatformConformance({
  // vitest's globals are off in this package, so the test API is passed in.
  testApi: { describe, it, expect },
  suites: {
    cli: {
      envFragments: [
        {
          name: 'infra/compose/.env.example',
          text: readFileSync(ENV_EXAMPLE, 'utf8'),
          // Optional variables this template documents by a commented example
          // on purpose (the CLI reads each as a declared optional key). A new
          // illustrative `# KEY=value` line is a failure: describe the value in
          // prose instead.
          allowCommented: [
            'VAPID_PUBLIC_KEY',
            'VAPID_PRIVATE_KEY',
            'VAPID_SUBJECT',
            'TEST_AUTH_ENABLED',
            'MAINTENANCE_MODE',
            'OTEL_DEBUG',
            'JOBS_SYSTEM_MODE_EXTRA_TYPES',
            'KG_MIGRATE_SCHEDULE_ENABLED',
          ],
        },
      ],
    },
    deployRegistrations: {},
  },
});
