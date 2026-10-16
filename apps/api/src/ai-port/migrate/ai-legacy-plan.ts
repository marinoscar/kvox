import {
  aiAllowedModelEntrySchema,
  type AiAllowedModel,
} from '../../ai/ai-settings.schema';
import { resolveAllowedModel, type AiModelKnowledge } from '../../ai/ai-model-resolution';
import {
  deriveOpenAiModelDescriptor,
  OPENAI_DEFAULT_MODEL_FEATURES,
  OPENAI_DEFAULT_MODEL_LIMITS,
} from '../../ai/providers/openai.provider';

// =============================================================================
// Legacy AI settings plan (issue #474, epic #472)
// =============================================================================
//
// PURE: no I/O, no clock, no random. It turns the `ai` value this application
// stored before the platform AI slice (`enabled`, `provider`, and
// `providers.openai.{baseUrl, allowedModels, defaultModel}`) into
//
//   - the platform `ai` value (`planAiSettings().migrated`), plus the patch that
//     produced it, and
//   - one `ai_models` row per permitted model (`planAiSettings().models`).
//
// The command (`ai-legacy-migrate.ts`) owns every read and write; this file owns
// every decision, so the decisions can be pinned by a spec that needs no
// database.
//
// WHAT IS LEFT ALONE. `taskModels`, `graphEnabled`, `defaultModel`'s siblings
// (`maxInputTokens`, `maxOutputTokens`, `requestTimeoutMs`, `reasoningEffort`,
// `maxDocumentBytes`) and every key this file does not name keep their stored
// bytes: the extension from issue #473 gave them the platform namespace with this
// application's own names, so they need no rewrite. A key the planner does not
// know is copied through, never dropped.
//
// ⚠ `ai_models.capabilities` HAS THE PLATFORM'S SHAPE, NOT A FLAG RECORD. The
// issue text sketches `{ responses: true, streaming: true, ... }`; the installed
// platform validates and reads `{ capabilities: string[], inputModalities,
// outputModalities, reasoningEfforts?, contextWindow?, maxOutputTokens? }`
// (`aiModelCapabilitiesSchema`, `@marinoscar/platform-api/ai`). A record of
// booleans would fail that schema on read and the admin model list would show the
// row as unclassified. The installed package wins.
// =============================================================================

/** The provider this migration handles: the only one this application ever had. */
export const LEGACY_PROVIDER_ID = 'openai';

/** The embedding model search and the graph call. Always present after a migration. */
export const EMBEDDING_MODEL_ID = 'text-embedding-3-small';

/** The OpenAI API root. A stored `baseUrl` equal to it is the default and is not carried over. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** One `allowedModels` entry after the legacy normaliser: `{ id, label?, contextWindowTokens?, maxOutputTokens? }`. */
export type LegacyAllowedModel = AiAllowedModel;

/**
 * The `ai` value as it was stored before the platform slice. Typed from the
 * issue; every field is read defensively, because a stored row can hold anything
 * a past release or a hand edit left in it.
 */
export interface LegacyAiValue {
  enabled: boolean;
  provider: 'openai' | null;
  providers: {
    openai: {
      baseUrl: string;
      allowedModels: Array<string | LegacyAllowedModel>;
      defaultModel: string;
    };
  };
  [k: string]: unknown;
}

/** What the platform reads from `ai_models.capabilities`. */
export interface AiModelCapabilitiesJson {
  capabilities: string[];
  inputModalities: Array<'text'>;
  outputModalities: Array<'text' | 'embedding'>;
  reasoningEfforts?: Array<'minimal' | 'low' | 'medium' | 'high'>;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** One `ai_models` row to upsert on `(provider, modelId)`. */
export interface AiModelUpsert {
  provider: 'openai';
  modelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: AiModelCapabilitiesJson;
  capabilitySource: 'admin_override';
  enabled: true;
}

/** The planner's answer. */
export interface AiLegacyPlan {
  /** The fields written into the platform `ai` namespace. */
  patch: Record<string, unknown>;
  /** The whole `ai` value to store: the stored one with `patch` applied and the legacy-only keys removed. */
  migrated: Record<string, unknown>;
  /** Rows to upsert, in `allowedModels` order, the embedding model last. */
  models: AiModelUpsert[];
  /**
   * True when the stored value no longer holds any legacy key (`provider`,
   * `providers.openai.allowedModels`, `providers.openai.defaultModel`): the
   * settings step ran before. Then `patch` is empty, `migrated` equals the stored
   * value and `models` holds the embedding row only, so a rerun never resets
   * `keyPolicy` or re-enables a model an administrator turned off.
   */
  alreadyMigrated: boolean;
  /** How many entries `allowedModels` held (valid or not). */
  allowed: number;
  /** Entries that failed the legacy normaliser, as positions only (never values). */
  skippedEntries: number[];
  /** `providers.openai.defaultModel` when it was set. */
  defaultModel: string | null;
}

/**
 * What this build knows about OpenAI models, exactly as `OpenAiProvider` hands it
 * to `modelKnowledgeOf`: no catalogue list here (the exact ids are covered by the
 * derivation, which matches a catalogue id on a hyphen boundary and returns the
 * same numbers), the family derivation, and the conservative floors.
 */
export const OPENAI_MODEL_KNOWLEDGE: AiModelKnowledge = {
  catalogue: [],
  derive: deriveOpenAiModelDescriptor,
  fallback: OPENAI_DEFAULT_MODEL_LIMITS,
  fallbackFeatures: OPENAI_DEFAULT_MODEL_FEATURES,
};

/** Reasoning families, as the platform's OpenAI classifier treats them. */
const GPT5_REASONING = /^gpt-5(?:[.-]|$)/;
const GPT5_CHAT = /^gpt-5(?:\.\d+)?-chat/;
const O_SERIES_REASONING = /^(?:o\d(?:-|$)|codex-)/;

const GPT5_EFFORTS: Array<'minimal' | 'low' | 'medium' | 'high'> = ['minimal', 'low', 'medium', 'high'];
const O_SERIES_EFFORTS: Array<'minimal' | 'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];

function reasoningEffortsFor(modelId: string): Array<'minimal' | 'low' | 'medium' | 'high'> | null {
  const id = modelId.trim().toLowerCase();
  if (GPT5_CHAT.test(id)) return null;
  if (GPT5_REASONING.test(id)) return GPT5_EFFORTS;
  if (O_SERIES_REASONING.test(id)) return O_SERIES_EFFORTS;
  return null;
}

function isEmbeddingModel(modelId: string): boolean {
  return /^text-embedding-/.test(modelId.trim().toLowerCase());
}

/** The embedding row. No numbers: the platform's own classifier states none either. */
export function embeddingModelUpsert(modelId: string = EMBEDDING_MODEL_ID, label: string | null = null): AiModelUpsert {
  return {
    provider: LEGACY_PROVIDER_ID,
    modelId,
    displayName: label,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: {
      capabilities: ['embeddings'],
      inputModalities: ['text'],
      outputModalities: ['embedding'],
    },
    capabilitySource: 'admin_override',
    enabled: true,
  };
}

/**
 * The row for one permitted chat model. `structured_output` and `tools` follow
 * the resolved descriptor (the catalogue, the family, or the conservative floor),
 * so the chooser that reads them keeps the answer it gave before the migration.
 * `reasoning` follows the model family: the platform refuses a reasoning effort
 * on a model that does not declare the capability, and this application sends one
 * for the families below.
 */
export function chatModelUpsert(
  entry: LegacyAllowedModel,
  knowledge: AiModelKnowledge = OPENAI_MODEL_KNOWLEDGE,
): AiModelUpsert {
  const resolved = resolveAllowedModel(entry, knowledge);
  const structuredOutput = resolved?.structuredOutput ?? knowledge.fallbackFeatures?.structuredOutput ?? false;
  const toolCalling = resolved?.toolCalling ?? knowledge.fallbackFeatures?.toolCalling ?? false;
  const contextWindow = resolved?.contextWindowTokens ?? null;
  const maxOutputTokens = resolved?.maxOutputTokens ?? null;
  const efforts = reasoningEffortsFor(entry.id);

  const capabilities: AiModelCapabilitiesJson = {
    capabilities: [
      'responses',
      ...(efforts ? ['reasoning'] : []),
      ...(toolCalling ? ['tools'] : []),
      ...(structuredOutput ? ['structured_output'] : []),
      'streaming',
    ],
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...(efforts ? { reasoningEfforts: [...efforts] } : {}),
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
  };

  return {
    provider: LEGACY_PROVIDER_ID,
    modelId: entry.id,
    displayName: entry.label ?? null,
    contextWindow,
    maxOutputTokens,
    capabilities,
    capabilitySource: 'admin_override',
    enabled: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameBaseUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Plan the settings and model half of the migration from the stored `ai` value.
 *
 * @param stored - the raw `ai` value of the `global` row (not the namespace
 *   `read`, which drops the fields this function exists to move).
 * @param knowledge - what is known about models; defaults to this build's OpenAI
 *   knowledge. Injectable so a spec can pin the resolution chain.
 */
export function planAiSettings(
  stored: LegacyAiValue,
  knowledge: AiModelKnowledge = OPENAI_MODEL_KNOWLEDGE,
): AiLegacyPlan {
  const value: Record<string, unknown> = isRecord(stored) ? stored : {};
  const providers = isRecord(value.providers) ? value.providers : {};
  const openai = isRecord(providers.openai) ? providers.openai : {};

  const hasLegacyKey =
    Object.prototype.hasOwnProperty.call(value, 'provider') ||
    Object.prototype.hasOwnProperty.call(openai, 'allowedModels') ||
    Object.prototype.hasOwnProperty.call(openai, 'defaultModel');

  const rawAllowed = Array.isArray(openai.allowedModels) ? (openai.allowedModels as unknown[]) : [];

  if (!hasLegacyKey) {
    return {
      patch: {},
      migrated: structuredClone(value),
      models: [embeddingModelUpsert()],
      alreadyMigrated: true,
      allowed: 0,
      skippedEntries: [],
      defaultModel: null,
    };
  }

  // ---- models: one row per valid, distinct entry --------------------------
  const skippedEntries: number[] = [];
  const entries: LegacyAllowedModel[] = [];
  const seen = new Set<string>();
  rawAllowed.forEach((raw, index) => {
    const parsed = aiAllowedModelEntrySchema.safeParse(raw);
    if (!parsed.success) {
      skippedEntries.push(index);
      return;
    }
    if (seen.has(parsed.data.id)) return;
    seen.add(parsed.data.id);
    entries.push(parsed.data);
  });

  const models: AiModelUpsert[] = entries.map((entry) =>
    isEmbeddingModel(entry.id) ? embeddingModelUpsert(entry.id, entry.label ?? null) : chatModelUpsert(entry, knowledge),
  );
  if (!seen.has(EMBEDDING_MODEL_ID)) models.push(embeddingModelUpsert());

  // ---- settings patch ------------------------------------------------------
  const enabled = value.enabled === true;
  const provider = value.provider === LEGACY_PROVIDER_ID ? LEGACY_PROVIDER_ID : null;
  const baseUrl = typeof openai.baseUrl === 'string' ? openai.baseUrl.trim() : '';
  const defaultModel =
    typeof openai.defaultModel === 'string' && openai.defaultModel.trim() !== '' ? openai.defaultModel.trim() : null;

  const slot: Record<string, unknown> = {
    enabled: provider === LEGACY_PROVIDER_ID && enabled,
    ...(baseUrl !== '' && !sameBaseUrl(baseUrl, OPENAI_DEFAULT_BASE_URL) ? { baseUrl } : {}),
  };

  const patch: Record<string, unknown> = {
    enabled,
    keyPolicy: 'byok',
    providers: { openai: slot },
    ...(defaultModel !== null ? { defaultModel } : {}),
  };

  // ---- the value to store ---------------------------------------------------
  const migrated: Record<string, unknown> = structuredClone(value);
  delete migrated.provider;
  migrated.enabled = enabled;
  migrated.keyPolicy = 'byok';
  // `providers.openai` is REPLACED, not merged: `allowedModels`, `defaultModel`
  // and the stored `baseUrl` leave with the old object, and the slot carries only
  // what the platform keeps. Other provider slots (there are none in a row this
  // application wrote) stay as they were.
  migrated.providers = { ...structuredClone(providers), openai: slot };
  if (defaultModel !== null) migrated.defaultModel = defaultModel;

  return {
    patch,
    migrated,
    models,
    alreadyMigrated: false,
    allowed: rawAllowed.length,
    skippedEntries,
    defaultModel,
  };
}

/** Report shape printed and written beside the snapshot. */
export interface AiLegacyReport {
  keys: {
    source: number;
    imported: number;
    alreadyImported: number;
    undecryptable: number;
    /** `importKey` threw for the row. Always zero on a healthy run; any other value fails the exit code. */
    failed: number;
    target: number;
  };
  models: { allowed: number; upserted: number; enabled: number };
  settings: { enabled: boolean; providerEnabled: boolean; defaultModel: string | null; taskModels: string[] };
  dryRun: boolean;
}
