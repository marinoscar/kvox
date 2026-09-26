/**
 * "Task models" — the per-task model map `ai.taskModels` on
 * `/admin/settings/ai` (issue #361, contract from #360; spec
 * `docs/specs/ontology.md` §20).
 *
 * One row per connected-knowledge task, IN THE ORDER THE API LISTS THEM and
 * with the API's own label and description: `AiSettingsAdminView.tasks` is the
 * single source of that copy, so nothing here hardcodes a task name.
 *
 * =============================================================================
 * THE THREE STATES A ROW CAN BE IN, AND WHICH ONES BLOCK A SAVE
 * =============================================================================
 *
 *   • A MODEL NO LONGER PERMITTED. The row's current value is not in the
 *     page's DRAFT permitted list — somebody removed it above. It stays a
 *     visible, selectable option (dropping it would silently put the task back
 *     on Default, a policy change nobody asked for) and it is flagged. This one
 *     BLOCKS the save — {@link taskModelsHaveError} — exactly like the page's
 *     `defaultModel` handling, which this mirrors.
 *
 *   • A MODEL THAT LACKS A CAPABILITY the task requires. A WARNING, never a
 *     blocker: the server enforces it on save (400 `model_lacks_capability`)
 *     and the administrator may be mid-change. Hiding incapable models from the
 *     select was rejected — a warning teaches WHY a model is unsuitable, a
 *     missing option does not.
 *
 *   • A MODEL WHOSE CAPABILITIES ARE UNKNOWN — one added to the permitted list
 *     in this unsaved draft and absent from the catalogue. The page cannot
 *     judge it, so it says the server will.
 *
 * Default is the empty string in the select and an ABSENT KEY in the map: the
 * API replaces `taskModels` wholesale, so dropping a key is how a task returns
 * to Default. A per-task reasoning effort only exists alongside an explicit
 * model; on Default the page-wide reasoning setting applies.
 *
 * No `useMediaQuery`: each row stacks through responsive `Stack` props alone,
 * so Settings UI Pattern rule 5's five coupled gates are untouched.
 */

import {
  Alert,
  Box,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Fragment } from 'react';

import type {
  AiModelCapability,
  AiTaskDefinition,
  AiTaskKey,
  AiTaskModel,
  AiTaskModelStatus,
  AiTaskReasoningEffort,
} from '../../services/ai';

export type TaskModelsDraft = Partial<Record<AiTaskKey, AiTaskModel>>;

export type ModelCapabilityFlags = Record<AiModelCapability, boolean>;

export interface AiTaskModelsProps {
  tasks: AiTaskDefinition[];
  value: TaskModelsDraft;
  onChange: (next: TaskModelsDraft) => void;
  /** The page's CURRENT DRAFT permitted list — not the saved one. */
  permittedModelIds: string[];
  defaultModel: string;
  /** Flags per model id; `undefined` means "not known until the server sees it". */
  capabilities: Record<string, ModelCapabilityFlags | undefined>;
  /** The server's view of the SAVED policy, one entry per task. */
  status: AiTaskModelStatus[];
  /** The task a save 400 named in `details.task`, if any. */
  serverErrorTask: AiTaskKey | null;
  disabled: boolean;
}

/** Display names for the two capability flags. Capabilities, not tasks — the API names tasks. */
export const CAPABILITY_LABELS: Record<AiModelCapability, string> = {
  structuredOutput: 'Structured output',
  toolCalling: 'Tool calling',
};

const REASONING_OPTIONS: ReadonlyArray<{ value: AiTaskReasoningEffort | ''; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * True when any task names a model the draft no longer permits — the one
 * state in this section that blocks a save.
 */
export function taskModelsHaveError(value: TaskModelsDraft, permittedModelIds: string[]): boolean {
  return Object.values(value).some(
    (entry) => !!entry && entry.model !== '' && !permittedModelIds.includes(entry.model)
  );
}

/**
 * The `taskModels` request body: the full map, OMITTING tasks left on Default
 * and omitting `reasoningEffort` when it is Default. The API replaces the map
 * wholesale, so an omitted task is a task on Default.
 */
export function toTaskModelsInput(value: TaskModelsDraft): TaskModelsDraft {
  const out: TaskModelsDraft = {};
  for (const [key, entry] of Object.entries(value) as Array<[AiTaskKey, AiTaskModel | undefined]>) {
    if (!entry || entry.model.trim() === '') continue;
    out[key] = entry.reasoningEffort
      ? { model: entry.model.trim(), reasoningEffort: entry.reasoningEffort }
      : { model: entry.model.trim() };
  }
  return out;
}

function joinCapabilities(missing: AiModelCapability[]): string {
  return missing.map((capability) => CAPABILITY_LABELS[capability]).join(' or ');
}

export function AiTaskModels({
  tasks,
  value,
  onChange,
  permittedModelIds,
  defaultModel,
  capabilities,
  status,
  serverErrorTask,
  disabled,
}: AiTaskModelsProps) {
  const setTask = (key: AiTaskKey, next: AiTaskModel | undefined) => {
    const copy: TaskModelsDraft = { ...value };
    if (next) copy[key] = next;
    else delete copy[key];
    onChange(copy);
  };

  return (
    <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h2" gutterBottom>
        Task models
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose which permitted model runs each connected-knowledge task. Leave a task on “Default”
        to use the default model. Users can pick another permitted model for their own runs.
      </Typography>

      {tasks.map((task, index) => {
        const entry = value[task.key];
        const selected = entry?.model ?? '';
        const isDefault = selected === '';
        const isStale = !isDefault && !permittedModelIds.includes(selected);
        const isServerError = serverErrorTask === task.key;

        const effectiveModel = isDefault ? defaultModel : selected;
        const flags = effectiveModel ? capabilities[effectiveModel] : undefined;
        const missing = flags
          ? task.requires.filter((capability) => flags[capability] === false)
          : [];
        const serverStatus = status.find((row) => row.task === task.key);
        const showFallbackNote =
          serverStatus?.source === 'default' && serverStatus.configuredModel !== null;

        const modelOptions = isStale ? [selected, ...permittedModelIds] : permittedModelIds;
        const modelHelper = isStale
          ? 'No longer permitted — choose another or use Default'
          : isServerError
            ? 'The last save was refused for this task — see the message below.'
            : undefined;

        return (
          <Fragment key={task.key}>
            {index > 0 && <Divider sx={{ my: 2 }} />}
            <Box data-testid={`task-model-row-${task.key}`}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' } }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" component="h3">
                    {task.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {task.description}
                  </Typography>
                  {task.requires.length > 0 && (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
                      {task.requires.map((capability) => (
                        <Chip
                          key={capability}
                          size="small"
                          variant="outlined"
                          label={CAPABILITY_LABELS[capability]}
                        />
                      ))}
                    </Stack>
                  )}
                </Box>

                <TextField
                  select
                  label={`Model for ${task.label}`}
                  value={selected}
                  onChange={(event) => {
                    const model = event.target.value;
                    if (model === '') {
                      setTask(task.key, undefined);
                      return;
                    }
                    setTask(
                      task.key,
                      entry?.reasoningEffort
                        ? { model, reasoningEffort: entry.reasoningEffort }
                        : { model }
                    );
                  }}
                  disabled={disabled}
                  error={isStale || isServerError}
                  helperText={modelHelper}
                  sx={{ width: { xs: '100%', sm: 240 }, flexShrink: 0 }}
                >
                  <MenuItem value="">{`Default (${defaultModel})`}</MenuItem>
                  {modelOptions.map((model) => (
                    <MenuItem key={model} value={model}>
                      {model}
                    </MenuItem>
                  ))}
                </TextField>

                <TextField
                  select
                  label={`Reasoning for ${task.label}`}
                  value={isDefault ? '' : (entry?.reasoningEffort ?? '')}
                  onChange={(event) => {
                    if (!entry) return;
                    const effort = event.target.value as AiTaskReasoningEffort | '';
                    setTask(
                      task.key,
                      effort === ''
                        ? { model: entry.model }
                        : { model: entry.model, reasoningEffort: effort }
                    );
                  }}
                  // On Default the page-wide reasoning setting applies, so there
                  // is nothing per-task to choose.
                  disabled={disabled || isDefault}
                  sx={{ width: { xs: '100%', sm: 160 }, flexShrink: 0 }}
                >
                  {REASONING_OPTIONS.map((option) => (
                    <MenuItem key={option.value || 'default'} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>

              {missing.length > 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {effectiveModel} can&apos;t do {joinCapabilities(missing)}, which {task.label}{' '}
                  needs. Users will get an error until you choose a model that can.
                </Alert>
              )}
              {effectiveModel && !flags && task.requires.length > 0 && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                  Capabilities are checked when you save.
                </Typography>
              )}
              {showFallbackNote && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                  Configured model {serverStatus?.configuredModel} is no longer permitted; using the
                  default.
                </Typography>
              )}
            </Box>
          </Fragment>
        );
      })}
    </Paper>
  );
}

export default AiTaskModels;
