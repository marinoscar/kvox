import { z } from 'zod';

// =============================================================================
// Frozen copy: what the retired AI stack knew about OpenAI models
// (issue #477, epic #472)
// =============================================================================
//
// PLATFORM-ADOPTION: this file is a FROZEN COPY of three pieces of the stack
// that `apps/api/src/ai/` held until issue #477 deleted it:
//
//   - the `allowedModels` entry schema (`ai-settings.schema.ts`),
//   - the model resolution precedence (`ai-model-resolution.ts`), and
//   - the OpenAI catalogue, the family derivation and the conservative floors
//     (`providers/openai.provider.ts`).
//
// WHY IT SURVIVES THE DELETE. The one-off command `ai-legacy-migrate.ts`
// (issue #474) still has to turn a deployment's stored `ai` settings into
// `ai_models` rows, and a deployment that has not migrated yet must be able to
// run it from this build. The planner (`ai-legacy-plan.ts`) needs exactly the
// numbers and capability flags the old stack would have resolved for each
// permitted model, so those rules are kept here, trimmed to what the planner
// calls and otherwise unchanged.
//
// ⚠ FROZEN. Do not extend it, do not keep it in step with a vendor, do not import
// it from a request path. The platform's own model catalogue owns this
// knowledge now; this file goes away together with the migration command (see
// docs/platform-adoption/local-exceptions.md).
// =============================================================================

/** One `allowedModels` entry, normalised. */
const allowedModelSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(128).optional(),
  contextWindowTokens: z.number().int().min(1_024).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
});

export type AiAllowedModel = z.infer<typeof allowedModelSchema>;

/**
 * An `allowedModels` entry as it may have been stored: an object, or a bare id
 * (the string form every early deployment holds). Normalised to an object.
 */
export const aiAllowedModelEntrySchema = z
  .union([z.string().trim().min(1).max(128), allowedModelSchema])
  .transform((entry): AiAllowedModel => (typeof entry === 'string' ? { id: entry } : entry));

/** What the retired stack knew about one model. */
export interface AiModelDescriptor {
  id: string;
  label: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  structuredOutput: boolean;
  toolCalling: boolean;
}

interface AiModelFeatureFlags {
  structuredOutput: boolean;
  toolCalling: boolean;
}

/** Everything known about models, as one argument. */
export interface AiModelKnowledge {
  catalogue: readonly AiModelDescriptor[];
  derive?: (id: string) => AiModelDescriptor | null;
  fallback?: { contextWindowTokens: number; maxOutputTokens: number };
  fallbackFeatures?: AiModelFeatureFlags;
}

/** A resolved model: the entry's numbers, else the catalogue's, else the derived family's, else the floor. */
export interface AiResolvedModel extends AiModelDescriptor {
  source: 'explicit' | 'catalogue' | 'derived' | 'default';
  derivedFrom: string | null;
}

type Source = AiResolvedModel['source'];
const SOURCE_RANK: Record<Source, number> = { explicit: 0, catalogue: 1, derived: 2, default: 3 };

function resolveNumber(
  field: 'contextWindowTokens' | 'maxOutputTokens',
  entry: AiAllowedModel,
  knowledge: AiModelKnowledge,
  known: AiModelDescriptor | undefined,
): { value: number | null; source: Source | null; derivedFrom: string | null } {
  const explicit = entry[field];
  if (explicit !== undefined) return { value: explicit, source: 'explicit', derivedFrom: null };
  if (known) return { value: known[field], source: 'catalogue', derivedFrom: null };
  const derived = knowledge.derive?.(entry.id) ?? null;
  if (derived) return { value: derived[field], source: 'derived', derivedFrom: derived.id };
  const fallback = knowledge.fallback;
  if (fallback) return { value: fallback[field], source: 'default', derivedFrom: null };
  return { value: null, source: null, derivedFrom: null };
}

function resolveFeatures(
  id: string,
  knowledge: AiModelKnowledge,
  known: AiModelDescriptor | undefined,
): AiModelFeatureFlags {
  if (known) return { structuredOutput: known.structuredOutput, toolCalling: known.toolCalling };
  const derived = knowledge.derive?.(id) ?? null;
  if (derived) return { structuredOutput: derived.structuredOutput, toolCalling: derived.toolCalling };
  return {
    structuredOutput: knowledge.fallbackFeatures?.structuredOutput ?? false,
    toolCalling: knowledge.fallbackFeatures?.toolCalling ?? false,
  };
}

/**
 * The effective descriptor for one entry, or `null` when neither the entry, the
 * catalogue, the derivation nor the floor can supply both numbers.
 */
export function resolveAllowedModel(entry: AiAllowedModel, knowledge: AiModelKnowledge): AiResolvedModel | null {
  const known = knowledge.catalogue.find((model) => model.id === entry.id);
  const context = resolveNumber('contextWindowTokens', entry, knowledge, known);
  const output = resolveNumber('maxOutputTokens', entry, knowledge, known);
  if (context.value === null || output.value === null) return null;
  if (context.source === null || output.source === null) return null;

  const source = SOURCE_RANK[context.source] >= SOURCE_RANK[output.source] ? context.source : output.source;
  const features = resolveFeatures(entry.id, knowledge, known);
  return {
    id: entry.id,
    label: entry.label ?? known?.label ?? entry.id,
    contextWindowTokens: context.value,
    maxOutputTokens: output.value,
    structuredOutput: features.structuredOutput,
    toolCalling: features.toolCalling,
    source,
    derivedFrom: source === 'derived' ? (context.derivedFrom ?? output.derivedFrom ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// The OpenAI catalogue, as the retired provider shipped it
// ---------------------------------------------------------------------------

const MODELS: AiModelDescriptor[] = [
  { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_384, structuredOutput: true, toolCalling: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindowTokens: 128_000, maxOutputTokens: 16_384, structuredOutput: true, toolCalling: true },
  { id: 'gpt-4.1', label: 'GPT-4.1', contextWindowTokens: 1_047_576, maxOutputTokens: 32_768, structuredOutput: true, toolCalling: true },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', contextWindowTokens: 1_047_576, maxOutputTokens: 32_768, structuredOutput: true, toolCalling: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000, structuredOutput: true, toolCalling: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindowTokens: 400_000, maxOutputTokens: 128_000, structuredOutput: true, toolCalling: true },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', contextWindowTokens: 400_000, maxOutputTokens: 128_000, structuredOutput: true, toolCalling: true },
];

/** The conservative floor for a chat model that cannot be placed. */
export const OPENAI_DEFAULT_MODEL_LIMITS = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
} as const;

/** The conservative capability floor for a model that cannot be placed. */
export const OPENAI_DEFAULT_MODEL_FEATURES = {
  structuredOutput: false,
  toolCalling: false,
} as const;

/** One trailing dated-snapshot suffix, stripped at most once; the longer alternatives come first. */
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

/**
 * Place an unrecognised id in a known family: strip one dated-snapshot suffix,
 * then take the LONGEST catalogue id that matches on a hyphen boundary (so
 * `gpt-5.4-mini-2026-03-17` is `gpt-5.4-mini`, never `gpt-5.4`).
 */
export function deriveOpenAiModelDescriptor(id: string): AiModelDescriptor | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return null;
  const base = trimmed.replace(SNAPSHOT_SUFFIX, '');

  let best: AiModelDescriptor | null = null;
  for (const model of MODELS) {
    const matches = base === model.id || base.startsWith(`${model.id}-`);
    if (!matches) continue;
    if (best === null || model.id.length > best.id.length) best = model;
  }
  if (!best) return null;

  return {
    id: best.id,
    label: trimmed,
    contextWindowTokens: best.contextWindowTokens,
    maxOutputTokens: best.maxOutputTokens,
    structuredOutput: best.structuredOutput,
    toolCalling: best.toolCalling,
  };
}
