#!/bin/sh
# =============================================================================
# Installs the extensions this app needs, as the bootstrap superuser
# =============================================================================
#
# Runs once, on the first start of an empty data volume (the image's
# /docker-entrypoint-initdb.d contract), after 10-application-role.sh (files run
# in name order) and as `postgres`, the bootstrap superuser.
#
# The API connects as an ordinary role that cannot always create an extension:
# `vector` is not marked trusted, so only a superuser can install it. The
# migrations still say CREATE EXTENSION IF NOT EXISTS (historical migrations
# are never edited); with the extensions already present those statements are
# no-ops, which is what lets `prisma migrate deploy` run with no superuser.
#
#   vector     embeddings for search (migration 20260915130000)
#   pg_trgm    fuzzy matching on the knowledge graph (migration 20260926012548)
#   uuid-ossp  the first migration (20260124223146) creates it
#
# The extensions stay owned by the bootstrap superuser: the application role
# never gets SUPERUSER, and an extension's owner is the one who upgrades it.
#
# TWO DATABASES, AND THE COMMENTS, BECAUSE OF RESTORE. A restore replays an
# archive into a scratch database created by the application role (so from
# template1) and connected to as that role. The archive carries
#   CREATE EXTENSION IF NOT EXISTS vector ...;   (the role may not create it)
#   COMMENT ON EXTENSION vector IS '...';        (the role does not own it)
# and pg_restore runs with --exit-on-error, so either one stops the restore.
# Installing the extensions in template1 makes the first a no-op, and removing
# the extensions' comments (COMMENT ... IS NULL) means a dump holds no second
# statement to refuse. Both are needed; the comments are cosmetic. An existing
# cluster gets the same statements once, by hand: docs/runbooks/application-role.md.
# =============================================================================
set -eu

for database in "${POSTGRES_DB}" template1; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "${database}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
COMMENT ON EXTENSION vector IS NULL;
COMMENT ON EXTENSION pg_trgm IS NULL;
COMMENT ON EXTENSION "uuid-ossp" IS NULL;
SQL
  echo "extensions: vector, pg_trgm and uuid-ossp are installed in ${database}"
done
