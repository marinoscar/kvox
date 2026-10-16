-- =============================================================================
-- Per-user hidden note templates: a LISTING preference, never access control
-- (#310, epic #306)
-- =============================================================================
-- One join table. See the block comment above `UserHiddenNoteTemplate` in
-- prisma/schema.prisma for why this is a join table rather than a
-- `user_settings` namespace (FK integrity in both directions, a plain
-- indexed `WHERE user_id = ...` query, no cap, no six-file settings-parity
-- cost) and rather than reusing `note_templates.is_archived` (archiving is a
-- property of the template, shared by every viewer; hiding is a property of
-- the (user, template) pair, and must never affect anyone else's picker).
--
-- ⚠ Hiding a template never gates access: create, regenerate and preview all
-- keep accepting a hidden template by id exactly as before this migration.
-- =============================================================================

-- CreateTable
CREATE TABLE "user_hidden_note_templates" (
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_hidden_note_templates_pkey" PRIMARY KEY ("user_id","template_id")
);

-- CreateIndex
CREATE INDEX "user_hidden_note_templates_template_id_idx" ON "user_hidden_note_templates"("template_id");

-- AddForeignKey
-- Cascade: the preference is meaningless once its owner is gone.
ALTER TABLE "user_hidden_note_templates" ADD CONSTRAINT "user_hidden_note_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: hiding a deleted template has nothing left to hide.
ALTER TABLE "user_hidden_note_templates" ADD CONSTRAINT "user_hidden_note_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "note_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
