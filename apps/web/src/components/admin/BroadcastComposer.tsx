/**
 * Compose an announcement for every active user (issue #325, epic #319).
 *
 * This is the only control in the application that reaches every user at once
 * and cannot be undone, so the dialog is built around three obligations rather
 * than around the form fields:
 *
 *   1. **Show what will be sent.** A live preview of what the bell will render,
 *      paragraph splitting included, because the body's one formatting rule
 *      (blank lines separate paragraphs) is invisible in a textarea.
 *   2. **Say how many people that is.** One plain-English line from
 *      `GET /audience`, in the composer and again in the confirmation.
 *   3. **Refuse what the API would refuse, before it is sent.** Every rule the
 *      DTO enforces is mirrored here as a disabled control or an inline error,
 *      so an administrator cannot produce a 400 they could have been prevented
 *      from producing.
 *
 * =============================================================================
 * THE MIRRORED RULES, AND WHERE THEY COME FROM
 * =============================================================================
 *
 * All from `apps/api/src/notifications/broadcasts/dto/create-broadcast.dto.ts`:
 *
 *   * title ≤ 120, body ≤ 2,000, ctaLabel ≤ 40, link ≤ 500 — counters, and the
 *     constants are imported from `services/broadcasts.ts` rather than typed
 *     here, so a counter cannot promise an acceptance the API will refuse.
 *   * `ctaLabel` requires `link` — the CTA field is disabled until a link is
 *     present, because the email template silently DROPS a label with no URL
 *     and the admin would see a button here and none in the mail.
 *   * `link` must be root-relative, not protocol-relative, no `/\`, no spaces
 *     or control characters — validated on blur, with the API's own reasons.
 *   * `critical ⇒ channels includes 'browser'` — the Important switch FORCES
 *     In-app on and locks it. Mirrored as a forced control rather than as a
 *     validation message because there is no state in which an admin would
 *     rather have the 400: a critical announcement with no durable in-app row
 *     is unreadable by anyone who missed the mail.
 *   * `scheduledFor` strictly in the future — a `min` on the input plus a
 *     submit-time check, since `min` on a native datetime input is advisory in
 *     several browsers.
 *   * at least one channel — submit disabled at zero.
 *
 * =============================================================================
 * THE TRI-STATE READ ON `useNotificationConfig`
 * =============================================================================
 *
 * `config` is `null` until the first read resolves, and that is NOT "disabled".
 * Both reads below are therefore `=== false` and never `!config?.x`, per that
 * hook's own header: the negated form reads `true` during the loading window,
 * which would flicker a warning banner and a disabled Push checkbox into
 * existence on every open of this dialog.
 *
 *   * `pushEnabled === false` → the Push checkbox is DISABLED with a tooltip. A
 *     deployment with no VAPID keys has no push channel registered at all, so
 *     offering the box would produce a broadcast that silently drops a channel
 *     the admin believed they had selected.
 *   * `browserEnabled === false` → a warning beside In-app, and only a warning.
 *     The kill switch mutes the OS toast; the durable in-app row is still
 *     written, and scheduling an announcement for after the switch is flipped
 *     back is legitimate — which is exactly why the API treats this as a
 *     non-fatal `warnings` entry rather than a 400.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import {
  BROADCAST_BODY_MAX,
  BROADCAST_CTA_LABEL_MAX,
  BROADCAST_LINK_MAX,
  BROADCAST_TITLE_MAX,
  isoToLocalInput,
  localInputToIso,
} from '../../services/broadcasts';
import type { CreateBroadcastRequest } from '../../services/broadcasts';
import type { NotificationChannel } from '../../types';
import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import { channelLabel } from '../../pages/Admin/broadcastsTable';

/**
 * The channels offered, in the order they are drawn.
 *
 * In-app first because it is the only one that leaves a record the recipient
 * can go back and read, and the only one a critical broadcast may not omit.
 */
const CHANNEL_ORDER: NotificationChannel[] = ['browser', 'email', 'push'];

/** Default selection for a fresh composition: the durable row plus mail. */
const DEFAULT_CHANNELS: NotificationChannel[] = ['browser', 'email'];

/**
 * `sanitizeLink`'s forbidden set, restated from the DTO: C0 controls, space,
 * and DEL. See the DTO's own header for why the rule lives in two places — the
 * channel's copy is the security boundary and drops a bad link silently; this
 * copy exists purely to produce a fixable message at compose time.
 */
const FORBIDDEN_LINK_CHARS = /[\u0000-\u0020\u007F]/;

/** The API's `rootRelativeLink` refinements, in the order they are reported. */
export function validateLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > BROADCAST_LINK_MAX) {
    return `Links are limited to ${BROADCAST_LINK_MAX} characters.`;
  }
  if (FORBIDDEN_LINK_CHARS.test(value)) {
    return 'Links must not contain spaces or control characters.';
  }
  if (!value.startsWith('/')) {
    // Named explicitly, because "https://status.example.com" is the natural
    // thing to paste and the reason it is refused is not obvious.
    return 'Links must point inside this application and start with "/" — for example /status.';
  }
  if (value.startsWith('//')) {
    return 'A link starting with "//" is a link to another site. Use a single leading slash.';
  }
  if (value.startsWith('/\\')) {
    return 'A link starting with "/\\" is treated as another site by some browsers.';
  }
  return null;
}

/** `now + 1 minute`, as a `datetime-local` value, for the field's `min`. */
export function earliestSchedule(now: Date = new Date()): string {
  return isoToLocalInput(new Date(now.getTime() + 60_000).toISOString());
}

interface BroadcastComposerProps {
  open: boolean;
  onClose: () => void;
  /** `null` until `GET /audience` resolves — never rendered as 0. */
  audience: number | null;
  isWorking: boolean;
  /** Resolves truthy when the broadcast was queued; the composer then closes. */
  onSubmit: (body: CreateBroadcastRequest) => Promise<boolean>;
  /** Resolves truthy when the test send was dispatched. Does NOT close. */
  onSendTest: (body: CreateBroadcastRequest) => Promise<boolean>;
}

export function BroadcastComposer({
  open,
  onClose,
  audience,
  isWorking,
  onSubmit,
  onSendTest,
}: BroadcastComposerProps) {
  const theme = useTheme();
  // The `down('sm')` compact-window convention, shared with `SettingsHub.tsx`
  // and `AppBar.tsx` — one of the five coupled gates CLAUDE.md rule 5 names.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const { config } = useNotificationConfig();
  // See the file header: `=== false`, never `!config?.x`. `null` means "we do
  // not know yet", which is not the same answer as "off".
  const pushUnavailable = config?.pushEnabled === false;
  const browserToastsDisabled = config?.browserEnabled === false;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [ctaLabel, setCtaLabel] = useState('');
  const [channels, setChannels] = useState<NotificationChannel[]>(DEFAULT_CHANNELS);
  const [critical, setCritical] = useState(false);
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  const [scheduleInput, setScheduleInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  /**
   * Clear the TRANSIENT state on open — and only that.
   *
   * The composition itself survives a close, deliberately: a dialog that
   * reopens holding the last attempt's text is exactly what an admin wants
   * after a 400 they had to go and check something for, and wiping it on close
   * would do so visibly, during the closing animation. What must not survive is
   * the state that describes the LAST interaction rather than the draft — a
   * stale "test sent" banner over a body that has since been rewritten, a
   * blur-triggered link error on a field the admin has not returned to, or a
   * confirmation dialog left open. Keyed on `open` alone so a re-render while
   * open never clears what is being typed.
   */
  useEffect(() => {
    if (!open) return;
    setLinkTouched(false);
    setConfirming(false);
    setTestNotice(null);
  }, [open]);

  /**
   * The critical ⇒ In-app rule, applied as STATE rather than as validation.
   *
   * Turning Important on adds `browser` to the selection immediately, and the
   * checkbox below is disabled while it is on. Mirrors the API's superRefine,
   * so the 400 it would raise is unreachable from this form.
   */
  useEffect(() => {
    if (!critical) return;
    setChannels((current) => (current.includes('browser') ? current : [...current, 'browser']));
  }, [critical]);

  /** Push cannot be selected on a deployment that has no push channel at all. */
  useEffect(() => {
    if (!pushUnavailable) return;
    setChannels((current) =>
      current.includes('push') ? current.filter((channel) => channel !== 'push') : current,
    );
  }, [pushUnavailable]);

  const linkError = linkTouched ? validateLink(link) : null;
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  const trimmedLink = link.trim();

  /** The `min` for the schedule field, computed once per open. */
  const minSchedule = useMemo(() => (open ? earliestSchedule() : ''), [open]);

  /**
   * The instant the schedule field resolves to, or `null`.
   *
   * `datetime-local` is local wall-clock with no zone, so this is the only
   * place the admin's typing becomes an instant — see `services/broadcasts.ts`.
   */
  const scheduledIso = timing === 'later' ? localInputToIso(scheduleInput) : null;
  const scheduleInPast =
    timing === 'later' && scheduledIso !== null && new Date(scheduledIso).getTime() <= Date.now();
  const scheduleMissing = timing === 'later' && scheduledIso === null;

  const canSubmit =
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= BROADCAST_TITLE_MAX &&
    trimmedBody.length > 0 &&
    trimmedBody.length <= BROADCAST_BODY_MAX &&
    channels.length > 0 &&
    validateLink(link) === null &&
    !scheduleMissing &&
    !scheduleInPast &&
    !isWorking;

  const request: CreateBroadcastRequest = {
    title: trimmedTitle,
    body: trimmedBody,
    ...(trimmedLink ? { link: trimmedLink } : {}),
    // Only ever sent WITH a link — the API refuses a label on its own, and the
    // field is disabled without one, so this is belt and braces.
    ...(trimmedLink && ctaLabel.trim() ? { ctaLabel: ctaLabel.trim() } : {}),
    channels,
    ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
    critical,
  };

  const toggleChannel = (channel: NotificationChannel) => {
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((entry) => entry !== channel)
        : [...current, channel],
    );
  };

  const handleSendTest = async () => {
    setTestNotice(null);
    const ok = await onSendTest(request);
    if (ok) {
      // The dialog stays OPEN. A test send is a step in composing, not the end
      // of it — closing here would throw away the draft the admin is about to
      // adjust based on what they just received.
      setTestNotice('Test sent to you only. Nobody else was contacted.');
    }
  };

  const handleConfirmedSubmit = async () => {
    setConfirming(false);
    const ok = await onSubmit(request);
    if (ok) onClose();
  };

  const paragraphs = trimmedBody.split(/\n{2,}/).filter((paragraph) => paragraph.length > 0);

  /**
   * The audience sentence, in plain English.
   *
   * `null` audience prints "all active users" rather than a zero: the count is
   * an estimate the API has not answered yet, and "Goes to all 0 active users"
   * is both alarming and wrong.
   */
  const channelPhrase = channels.map(channelLabel).join(' and ') || 'no channels';
  const audiencePhrase =
    audience === null
      ? 'Goes to all active users'
      : `Goes to all ${audience.toLocaleString()} active user${audience === 1 ? '' : 's'}`;
  const audienceSentence = `${audiencePhrase} over ${channelPhrase}.`;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        fullWidth
        maxWidth="md"
        fullScreen={isCompactWindow}
        aria-labelledby="broadcast-composer-title"
      >
        <DialogTitle id="broadcast-composer-title">New broadcast</DialogTitle>
        <DialogContent dividers>
          <Box
            component="form"
            id="broadcast-composer-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              // Never submits directly — see the confirmation dialog below.
              setConfirming(true);
            }}
          >
            <Stack spacing={3}>
              {testNotice && (
                <Alert severity="success" onClose={() => setTestNotice(null)}>
                  {testNotice}
                </Alert>
              )}

              {/* --------------------------------------------------------------
                  CONTENT
                  ----------------------------------------------------------- */}
              <TextField
                label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                fullWidth
                slotProps={{ htmlInput: { maxLength: BROADCAST_TITLE_MAX } }}
                helperText={`${title.length} / ${BROADCAST_TITLE_MAX}`}
              />

              <TextField
                label="Body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                required
                fullWidth
                multiline
                minRows={5}
                slotProps={{ htmlInput: { maxLength: BROADCAST_BODY_MAX } }}
                // The formatting rule, stated where it is typed. Every channel
                // escapes this text on render, so markup reaches recipients as
                // literal characters — saying so here is cheaper than an admin
                // discovering it in their own inbox.
                helperText={`Blank lines separate paragraphs. Formatting and links are not supported. ${body.length} / ${BROADCAST_BODY_MAX}`}
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  label="Link (optional)"
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  onBlur={() => setLinkTouched(true)}
                  fullWidth
                  placeholder="/status"
                  error={linkError !== null}
                  helperText={
                    linkError ??
                    'A path inside this application, starting with "/". External links are not accepted.'
                  }
                />
                <Tooltip
                  title={
                    trimmedLink
                      ? ''
                      : 'A call-to-action label needs a link to point at — the email template drops a label with no link.'
                  }
                >
                  <span style={{ width: '100%' }}>
                    <TextField
                      label="Button label"
                      value={ctaLabel}
                      onChange={(event) => setCtaLabel(event.target.value)}
                      fullWidth
                      // Mirrors the DTO's `ctaLabel requires link` refinement.
                      disabled={!trimmedLink}
                      slotProps={{ htmlInput: { maxLength: BROADCAST_CTA_LABEL_MAX } }}
                      helperText={`${ctaLabel.length} / ${BROADCAST_CTA_LABEL_MAX}`}
                    />
                  </span>
                </Tooltip>
              </Stack>

              <Divider />

              {/* --------------------------------------------------------------
                  CHANNELS AND IMPORTANCE
                  ----------------------------------------------------------- */}
              <FormControl component="fieldset" variant="standard">
                <FormLabel component="legend">Channels</FormLabel>
                <FormGroup row>
                  {CHANNEL_ORDER.map((channel) => {
                    const isPush = channel === 'push';
                    const lockedByCritical = channel === 'browser' && critical;
                    const disabled = (isPush && pushUnavailable) || lockedByCritical;
                    const tooltip = isPush && pushUnavailable
                      ? 'Push is not configured on this deployment, so there is no push channel to send over.'
                      : lockedByCritical
                        ? 'An important announcement must leave an in-app record, so this cannot be turned off.'
                        : '';

                    return (
                      <Tooltip key={channel} title={tooltip}>
                        {/* A disabled control fires no events, so the tooltip
                            needs a live wrapper to hang off — the standard MUI
                            arrangement, as `JobsPage` uses for its sweeps. */}
                        <span>
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={channels.includes(channel)}
                                onChange={() => toggleChannel(channel)}
                                disabled={disabled}
                              />
                            }
                            label={channelLabel(channel)}
                          />
                        </span>
                      </Tooltip>
                    );
                  })}
                </FormGroup>
                {channels.length === 0 && (
                  <Typography variant="caption" color="error">
                    Select at least one channel — a broadcast with none reaches nobody.
                  </Typography>
                )}
                {browserToastsDisabled && channels.includes('browser') && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    Browser notifications are turned off for this deployment, so recipients will
                    not see an operating-system notification. The in-app notification is still
                    written and the bell still shows it.
                  </Alert>
                )}
              </FormControl>

              <FormControlLabel
                control={
                  <Switch
                    checked={critical}
                    onChange={(event) => setCritical(event.target.checked)}
                  />
                }
                label="Important — recipients cannot mute this"
              />
              {critical && (
                <Typography variant="caption" color="text.secondary">
                  Sent as an unmuteable event, bypassing every recipient&apos;s notification
                  preferences. In-app is forced on so there is a record they can go back and read.
                  Reserve this for security and service announcements.
                </Typography>
              )}

              <Divider />

              {/* --------------------------------------------------------------
                  TIMING
                  ----------------------------------------------------------- */}
              <FormControl>
                <FormLabel id="broadcast-timing-label">When to send</FormLabel>
                <RadioGroup
                  aria-labelledby="broadcast-timing-label"
                  value={timing}
                  onChange={(event) => setTiming(event.target.value as 'now' | 'later')}
                >
                  <FormControlLabel value="now" control={<Radio />} label="Send now" />
                  <FormControlLabel
                    value="later"
                    control={<Radio />}
                    label="Schedule for later"
                  />
                </RadioGroup>
              </FormControl>

              {timing === 'later' && (
                <Box>
                  <TextField
                    label="Send at"
                    type="datetime-local"
                    value={scheduleInput}
                    onChange={(event) => setScheduleInput(event.target.value)}
                    // A native datetime input renders its own placeholder text,
                    // which overlaps a floating label unless the label is pinned
                    // shrunk. Same treatment as `FilterEditor.tsx`'s date field.
                    slotProps={{
                      inputLabel: { shrink: true },
                      htmlInput: { min: minSchedule },
                    }}
                    error={scheduleInPast}
                    helperText={
                      scheduleInPast
                        ? 'Pick a time in the future — the API refuses a past schedule, because a past time is claimable on the very next poll.'
                        : 'Your local time.'
                    }
                  />
                  {/* THE RESOLVED INSTANT, IN BOTH ZONES. A `datetime-local`
                      value carries no zone, so the field alone cannot tell an
                      administrator in one office what an administrator in
                      another will see. Printing the local rendering and the UTC
                      instant side by side removes the ambiguity entirely. */}
                  {scheduledIso && !scheduleInPast && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 1 }}
                    >
                      Sends at {new Date(scheduledIso).toLocaleString()} in your time zone —{' '}
                      {new Date(scheduledIso).toISOString()} UTC.
                    </Typography>
                  )}
                </Box>
              )}

              <Divider />

              {/* --------------------------------------------------------------
                  PREVIEW — what the bell will actually show.
                  ----------------------------------------------------------- */}
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Preview
                </Typography>
                <Paper variant="outlined" sx={{ p: 2, mt: 0.5 }} data-testid="broadcast-preview">
                  <Stack direction="row" spacing={1.5}>
                    <CampaignOutlinedIcon color="action" />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2">
                        {trimmedTitle || 'Your title appears here'}
                      </Typography>
                      {paragraphs.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          Your message appears here.
                        </Typography>
                      ) : (
                        paragraphs.map((paragraph, index) => (
                          <Typography
                            // Index keys: paragraphs have no identity of their
                            // own and the list is fully re-derived on each
                            // keystroke, so nothing is preserved across renders.
                            key={index}
                            variant="body2"
                            sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}
                          >
                            {paragraph}
                          </Typography>
                        ))
                      )}
                      {trimmedLink && (
                        <Button size="small" sx={{ mt: 1 }} disabled>
                          {ctaLabel.trim() || 'View'}
                        </Button>
                      )}
                    </Box>
                  </Stack>
                </Paper>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {audienceSentence}
                </Typography>
              </Box>
            </Stack>
          </Box>
        </DialogContent>

        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Tooltip
            title={
              canSubmit
                ? 'Sends this exact composition to you alone. Nothing is stored and nobody else is contacted.'
                : 'Fill in the title, the body and at least one channel first.'
            }
          >
            <span>
              <Button onClick={() => void handleSendTest()} disabled={!canSubmit}>
                Send test to me
              </Button>
            </span>
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={onClose} disabled={isWorking}>
            Cancel
          </Button>
          <Tooltip
            title={
              canSubmit
                ? ''
                : 'A broadcast needs a title, a body, at least one channel, and a valid future time.'
            }
          >
            <span>
              <Button
                type="submit"
                form="broadcast-composer-form"
                variant="contained"
                disabled={!canSubmit}
              >
                {timing === 'later' ? 'Schedule…' : 'Send…'}
              </Button>
            </span>
          </Tooltip>
        </DialogActions>
      </Dialog>

      {/* --------------------------------------------------------------------
          THE CONFIRMATION. Not a formality: this is the only action in the
          application that reaches every user at once and cannot be recalled,
          and the three facts it names — how many people, over what, and whether
          they can mute it — are exactly the three an administrator gets wrong
          by not re-reading the form.
          ----------------------------------------------------------------- */}
      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>
          {timing === 'later' ? 'Schedule this broadcast?' : 'Send this to everyone?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body2" gutterBottom>
              <strong>{trimmedTitle}</strong>
            </Typography>
            <Typography variant="body2" gutterBottom>
              {audience === null
                ? 'This goes to every active user'
                : `This goes to all ${audience.toLocaleString()} active user${audience === 1 ? '' : 's'}`}{' '}
              over {channelPhrase}.
            </Typography>
            <Typography variant="body2" gutterBottom>
              {critical
                ? 'Marked important: recipients cannot mute it, and their notification preferences are bypassed.'
                : 'Normal importance: recipients who have muted broadcasts will not receive it.'}
            </Typography>
            <Typography variant="body2" gutterBottom>
              {scheduledIso
                ? `It will be sent at ${new Date(scheduledIso).toLocaleString()} (${new Date(scheduledIso).toISOString()} UTC). You can cancel it until then.`
                : 'It will start sending immediately.'}
            </Typography>
            <Typography variant="body2">
              A broadcast cannot be edited or recalled once it has been sent.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Back</Button>
          <Button
            variant="contained"
            onClick={() => void handleConfirmedSubmit()}
            disabled={isWorking}
          >
            {timing === 'later' ? 'Schedule broadcast' : 'Send broadcast'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default BroadcastComposer;
