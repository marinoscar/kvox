-- Issue #323: a map `speakerId -> displayName` recording the first time a
-- user named an AI-detected speaker. This is an identification (metadata
-- about the recording, like `title`), not a content correction, so it is
-- deliberately not versioned in `transcript_versions` — see the block
-- comment above `Transcript.speakerIdentities` in schema.prisma.
ALTER TABLE "transcripts" ADD COLUMN "speaker_identities" JSONB NOT NULL DEFAULT '{}';
