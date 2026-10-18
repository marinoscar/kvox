# tasks

The AI task vocabulary and the pure task-to-model chooser.

## Purpose and scope

`AI_TASK_KEYS`, `AI_REASONING_EFFORTS`, `AI_TASK_REASONING_EFFORTS` and the `ai.taskModels` schemas (`aiTaskModelSchema`, `aiTaskModelsSchema`); `AI_TASK_DEFINITIONS`, `taskDefinition`, `missingCapabilities`, `chooseTaskModel` (requested model, then the task's model, then the default, with the capability and graph-switch checks) and `toPlatformReasoningEffort` (`none` omits the parameter, `xhigh` is clamped to `high`). Pure: no I/O, so the run-time resolver, the admin view and the per-user probe can never disagree about which model a task runs on.

Status: moved from `apps/api/src/ai-port/ai-task-keys.ts` and `task-models.ts` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`zod` (the `ai.taskModels` schemas).

## Configuration

None. The policy and the enabled models are arguments.

## Extension-point catalog

None.

### Desktop

Pure; usable offline. Desktop feeds `chooseTaskModel` from its local settings through a `KvoxTaskModelSource`.
