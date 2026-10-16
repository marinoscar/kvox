-- =============================================================================
-- `ask_conversations` / `ask_messages` — saved Ask conversations
-- (issue #376, epic #348; docs/specs/ontology.md §21)
-- =============================================================================
-- One row per saved conversation with the read-only graph agent, and one row
-- per turn in it. An assistant turn's `content` is the durable stream buffer
-- `ask.respond` (#378) appends to and the SSE endpoint (#379) reads from —
-- the `note_generations` "durable buffer, stream is a view" contract.
--
-- `owner_id` CASCADES (no Ask history survives its owner; there is no
-- `ask:read_any`). `scope_entity_id` is SET NULL: forgetting or merging the
-- scoped entity drops the scope link, never the conversation. `job_id`
-- mirrors `transcript_exports.job_id` (unique, nullable, SET NULL).
--
-- INTENTIONAL SCHEMA DRIFT: `ask_messages_one_running_turn_uniq_idx` at the
-- bottom of this file is a PARTIAL unique index Prisma cannot express, so it
-- exists here only and `prisma migrate diff` will report it as extra. It
-- enforces at most one running (pending/streaming) assistant turn per
-- conversation IN THE DATABASE — the `database_backup_runs_active_uniq_idx`
-- pattern, never a `findFirst` before the insert, which races. #378 maps its
-- violation (SQLSTATE 23505) to 409 `ask_turn_running`. Do not "fix" the
-- drift by adding a `@@unique` to the model.
-- =============================================================================

-- CreateEnum
CREATE TYPE "AskMessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "AskMessageStatus" AS ENUM ('pending', 'streaming', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "AskErrorClass" AS ENUM ('auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other');

-- CreateEnum
CREATE TYPE "AskFinishReason" AS ENUM ('stop', 'step_cap', 'token_cap', 'time_cap');

-- CreateTable
CREATE TABLE "ask_conversations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT,
    "scope_entity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ask_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ask_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "AskMessageRole" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" "AskMessageStatus" NOT NULL DEFAULT 'pending',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "provider" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "error_class" "AskErrorClass",
    "finish_reason" "AskFinishReason",
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ask_conversations_owner_id_updated_at_idx" ON "ask_conversations"("owner_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ask_conversations_owner_id_scope_entity_id_idx" ON "ask_conversations"("owner_id", "scope_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "ask_messages_job_id_key" ON "ask_messages"("job_id");

-- CreateIndex
CREATE INDEX "ask_messages_conversation_id_created_at_idx" ON "ask_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "ask_conversations" ADD CONSTRAINT "ask_conversations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_conversations" ADD CONSTRAINT "ask_conversations_scope_entity_id_fkey" FOREIGN KEY ("scope_entity_id") REFERENCES "kg_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ask_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- HAND-WRITTEN (intentional schema drift — see the header): at most one
-- running assistant turn per conversation.
CREATE UNIQUE INDEX "ask_messages_one_running_turn_uniq_idx"
    ON "ask_messages" ("conversation_id")
    WHERE "role" = 'assistant' AND "status" IN ('pending', 'streaming');
