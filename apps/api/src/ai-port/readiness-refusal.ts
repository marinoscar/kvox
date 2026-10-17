import { taskDefinition, type AiTaskKey, type KvoxAiReadiness } from '@marinoscar/kvox-ai';

import {
  graphDisabledConflict,
  keyMissingConflict,
  lacksCapabilityConflict,
  notConfiguredConflict,
  notPermittedBadRequest,
} from './kvox-ai-errors';

// =============================================================================
// readinessRefusal: a not-ready `KvoxAi.readiness()` as the product's 409 / 400
// =============================================================================
//
// Every route and handler that gates on a connected-knowledge task answers a
// not-ready readiness with the same bodies (`details.reason` = `graph_disabled`,
// `ai_not_configured`, `ai_key_missing`, `model_not_permitted`,
// `model_lacks_capability`), built from the same sentences. This is the one
// mapping from the readiness `reason` to those exceptions, so the graph's run
// resolver and the Ask route cannot drift apart.
//
// The two refusals that name models need data `readiness()` does not carry, so the
// caller supplies it lazily (a database read only the refusing path pays for):
//   • `permittedModels`    the enabled model ids, for `model_not_permitted`;
//   • `lacksCapability`    the chosen model and what it lacks, for
//                          `model_lacks_capability`. Absent: the readiness model
//                          and everything the task requires.
// =============================================================================

export interface ReadinessRefusalInput {
  /** The task the readiness was asked for. */
  task: AiTaskKey;
  readiness: Pick<KvoxAiReadiness, 'reason' | 'model'>;
  /** The per-run model pick the caller asked for, if any. */
  requested: string | null;
  permittedModels: () => Promise<readonly string[]>;
  lacksCapability?: () => Promise<{ model: string | null; missing: readonly string[] }>;
}

export async function readinessRefusal(input: ReadinessRefusalInput): Promise<Error> {
  const definition = taskDefinition(input.task);
  const subject = { label: definition.label };

  switch (input.readiness.reason) {
    case 'graph_disabled':
      return graphDisabledConflict();
    case 'ai_key_missing':
      return keyMissingConflict(subject);
    case 'model_not_permitted':
      return notPermittedBadRequest({
        model: input.requested ?? input.readiness.model,
        permitted: await input.permittedModels(),
        task: input.task,
      });
    case 'model_lacks_capability': {
      const lacking = input.lacksCapability
        ? await input.lacksCapability()
        : { model: input.readiness.model, missing: definition.requires };
      return lacksCapabilityConflict({
        subject,
        task: input.task,
        model: lacking.model ?? input.readiness.model ?? 'unknown',
        missing: lacking.missing,
      });
    }
    default:
      return notConfiguredConflict(subject);
  }
}
