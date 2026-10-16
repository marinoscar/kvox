/**
 * The app's own sections of `/admin/settings/ai` (issue #477, epic #472).
 *
 * The page is the platform's `AiConfigPage` (the master switch, key policy,
 * providers and their keys, hosted tools, rate limits). What the platform has no
 * word for stays here and is mounted in that page's `Sections` slot, in this
 * order:
 *
 *   1. {@link AiGraphSettings}  the `graphEnabled` switch and who pays
 *   2. {@link AiTaskModels}     the model (and effort) per connected-knowledge task
 *   3. {@link AiModelLimits}    the default model, the ceilings, the reasoning effort
 *
 * They are CONTENT inside one destination, not a tab and not a card of their
 * own (Settings UI Pattern rules 1 and 2). They share ONE draft and ONE Save,
 * because they are one document, the app's extension of the platform `ai`
 * namespace, read and written through `GET|PUT /api/ai-tasks/settings`
 * (`services/aiTasks.ts`).
 *
 * SAVING IS GATED INSIDE, NOT ON THE CARD. The card shows for `ai_config:read`;
 * without `ai_config:write` every control stays visible and DISABLED, and the
 * page says so, because an admin diagnosing "why was my note refused" needs to
 * see the switch that is off.
 *
 * WHAT IS READ FROM WHERE. Everything on the page comes from ONE response,
 * `GET /api/ai-tasks/settings`: the document, the task copy, the enabled models
 * with their capability flags (so an administrator cannot choose a model nobody
 * can run) and, per task, what the saved policy resolves to (computed by the
 * server without the `graphEnabled` gate, so tasks can be configured before the
 * feature is switched on). "Is AI switched on" comes from the platform's
 * shell-wide AI config (`useAiFeatures`), the switch on the page above, never
 * fetched here.
 *
 * A save refreshes the navigation features, so the `knowledge` destination
 * follows the `graphEnabled` switch without a reload. The browser never calls a
 * provider.
 *
 * No `useMediaQuery`: nothing here re-gates on a breakpoint (rule 5).
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { useAiFeatures } from '@marinoscar/platform-web/ai/headless';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';

import { useGraphFeature } from '../../platform/GraphFeatureBinding';
import { useAiTasksSettings } from '../../hooks/useAiTasksSettings';
import { AI_TASK_KEYS } from '../../services/aiTasks';
import type { AiTaskKey } from '../../services/aiTasks';
import { AiGraphSettings } from './AiGraphSettings';
import { AiModelLimits, limitsHaveError, toLimitsDraft, toLimitsInput, validateLimits } from './AiModelLimits';
import type { AiLimitsDraft } from './AiModelLimits';
import { AiTaskModels, taskModelsHaveError, toTaskModelsInput } from './AiTaskModels';
import type { ModelCapabilityFlags, TaskModelsDraft } from './AiTaskModels';

export function AiTasksSettingsSections() {
  const { hasPermission } = usePermissions();
  const { ai: aiEnabled } = useAiFeatures();
  const { refresh: refreshNavigationFeatures } = useGraphFeature();
  const { data, isLoading, loadError, isSaving, saveError, saveErrorDetails, save, clearSaveError } =
    useAiTasksSettings();

  const canWrite = hasPermission('ai_config:write');

  const [graphEnabled, setGraphEnabled] = useState(false);
  const [taskModels, setTaskModels] = useState<TaskModelsDraft>({});
  const [limits, setLimits] = useState<AiLimitsDraft | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // Adopt a freshly loaded (or freshly saved, or reloaded-after-409) document.
  useEffect(() => {
    if (!data) return;
    setGraphEnabled(data.settings.graphEnabled);
    setTaskModels(data.settings.taskModels);
    setLimits(toLimitsDraft(data.settings));
  }, [data]);

  const models = useMemo(() => data?.models ?? [], [data]);
  const modelIds = useMemo(() => models.map((model) => model.id), [models]);

  const capabilities = useMemo(() => {
    const map: Record<string, ModelCapabilityFlags | undefined> = {};
    for (const model of models) {
      map[model.id] = {
        structuredOutput: model.structuredOutput,
        toolCalling: model.toolCalling,
      };
    }
    return map;
  }, [models]);

  // The task a save 400 named in `details.task`, if it is one this page renders.
  const serverErrorTask = useMemo((): AiTaskKey | null => {
    if (typeof saveErrorDetails !== 'object' || saveErrorDetails === null) return null;
    const task = (saveErrorDetails as { task?: unknown }).task;
    return typeof task === 'string' && (AI_TASK_KEYS as readonly string[]).includes(task)
      ? (task as AiTaskKey)
      : null;
  }, [saveErrorDetails]);

  if (isLoading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress aria-label="Loading AI task settings" />
      </Box>
    );
  }

  if (!data || !limits) {
    return loadError ? (
      <Alert severity="error" sx={{ mt: 3 }}>
        {loadError}
      </Alert>
    ) : null;
  }

  const limitErrors = validateLimits(limits, modelIds);
  const taskError = taskModelsHaveError(taskModels, modelIds);
  const hasError = limitsHaveError(limitErrors) || taskError;

  const saveBlockers: string[] = [];
  if (taskError) {
    saveBlockers.push('a task using a model that is no longer enabled, under “Task models”');
  }
  if (limitsHaveError(limitErrors)) {
    saveBlockers.push('a value that is out of range or a default model that is not enabled, under “Limits and default model”');
  }

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || hasError) return;

    const ok = await save({
      graphEnabled,
      // Wholesale, with Default rows and Default reasoning efforts OMITTED: the
      // API replaces the map, so an omitted task is a task on Default.
      taskModels: toTaskModelsInput(taskModels),
      ...toLimitsInput(limits),
    });
    if (ok) {
      setSavedMessage('AI task settings saved');
      void refreshNavigationFeatures();
    }
  };

  return (
    <Box
      component="form"
      onSubmit={handleSave}
      noValidate
      aria-label="Connected knowledge, task models and limits"
    >
      <Typography variant="h5" component="h2" sx={{ mt: 4 }}>
        Tasks and limits
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5 }}>
        Which model each connected-knowledge task runs on, the default model, and the ceilings
        every generation runs under.
        {!canWrite && ' (read-only)'}
      </Typography>

      <AiGraphSettings
        value={graphEnabled}
        onChange={setGraphEnabled}
        aiEnabled={aiEnabled}
        disabled={!canWrite}
      />

      <AiTaskModels
        tasks={data.tasks}
        value={taskModels}
        onChange={setTaskModels}
        permittedModelIds={modelIds}
        defaultModel={limits.defaultModel.trim()}
        capabilities={capabilities}
        status={data.taskModelStatus}
        serverErrorTask={serverErrorTask}
        disabled={!canWrite}
      />

      <AiModelLimits
        value={limits}
        onChange={setLimits}
        errors={limitErrors}
        models={models.map((model) => ({ id: model.id, label: model.label }))}
        disabled={!canWrite}
      />

      {saveError && (
        <Alert severity="error" sx={{ mt: 3 }} onClose={clearSaveError}>
          <AlertTitle>Could not save</AlertTitle>
          {saveError}
        </Alert>
      )}

      <Box
        sx={{
          mt: 3,
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: 2,
        }}
      >
        <Button
          type="submit"
          variant="contained"
          disabled={!canWrite || isSaving || hasError}
          aria-describedby={hasError ? 'ai-tasks-save-blocked-reason' : undefined}
        >
          {isSaving ? 'Saving…' : 'Save task settings'}
        </Button>
        {/* A DISABLED PRIMARY CONTROL MUST SAY WHY: the cause is a field in a
            different `Paper`, which otherwise reads as a broken page. */}
        {hasError && (
          <Typography
            id="ai-tasks-save-blocked-reason"
            variant="body2"
            color="error"
            sx={{ flexGrow: 1 }}
          >
            Save is unavailable until you fix {saveBlockers.join(' and ')} — highlighted in red
            above.
          </Typography>
        )}
      </Box>

      <Snackbar
        open={!!savedMessage}
        autoHideDuration={3000}
        onClose={() => setSavedMessage(null)}
        message={savedMessage}
      />
    </Box>
  );
}

export default AiTasksSettingsSections;
