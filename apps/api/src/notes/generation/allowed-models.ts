import type { AiAllowedModel } from '../../ai/ai-settings.schema';

// =============================================================================
// Which models this deployment permits, read off the settings blob
// =============================================================================
//
// Lifted OUT OF `handlers/note-generate.handler.ts` by issue #182 (epic #163)
// and re-exported from there, so every existing import — and its spec — still
// resolves to THIS one implementation. The move is not tidying: the titling
// pass (`generation/note-title.service.ts`) has to answer the same question the
// handler answers, and importing the handler to ask it would close a cycle —
// handler → `note-generation.service` → `note-title.service` → handler — whose
// symptom is an `undefined` constructor parameter type at decoration time, not
// a compile error.
//
// ⚠ ONE READER, NEVER TWO. What counts as a permitted model is the deployment's
// only lever over which vendor models its users' content reaches. A second copy
// of the parsing would be a second answer to that question, free to drift into
// permitting a model the settings page shows as forbidden.
// =============================================================================

/**
 * The models this deployment permits for one provider, as normalised entries.
 *
 * TOTAL OVER THE SETTINGS BLOB, which is JSONB that a rollback across a
 * settings change can leave in any shape at all. An unreadable block permits
 * NOTHING rather than everything: the deployment's allow-list is its only lever
 * over which vendor models its content reaches, so the safe direction when the
 * lever cannot be read is closed.
 *
 * ⚠ IT ACCEPTS BOTH ENTRY SHAPES, AND MUST (#78). Two of them exist in live
 * data at the same time: the bare `"gpt-4o"` every pre-#78 row contains, and
 * the `{ id, contextWindowTokens, maxOutputTokens }` object an administrator
 * saves after picking a model this build has never heard of. A reader that
 * understood only strings would silently drop every object entry — and because
 * this function is what decides whether a model is PERMITTED, the symptom would
 * be every generation against a newly adopted model failing with "not permitted
 * by this deployment" while the settings page cheerfully showed it permitted.
 */
export function readAllowedModelEntries(
  providers: unknown,
  providerId: string,
): AiAllowedModel[] {
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return [];
  }

  const block = (providers as Record<string, unknown>)[providerId];

  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return [];
  }

  const models = (block as Record<string, unknown>).allowedModels;

  if (!Array.isArray(models)) return [];

  return models
    .map((model): AiAllowedModel | null => {
      if (typeof model === 'string') return { id: model };

      if (typeof model !== 'object' || model === null || Array.isArray(model)) {
        return null;
      }

      const record = model as Record<string, unknown>;
      if (typeof record.id !== 'string' || record.id.length === 0) return null;

      return {
        id: record.id,
        label: typeof record.label === 'string' ? record.label : undefined,
        // Read defensively field by field rather than spread: this is raw
        // JSONB, and a `contextWindowTokens` that arrived as the string
        // `"128000"` must read as absent (so the catalogue answers, or the
        // model is refused) rather than as a number the budget then compares
        // against.
        contextWindowTokens:
          typeof record.contextWindowTokens === 'number'
            ? record.contextWindowTokens
            : undefined,
        maxOutputTokens:
          typeof record.maxOutputTokens === 'number'
            ? record.maxOutputTokens
            : undefined,
      };
    })
    .filter((entry): entry is AiAllowedModel => entry !== null);
}
