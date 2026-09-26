// =============================================================================
// `kg.entity_digest` (#372, epic #347; docs/specs/ontology.md §9.2, §11, §15)
// =============================================================================
//
// THE ONLY PRODUCER OF BRIEF PROSE. A per-entity rolling summary: the previous
// digest's statements, plus the items it has not yet accounted for, plus the
// open (or recently closed) exclusive relations, go to the model as a numbered
// fact list `F1…Fn` (`brief-facts.ts`) — handles only, never uuids — and one
// `generateStructured` call returns statements that each cite handles.
// `citation-validation.ts` drops every statement citing nothing or an unknown
// handle; zero survivors fails the job and the previous digest is kept.
//
// -----------------------------------------------------------------------------
// `profile: { maxRuntimeMs: 5 min, maxAttempts: 1 }` — ONE ATTEMPT
// -----------------------------------------------------------------------------
//
// `note.generate`'s reason exactly: a retry would bill the owner's own key a
// second time for a non-deterministic answer. The brief GET's 15-minute
// failure backoff (`EntityBriefService`) is what keeps a failing provider from
// being re-billed on every view; a later view after that is the retry path.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY
// -----------------------------------------------------------------------------
//
// No `nodeResultSchema`/`persistNodeResult`: the call spends the owner's own
// long-lived AI key, and no vendor offers a job-scoped sub-key a
// `nodeSecretBroker` could mint instead — the same line `note.generate` draws.
//
// -----------------------------------------------------------------------------
// OUTCOMES
// -----------------------------------------------------------------------------
//
//   - a resolver 409 (graph off, AI not configured, no key, model lacks
//     structured output) → logged, RETURN NORMALLY — a domain outcome;
//   - entity missing, merged or no longer readable → return normally;
//   - `RateLimitError` → rethrown, deferred against the owner's per-user
//     bucket (`aiProviderThrottleKey`), registered immediately before the call;
//   - anything else (auth, refusal, invalid answer, all statements dropped)
//     → thrown, so the job is `failed` with `lastError` and the backoff applies.
//
// PRIVACY (§15): `sensitive` person facts never enter the prompt; `personal`
// ones only with the §14 personal-facts-in-prompts opt-in, which does not
// exist yet (#369's `graph` user-settings namespace defines none) — so today
// it is always false. When it is added, read it through the graph preferences
// service; never default it to true.
//
// ⚠ Logged: `{ entityId, model, promptTokens, completionTokens, dropped, ms }`.
// Never a label, a statement, the prompt or the answer.
// =============================================================================

import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';

import { AiInputError, AiAuthError } from '../../ai/ai-errors';
import { AiTaskModelResolver } from '../../ai/ai-task-model-resolver.service';
import { createProviderContext } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { READABLE_ENTITY_STATUSES } from '../read/readable';
import { KG_ENTITY_DIGEST_JOB_TYPE } from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { buildDigestFactList, DIGEST_FACT_EVIDENCE_IDS, DIGEST_MAX_FACTS, DIGEST_MAX_RELATION_FACTS } from './brief-facts';
import {
  buildDigestPrompt,
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_MAX_STATEMENTS,
  DIGEST_RESPONSE_SCHEMA,
  DIGEST_SCHEMA_NAME,
  DIGEST_TIMEOUT_MS,
} from './brief-prompt';
import { digestItems, digestRelations, evidenceIdsFor, newestChange, ownedEvidenceIds } from './brief-queries';
import { exclusiveRelationTypes } from './brief-sections';
import { readDigestStatements, validateDigestCitations } from './citation-validation';

export const ENTITY_DIGEST_MAX_RUNTIME_MS = 5 * 60_000;

/**
 * The §14 personal-facts-in-prompts opt-in. No preference defines it yet, so
 * it is `false` — and must never default to true.
 */
export const DIGEST_INCLUDE_PERSONAL_FACTS = false;

const payloadSchema = z.object({ entityId: z.uuid(), ownerId: z.uuid() });

/** The model's answer, validated — the provider returns parsed JSON, not checked JSON. */
const answerSchema = z.object({
  statements: z.array(z.object({ text: z.string(), factRefs: z.array(z.string()) })),
});

@Injectable()
export class EntityDigestHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(EntityDigestHandler.name);

  readonly type = KG_ENTITY_DIGEST_JOB_TYPE;

  readonly profile: JobExecutionProfile = { maxRuntimeMs: ENTITY_DIGEST_MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: AiTaskModelResolver,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
    private readonly ontology: GraphOntologyService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    // No `registerProviderKey` here: the bucket is PER USER, known only once a
    // job runs — registered in `process`, immediately before the call.
  }

  async process(job: Job): Promise<void> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      this.logger.warn(`Digest job ${job.id} has an unreadable payload; nothing to do`);
      return;
    }
    const { entityId, ownerId } = parsed.data;
    const started = Date.now();

    const entity = await this.prisma.kgEntity.findFirst({
      where: { id: entityId, ownerId },
      select: { id: true, type: true, label: true, reviewStatus: true, mergedIntoId: true },
    });
    if (
      !entity ||
      entity.mergedIntoId !== null ||
      !(READABLE_ENTITY_STATUSES as readonly string[]).includes(entity.reviewStatus)
    ) {
      this.logger.log(`Digest job ${job.id}: entity ${entityId} is gone, merged or not readable; nothing to do`);
      return;
    }

    // Admin task model, no per-run override: nobody is choosing a model for a background refresh.
    let resolution: Awaited<ReturnType<AiTaskModelResolver['resolve']>>;
    try {
      resolution = await this.resolver.resolve(ownerId, 'graph.digest');
    } catch (err) {
      if (err instanceof ConflictException || err instanceof BadRequestException) {
        const reason = (err.getResponse() as { details?: { reason?: string } }).details?.reason ?? 'unavailable';
        this.logger.log({ msg: 'entity digest skipped', entityId, reason });
        return;
      }
      throw err;
    }
    const { provider, model, policy } = resolution;
    if (typeof provider.generateStructured !== 'function') {
      this.logger.log({ msg: 'entity digest skipped', entityId, reason: 'no_structured_output' });
      return;
    }

    // -- Input ----------------------------------------------------------------
    const now = new Date();
    const schema = await this.ontology.effectiveSchemaFor(ownerId);
    const exclusive = exclusiveRelationTypes(schema.relationTypes);
    const exclusiveList = [...exclusive];
    const labelOf = (key: string) => schema.relationType(key)?.label ?? key;

    const previousRow = await this.prisma.kgEntityDigest.findFirst({ where: { entityId, ownerId } });
    const previous = previousRow ? await this.liveStatements(ownerId, previousRow.citations) : [];

    const [items, relations, change] = await Promise.all([
      digestItems(this.prisma, ownerId, entityId, previousRow, DIGEST_MAX_FACTS, DIGEST_INCLUDE_PERSONAL_FACTS),
      digestRelations(
        this.prisma,
        ownerId,
        entityId,
        exclusiveList,
        previousRow?.coversUntil ?? null,
        now,
        DIGEST_MAX_RELATION_FACTS,
      ),
      newestChange(this.prisma, ownerId, entityId, exclusiveList, now, DIGEST_INCLUDE_PERSONAL_FACTS),
    ]);

    const coversUntil = maxDate(previousRow?.coversUntil ?? null, change.at);
    const freshRelations = relations.filter(
      (r) =>
        !previousRow ||
        r.updatedAt.getTime() > previousRow.generatedAt.getTime() ||
        (r.validFrom !== null && r.validFrom.getTime() > previousRow.coversUntil.getTime()) ||
        (r.validTo !== null && r.validTo.getTime() > previousRow.coversUntil.getTime()),
    );

    if (previousRow && items.length === 0 && freshRelations.length === 0) {
      // Nothing new to say: move the markers, spend nothing.
      await this.prisma.kgEntityDigest.update({
        where: { entityId },
        data: { coversUntil: coversUntil ?? previousRow.coversUntil, generatedAt: now },
      });
      this.logger.log({ msg: 'entity digest unchanged', entityId, ms: Date.now() - started });
      return;
    }

    const evidence = await evidenceIdsFor(
      this.prisma,
      ownerId,
      { item: items.map((i) => i.id), relation: relations.map((r) => r.id) },
      DIGEST_FACT_EVIDENCE_IDS,
    );
    const factList = buildDigestFactList({
      previous,
      items: items.map((i) => ({ ...i, evidenceIds: evidence.get(`item:${i.id}`) ?? [] })),
      relations: relations.map((r) => ({
        typeLabel: labelOf(r.type),
        fromLabel: r.fromLabel,
        toLabel: r.toLabel,
        title: typeof r.props.title === 'string' ? r.props.title : null,
        validFrom: r.validFrom,
        validTo: r.validTo,
        evidenceIds: evidence.get(`relation:${r.id}`) ?? [],
      })),
      includePersonalFacts: DIGEST_INCLUDE_PERSONAL_FACTS,
    });

    if (factList.facts.length === 0) {
      this.logger.log({ msg: 'entity digest skipped', entityId, reason: 'no_facts' });
      return;
    }

    const prompt = buildDigestPrompt({
      entity: { label: entity.label, type: entity.type },
      facts: factList.facts,
      previousHandles: factList.previousHandles,
    });

    // -- The call, on the owner's own key -------------------------------------
    const settings = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) {
      throw new AiInputError(
        `This deployment's configuration for provider "${provider.id}" is invalid. An administrator must correct it first.`,
      );
    }
    const apiKey = await this.credentials.getSecret(ownerId, provider.id);
    if (!apiKey) {
      // The resolver saw a key a moment ago; it was removed since. A domain outcome.
      this.logger.log({ msg: 'entity digest skipped', entityId, reason: 'ai_key_missing' });
      return;
    }

    // ⚠ THE PER-USER BUCKET, immediately before the call: a 429 defers THIS owner's work only.
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(ownerId));

    let result: Awaited<ReturnType<NonNullable<typeof provider.generateStructured>>>;
    try {
      result = await provider.generateStructured(createProviderContext(apiKey, settings.data as never), {
        model,
        systemPrompt: prompt.systemPrompt,
        userContent: prompt.userContent,
        schema: DIGEST_RESPONSE_SCHEMA,
        schemaName: DIGEST_SCHEMA_NAME,
        maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
        timeoutMs: DIGEST_TIMEOUT_MS,
        reasoningEffort: resolution.reasoningEffort,
      });
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (err instanceof AiAuthError) {
        this.logger.warn({ msg: 'entity digest provider refused the key', entityId, model });
      }
      throw err;
    }

    const answer = answerSchema.safeParse(result.value);
    if (!answer.success) {
      throw new Error('The digest answer did not match the expected shape.');
    }

    // Throws DigestCitationError when nothing survives: the previous digest is kept.
    const validated = validateDigestCitations(
      answer.data.statements.slice(0, DIGEST_MAX_STATEMENTS * 2),
      factList.evidenceByHandle,
    );

    const citations = { version: 1, statements: validated.statements, dropped: validated.dropped };
    const data = {
      ownerId,
      summary: validated.statements.map((s) => s.text).join('\n'),
      citations: citations as unknown as Prisma.InputJsonObject,
      coversUntil: coversUntil ?? previousRow?.coversUntil ?? now,
      model,
      generatedAt: new Date(),
    };
    await this.prisma.kgEntityDigest.upsert({
      where: { entityId },
      create: { entityId, ...data },
      update: data,
    });

    this.logger.log({
      msg: 'entity digest written',
      entityId,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      dropped: validated.dropped,
      ms: Date.now() - started,
    });
  }

  /** The previous statements, keeping only evidence the owner still has. */
  private async liveStatements(ownerId: string, citations: unknown) {
    const statements = readDigestStatements(citations);
    const owned = await ownedEvidenceIds(this.prisma, ownerId, statements.flatMap((s) => s.evidenceIds));
    return statements
      .map((s) => ({ text: s.text, evidenceIds: s.evidenceIds.filter((id) => owned.has(id)) }))
      .filter((s) => s.evidenceIds.length > 0);
  }
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
