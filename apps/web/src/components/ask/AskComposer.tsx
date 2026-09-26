/**
 * `AskComposer` — where a question is typed (#380; reused by #381's panel).
 *
 * Enter sends, Shift+Enter is a newline. At most 4,000 characters (#376's
 * `ASK_CONTENT_MAX_CHARS`), with a counter from 3,500. Send is disabled while
 * a turn is running — the API would answer 409 `ask_turn_running` anyway
 * (one running turn per conversation, index-enforced) — but the text box
 * stays editable so the next question can be drafted.
 *
 * THE TEXT IS KEPT UNTIL THE OWNER SAYS IT WAS SENT: `onSend` resolves `true`
 * to clear it, anything else (a 409, a network failure) leaves it exactly as
 * typed, with the owner's `alert` above it.
 *
 * THE MODEL. A "Model" button opens a picker over the deployment's
 * tool-capable models (`GET /api/ai/config` → `models` where `toolCalling`),
 * defaulting to the administrator's `graph.agent` model. `onSend` receives a
 * `model` ONLY when the user chose a different one — the server resolves the
 * default itself, and sending it explicitly would turn "use the deployment's
 * choice" into a pinned override. The choice is remembered per conversation
 * in `sessionStorage` (never `localStorage`: nothing about a conversation
 * outlives the tab on this device).
 */

import SendIcon from '@mui/icons-material/Send';
import TuneIcon from '@mui/icons-material/Tune';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { ModelSelect } from '../notes/ModelSelect';
import { ASK_CONTENT_MAX_CHARS } from '../../services/ask';
import type { AiConfig, AiConfigModel } from '../../services/ai';

/** The counter appears from here. */
export const ASK_COUNTER_FROM = 3500;

const MODEL_KEY_PREFIX = 'ask.model.';

/** The model a user picked for one conversation, if any (per tab). */
export function recallAskModel(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  try {
    return window.sessionStorage.getItem(MODEL_KEY_PREFIX + conversationId);
  } catch {
    return null;
  }
}

/** Remember (or, with `null`, forget) the model picked for one conversation. */
export function rememberAskModel(conversationId: string, model: string | null): void {
  try {
    if (model) window.sessionStorage.setItem(MODEL_KEY_PREFIX + conversationId, model);
    else window.sessionStorage.removeItem(MODEL_KEY_PREFIX + conversationId);
  } catch {
    // Storage blocked (private mode, an embedded preview): the choice lasts
    // for this page only, which is the honest fallback.
  }
}

/** The models Ask may use: tool-capable ones (#360's `toolCalling`). */
export function askModelOptions(config: AiConfig | null | undefined): AiConfigModel[] {
  return (config?.models ?? []).filter((model) => model.toolCalling !== false);
}

/** The administrator's `graph.agent` model, else the deployment default. */
export function askDefaultModel(config: AiConfig | null | undefined): string | null {
  return config?.taskModels?.['graph.agent']?.model ?? config?.defaultModel ?? null;
}

export interface AskComposerProps {
  /** Resolve `true` when the question was accepted (the text is cleared). */
  onSend: (content: string, model: string | undefined) => Promise<boolean> | boolean;
  /** A turn is running — Send is disabled. */
  running?: boolean;
  /** Disable everything (no key, Ask off). */
  disabled?: boolean;
  models: readonly AiConfigModel[];
  defaultModel: string | null;
  /** Keys the remembered model choice; `null` before the conversation exists. */
  conversationId: string | null;
  /** Shown above the text box (a 409's copy). */
  alert?: ReactNode;
  autoFocus?: boolean;
  /** Change to move focus back into the text box ("New conversation"). */
  focusKey?: unknown;
  placeholder?: string;
}

export function AskComposer({
  onSend,
  running = false,
  disabled = false,
  models,
  defaultModel,
  conversationId,
  alert,
  autoFocus = false,
  focusKey,
  placeholder = 'Ask about your meetings, people and projects…',
}: AskComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState<string | null>(() => recallAskModel(conversationId));
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const counterId = useId();
  const pickerId = useId();

  // A different conversation has its own remembered choice.
  useEffect(() => {
    setChosen(recallAskModel(conversationId));
  }, [conversationId]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, focusKey]);

  const available = models.some((model) => model.id === chosen) ? chosen : null;
  const effective = available ?? defaultModel ?? models[0]?.id ?? '';
  const effectiveLabel = models.find((model) => model.id === effective)?.label ?? 'Default';
  const override = available && available !== defaultModel ? available : undefined;

  const trimmed = text.trim();
  const canSend = !disabled && !running && !sending && trimmed.length > 0 && text.length <= ASK_CONTENT_MAX_CHARS;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const accepted = await onSend(trimmed, override);
      if (accepted) setText('');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const pickModel = (model: string) => {
    const next = model === defaultModel ? null : model;
    setChosen(next);
    if (conversationId) rememberAskModel(conversationId, next);
    setModelAnchor(null);
  };

  const showCounter = text.length >= ASK_COUNTER_FROM;

  return (
    <Box sx={{ pt: 1 }}>
      {alert && <Box sx={{ mb: 1 }}>{alert}</Box>}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
        <TextField
          inputRef={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          multiline
          minRows={1}
          maxRows={8}
          fullWidth
          size="small"
          slotProps={{
            htmlInput: {
              maxLength: ASK_CONTENT_MAX_CHARS,
              'aria-label': 'Your question',
              'aria-describedby': showCounter ? counterId : undefined,
            },
          }}
        />
        <IconButton
          aria-label="Send"
          color="primary"
          onClick={() => void send()}
          disabled={!canSend}
          sx={{ mb: 0.25 }}
        >
          {sending ? <CircularProgress size={20} aria-hidden /> : <SendIcon />}
        </IconButton>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 0.5, minHeight: 28 }}>
        {models.length > 0 ? (
          <Button
            size="small"
            color="inherit"
            startIcon={<TuneIcon fontSize="small" />}
            onClick={(event) => setModelAnchor(event.currentTarget)}
            aria-haspopup="dialog"
            aria-expanded={Boolean(modelAnchor)}
            aria-controls={modelAnchor ? pickerId : undefined}
            aria-label={`Model: ${effectiveLabel}`}
            disabled={disabled}
            sx={{ color: 'text.secondary', textTransform: 'none', minWidth: 0, maxWidth: '70%' }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {effectiveLabel}
            </Box>
          </Button>
        ) : (
          <span />
        )}
        {showCounter && (
          <Typography
            id={counterId}
            variant="caption"
            color={text.length >= ASK_CONTENT_MAX_CHARS ? 'error' : 'text.secondary'}
          >
            {text.length.toLocaleString()} / {ASK_CONTENT_MAX_CHARS.toLocaleString()}
          </Typography>
        )}
      </Stack>
      <Popover
        id={pickerId}
        open={Boolean(modelAnchor)}
        anchorEl={modelAnchor}
        onClose={() => setModelAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-label': 'Choose a model', sx: { p: 2, width: 300, maxWidth: 'calc(100vw - 32px)' } } }}
      >
        <ModelSelect
          value={effective}
          onChange={pickModel}
          models={[...models]}
          helperText={defaultModel && effective === defaultModel ? 'Your administrator’s default for Ask' : undefined}
        />
      </Popover>
    </Box>
  );
}

export default AskComposer;
