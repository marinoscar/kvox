-- Voiceprints and speaker suggestions (issue #821).
-- Voiceprints are biometric data: every FK cascades, so a sample never outlives
-- its Person, its user, or the recording/speaker it was taken from.

-- CreateTable
CREATE TABLE "kg_person_voiceprints" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "source_transcript_id" UUID NOT NULL,
    "source_speaker_id" UUID NOT NULL,
    "embedding" vector(512) NOT NULL,
    "model_id" TEXT NOT NULL,
    "speech_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_person_voiceprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_speaker_suggestions" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "speaker_id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION,
    "model_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "kg_speaker_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_person_voiceprints_owner_id_entity_id_idx" ON "kg_person_voiceprints"("owner_id", "entity_id");

-- CreateIndex
CREATE INDEX "kg_person_voiceprints_source_speaker_id_idx" ON "kg_person_voiceprints"("source_speaker_id");

-- CreateIndex
CREATE INDEX "kg_speaker_suggestions_owner_id_transcript_id_status_idx" ON "kg_speaker_suggestions"("owner_id", "transcript_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kg_speaker_suggestions_speaker_id_entity_id_key" ON "kg_speaker_suggestions"("speaker_id", "entity_id");

-- AddForeignKey
ALTER TABLE "kg_person_voiceprints" ADD CONSTRAINT "kg_person_voiceprints_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_person_voiceprints" ADD CONSTRAINT "kg_person_voiceprints_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_person_voiceprints" ADD CONSTRAINT "kg_person_voiceprints_source_transcript_id_fkey" FOREIGN KEY ("source_transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_person_voiceprints" ADD CONSTRAINT "kg_person_voiceprints_source_speaker_id_fkey" FOREIGN KEY ("source_speaker_id") REFERENCES "transcript_speakers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_speaker_suggestions" ADD CONSTRAINT "kg_speaker_suggestions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_speaker_suggestions" ADD CONSTRAINT "kg_speaker_suggestions_speaker_id_fkey" FOREIGN KEY ("speaker_id") REFERENCES "transcript_speakers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_speaker_suggestions" ADD CONSTRAINT "kg_speaker_suggestions_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_speaker_suggestions" ADD CONSTRAINT "kg_speaker_suggestions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A suggestion's lifecycle is closed by the schema.
ALTER TABLE "kg_speaker_suggestions" ADD CONSTRAINT "kg_speaker_suggestions_status_chk"
  CHECK ("status" IN ('pending', 'accepted', 'dismissed'));
