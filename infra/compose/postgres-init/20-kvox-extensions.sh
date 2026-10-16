#!/bin/sh
# =============================================================================
# Creates the extensions this app needs, as the bootstrap superuser
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
# For an existing database the same statements are run once by hand, see
# docs/runbooks/application-role.md.
# =============================================================================
set -eu

psql -v ON_ERROR_STOP=1 --username postgres --dbname "${POSTGRES_DB}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SQL

echo "extensions: vector, pg_trgm and uuid-ossp are installed in ${POSTGRES_DB}"
