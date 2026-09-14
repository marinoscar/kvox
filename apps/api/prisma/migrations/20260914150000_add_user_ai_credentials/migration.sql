-- =============================================================================
-- Per-user AI credentials (issue #47, epic #45)
-- =============================================================================
-- One table, `user_ai_credentials`. See the block comment above the
-- `UserAiCredential` model in prisma/schema.prisma for the full reasoning, and
-- docs/specs/notes.md §4.2 and §9 for the product argument. The two facts worth
-- restating right here, because they are what this file encodes:
--
--   1. `user_id` CASCADES. This is the one foreign key the existing
--      `credentials` table structurally cannot have — it holds
--      deployment-scoped secrets addressed by `(purpose, name)` with no owner —
--      which is why a per-user key could not simply be a row in it. Without
--      this line, deleting a user leaves their encrypted personal API key in
--      the database forever with no enumeration path to find it.
--
--   2. `secret` is TEXT, never VARCHAR(n). It holds the base64
--      `[iv][authTag][ciphertext]` payload `encryptSecret(raw, 'ai-key')`
--      produces, which has no meaningful length bound; a truncating column type
--      would corrupt a credential at write time and fail authentication at read
--      time, with nothing to connect the two events.
--
-- NOTHING PRISMA-INEXPRESSIBLE IN THIS MIGRATION, unlike
-- `20260914130000_add_transcripts`: `@@unique([userId, provider])` is a plain
-- unique index with no `WHERE` clause, so `schema.prisma` says all of it and
-- there is no intentional drift to document here.
-- =============================================================================

-- CreateTable
CREATE TABLE "user_ai_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "hint" TEXT,
    "label" TEXT,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One key per user per provider. This pair IS the address every read and write
-- uses, so replacing a key is an upsert on it rather than a second row.
CREATE UNIQUE INDEX "user_ai_credentials_user_id_provider_key" ON "user_ai_credentials"("user_id", "provider");

-- AddForeignKey
-- ⚠ CASCADE. See point 1 in the header: this is the whole reason the table
-- exists rather than being a `credentials` row with a composite name.
ALTER TABLE "user_ai_credentials" ADD CONSTRAINT "user_ai_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
