// =============================================================================
// AskToolset — the registry and executor (#377, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// The seven read-only tools the Ask agent (#378) may call, in a stable order,
// and the one place a model's tool call is executed:
//
//   execute(ctx, name, argumentsJson)
//     → unknown tool / malformed JSON / Zod failure / unresolvable handle /
//       a subject the caller can no longer see
//         → { ok: false, error, json }   — a short, model-readable message
//     → otherwise
//         → { ok: true, result, json }   — `json` compacted to the budget
//
// ⚠ NEVER THROWS FOR A MODEL MISTAKE. The model's arguments are untrusted
// (`AiToolCall.argumentsJson`), so every way they can be wrong is an
// `ok: false` the agent can read and recover from. A 4xx from a read service
// (the caller's own 404/400 conventions) is a model mistake too — an entity
// merged mid-turn, an unknown type key. Only a genuine bug (a 5xx other than
// the graph's statement timeout, a TypeError) propagates.
//
// READ-ONLY BY CONSTRUCTION: no tool depends on a write service (#355's
// `GraphWriteService`, #366's proposal commit, `JobsService`, an enqueuer) —
// `ask-toolset.spec.ts` asserts it from the constructors' own metadata.
//
// ⚠ Logs `{ tool, ok, resultCount, truncated, ms }` at debug — never the
// arguments' free text, never a result.
// =============================================================================

import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { ZodError } from 'zod';

import type { AiToolDefinition } from '../../ai/providers/ai-provider.interface';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { GraphPreferencesService } from '../../graph/preferences/graph-preferences.service';
import { AskToolError, type AskTool, type AskToolContext, type AskToolResult } from './ask-tool';
import { ASK_TOOL_RESULT_MAX_TOKENS, compactToBudget, estimateTokens, toolMessageBody } from './compact-result';
import { EntityBriefTool } from './entity-brief.tool';
import { EvidenceTool } from './evidence.tool';
import { GetEntityTool } from './get-entity.tool';
import { HandleRegistry } from './handle-registry';
import { ListCommitmentsTool } from './list-commitments.tool';
import { NeighborsTool } from './neighbors.tool';
import { SearchTool } from './search.tool';
import { personalFactsAllowedFor } from './sensitivity';
import { TimelineTool } from './timeline.tool';

export type AskToolExecution =
  | { ok: true; result: AskToolResult; json: string }
  | { ok: false; error: string; json: string };

/** The tool names, in the order `definitions()` lists them. Permanent: #378's prompts and #382's evals name them. */
export const ASK_TOOL_NAMES = [
  'search',
  'get_entity',
  'neighbors',
  'timeline',
  'evidence',
  'entity_brief',
  'list_commitments',
] as const;
export type AskToolName = (typeof ASK_TOOL_NAMES)[number];

/** Longest raw arguments string accepted (a model that sends more is not calling these tools correctly). */
export const ASK_TOOL_ARGUMENTS_MAX_CHARS = 8_000;

@Injectable()
export class AskToolset {
  private readonly logger = new Logger(AskToolset.name);
  private readonly tools: ReadonlyMap<string, AskTool<unknown>>;

  constructor(
    search: SearchTool,
    getEntity: GetEntityTool,
    neighbors: NeighborsTool,
    timeline: TimelineTool,
    evidence: EvidenceTool,
    entityBrief: EntityBriefTool,
    listCommitments: ListCommitmentsTool,
    private readonly preferences: GraphPreferencesService,
  ) {
    const all = [search, getEntity, neighbors, timeline, evidence, entityBrief, listCommitments] as AskTool<unknown>[];
    this.tools = new Map(all.map((t) => [t.name, t]));
  }

  /** Name, description and strict JSON Schema of all seven tools, in `ASK_TOOL_NAMES` order. */
  definitions(): AiToolDefinition[] {
    return ASK_TOOL_NAMES.map((name) => {
      const tool = this.tools.get(name)!;
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    });
  }

  /**
   * A fresh context for one assistant turn: a new handle registry, and the
   * §14 opt-in resolved from the caller's graph preferences.
   */
  async createContext(
    user: RequestUser,
    opts: { scopeEntityId?: string | null; now?: Date; countTokens?: (text: string) => number } = {},
  ): Promise<AskToolContext> {
    const prefs = await this.preferences.get(user.id);
    return {
      user,
      handles: new HandleRegistry(),
      personalFactsAllowed: personalFactsAllowedFor(prefs),
      scopeEntityId: opts.scopeEntityId ?? null,
      now: opts.now ?? new Date(),
      ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
    };
  }

  async execute(ctx: AskToolContext, name: string, argumentsJson: string): Promise<AskToolExecution> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return this.fail(name, started, `Unknown tool "${String(name).slice(0, 64)}". Available tools: ${ASK_TOOL_NAMES.join(', ')}.`);
    }

    const parsed = parseArguments(argumentsJson);
    if (!parsed.ok) return this.fail(name, started, parsed.error);

    const input = tool.input.safeParse(parsed.value);
    if (!input.success) return this.fail(name, started, `Invalid arguments for ${name}: ${formatZodError(input.error)}`);

    let result: AskToolResult;
    try {
      result = await tool.run(ctx, input.data);
    } catch (err) {
      const message = modelReadableError(err);
      if (message === null) throw err;
      return this.fail(name, started, message);
    }

    const countTokens = ctx.countTokens ?? estimateTokens;
    const compacted = compactToBudget(toolMessageBody(result.data, result.truncated), countTokens, ASK_TOOL_RESULT_MAX_TOKENS);
    const final: AskToolResult = { ...result, truncated: compacted.truncated };
    this.logger.debug({
      msg: 'ask tool call',
      tool: name,
      ok: true,
      resultCount: final.resultCount,
      truncated: final.truncated,
      ms: Date.now() - started,
    });
    return { ok: true, result: final, json: compacted.json };
  }

  private fail(tool: string, started: number, error: string): AskToolExecution {
    this.logger.debug({ msg: 'ask tool call', tool: String(tool).slice(0, 64), ok: false, ms: Date.now() - started });
    return { ok: false, error, json: JSON.stringify({ error }) };
  }
}


function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Arguments must be a JSON object.' };
  if (raw.length > ASK_TOOL_ARGUMENTS_MAX_CHARS) return { ok: false, error: 'Arguments are too long.' };
  const text = raw.trim() === '' ? '{}' : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Arguments were not valid JSON. Send one JSON object matching the tool's parameters." };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Arguments must be a JSON object.' };
  }
  return { ok: true, value };
}

/** `entity: expected string; limit: too big` — paths and messages only, never the rejected values. */
export function formatZodError(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join('.') : 'arguments'}: ${i.message}`)
    .join('; ');
}

/** A thrown error the model can act on, as text; `null` for a real bug. */
export function modelReadableError(err: unknown): string | null {
  if (err instanceof AskToolError) return err.message;
  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404) return 'That reference is no longer available (it may have been merged or removed).';
    if (status === 403) return 'You do not have access to that.';
    if (status === 503) return 'The graph query took too long. Try a narrower question (fewer hops, a smaller limit).';
    if (status >= 400 && status < 500) return httpMessage(err);
  }
  return null;
}

function httpMessage(err: HttpException): string {
  const body = err.getResponse();
  if (typeof body === 'string') return body.slice(0, 300);
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message.slice(0, 300);
  if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join('; ').slice(0, 300);
  return 'The request was not valid.';
}
