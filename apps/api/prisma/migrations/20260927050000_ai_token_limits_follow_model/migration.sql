-- Data migration (issue #436): `ai.maxInputTokens`/`ai.maxOutputTokens` become nullable,
-- with null meaning "follow the model's own maximum" instead of a fixed number.
--
-- Every existing deployment's `global` system_settings row currently carries
-- `ai.maxOutputTokens: 16384` and `ai.maxInputTokens: 100000` — but those are not
-- deliberate choices an administrator made. They are the two values this build has
-- always shipped as defaults, and the admin settings form re-sends the full `ai`
-- object (including whatever it last read) on every save, so they end up persisted
-- into the row even when nobody ever touched them. Now that null means "use the
-- model's own ceiling", a stored 16384/100000 should be treated as "never set" and
-- cleared to null so those deployments immediately benefit from #436's change,
-- rather than being permanently pinned to the old shipped defaults forever.
--
-- Any OTHER number in these two fields is left completely untouched: a value that
-- is not one of the two old defaults is evidence of a deliberate spend/latency cap
-- an administrator intentionally set, and this migration must never silently widen
-- (or narrow) that choice.
--
-- Idempotent: re-running this after the first pass is a no-op, since the affected
-- rows already read `null` (not the string "16384"/"100000") and so no longer match
-- the `->>'...' = '16384'/'100000'` checks below. Also a no-op for any row with no
-- `ai` namespace at all (`value -> 'ai'` is NULL, so both WHERE clauses are false).

-- Clear ai.maxOutputTokens where it is exactly the old shipped default (16384).
UPDATE "system_settings"
SET "value" = jsonb_set("value", '{ai,maxOutputTokens}', 'null'::jsonb, false)
WHERE "key" = 'global'
  AND ("value" -> 'ai' ->> 'maxOutputTokens') = '16384';

-- Clear ai.maxInputTokens where it is exactly the old shipped default (100000).
UPDATE "system_settings"
SET "value" = jsonb_set("value", '{ai,maxInputTokens}', 'null'::jsonb, false)
WHERE "key" = 'global'
  AND ("value" -> 'ai' ->> 'maxInputTokens') = '100000';
