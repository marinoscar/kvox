#!/usr/bin/env bash
# Builds a throw-away "slice view" of EnterpriseAppBase for platform-drift.mjs:
# each KVox base module's packaged slice is copied to apps/api/src/<kvox-module>.
# Usage: make-slice-view.sh <EAB root> <out dir>
set -euo pipefail
E=$1; V=$2; P=$E/packages/platform-api/src
rm -rf "$V"; mkdir -p "$V/apps/api/src" "$V/packages/shared" "$V/apps/cli"
cp "$E/packages/shared/identity.json" "$V/packages/shared/"
cp "$E/apps/cli/package.json" "$V/apps/cli/"
for pair in auth:identity/auth users:identity/users allowlist:identity/allowlist pat:identity/pat \
  device-auth:identity/device-auth about:host/about health:host/health openapi:host/openapi \
  settings:settings credentials:credentials email:email notifications:notifications jobs:jobs \
  nodes:nodes storage:storage db-backup:db-backup onboarding:onboarding user-data:user-data \
  export:exports ai:ai; do
  cp -r "$P/${pair#*:}" "$V/apps/api/src/${pair%%:*}"
done
