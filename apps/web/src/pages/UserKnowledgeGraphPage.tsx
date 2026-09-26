/**
 * Settings → Knowledge graph (`/settings/knowledge-graph`).
 *
 * Issue #369, epic #346, docs/specs/ontology.md §6, §7, §13, §17.2, §17.3.
 * A registry destination (`config/userSettingsSections.tsx`, CLAUDE.md
 * Settings UI Pattern rule 1) gated on `graph:write` — the exact string the
 * attribute-definition write routes enforce (rule 3) — and reached through
 * the shared `SettingsHub` (rule 4). None of the five breakpoint gates is
 * touched.
 *
 * WHAT LIVES HERE: the caller's own `graph` user-settings namespace
 * (automatic extraction, resolution thresholds/mode/adjudication, domains)
 * and their own attribute definitions. Every preference control saves ON
 * CHANGE through `PATCH /api/user-settings { graph: {...} }` — sliders on
 * commit, never on drag — and says whether the save landed.
 *
 * NOT GATED ON `ai.graphEnabled`. When an administrator has connected
 * knowledge off, this page says so and stays usable: the choices are the
 * user's, and apply when it is turned on. The same for a missing AI key.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Radio,
  RadioGroup,
  Slider,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { AttributeDefsBrowser } from '../components/graph/settings/AttributeDefsBrowser';
import { useAiConfig } from '../hooks/useAiConfig';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import {
  AUTO_LINK_MAX,
  AUTO_LINK_MIN,
  maxNewThreshold,
  NEW_MIN,
  SAFE_AUTO_LINK,
  useGraphPreferences,
  type GraphSaveState,
} from '../hooks/useGraphPreferences';
import type { DomainKey } from '@app/shared/ontology';

const percent = (value: number) => `${Math.round(value * 100)} %`;

/** What each domain adds, in the user's words. */
const DOMAIN_COPY: Record<DomainKey, { label: string; description: string }> = {
  core: { label: 'Core', description: 'People, organizations, meetings, facts' },
  work: { label: 'Work', description: 'Projects, commitments, decisions, roles' },
  personal: { label: 'Personal', description: 'Family, friends and personal life' },
};
const FALLBACK_DOMAINS: DomainKey[] = ['core', 'work', 'personal'];

function saveLabel(state: GraphSaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving…';
    case 'error':
      return 'Not saved';
    case 'saved':
      return 'All changes saved';
    default:
      return 'Changes save automatically';
  }
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby={id}
      sx={{ mt: 3, p: { xs: 2, sm: 3 } }}
    >
      <Typography id={id} variant="h6" component="h2" gutterBottom>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

export default function UserKnowledgeGraphPage() {
  const { preferences, isLoading, loadError, saveState, saveError, update } =
    useGraphPreferences();
  const { config: aiConfig, isLoading: aiLoading } = useAiConfig();
  const { ontology, refresh: refreshOntology } = useGraphOntology();

  // Slider values while dragging; committed on release.
  const [autoLink, setAutoLink] = useState(preferences.resolution.autoLinkThreshold);
  const [newBelow, setNewBelow] = useState(preferences.resolution.newThreshold);
  const [confirmWorkOff, setConfirmWorkOff] = useState(false);

  useEffect(() => {
    setAutoLink(preferences.resolution.autoLinkThreshold);
    setNewBelow(preferences.resolution.newThreshold);
  }, [preferences.resolution.autoLinkThreshold, preferences.resolution.newThreshold]);

  if (isLoading) return <LoadingSpinner />;

  const newMax = maxNewThreshold(autoLink);

  async function commitAutoLink(value: number) {
    // Moving auto-link down can squeeze "new below" past its ceiling; send the
    // clamped value in the same PATCH so the pair is never stored out of order.
    const clamped = Math.min(newBelow, maxNewThreshold(value));
    if (clamped !== newBelow) setNewBelow(clamped);
    await update({
      resolution: {
        autoLinkThreshold: value,
        ...(clamped !== preferences.resolution.newThreshold ? { newThreshold: clamped } : {}),
      },
    });
  }

  async function setDomain(work: boolean) {
    const ok = await update({ domains: { work } });
    if (ok) void refreshOntology();
  }

  // The ontology's registered domains, plus any of the three known ones it
  // does not register yet — `personal` ships with #383, but its switch is
  // shown (disabled) now so the choice is visibly coming.
  const domainKeys: DomainKey[] = [
    ...(ontology?.domains.map((d) => d.key) ?? []),
    ...FALLBACK_DOMAINS,
  ].filter((key, index, all) => all.indexOf(key) === index);

  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, md: 4 } }}>
      <Box>
        <Typography variant="h5" component="h1" gutterBottom>
          Knowledge graph
        </Typography>
        <Typography variant="body2" color="text.secondary">
          How your notes become connected knowledge: people, organizations, projects and what was
          decided about them. Everything here applies to your own graph only.
        </Typography>
        <Box
          role="status"
          aria-live="polite"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 24, mt: 1 }}
        >
          {saveState === 'saving' && <CircularProgress size={12} aria-hidden />}
          <Typography
            variant="caption"
            color={saveState === 'error' ? 'error.main' : 'text.secondary'}
          >
            {saveLabel(saveState)}
          </Typography>
        </Box>
      </Box>

      {loadError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {loadError}
        </Alert>
      )}
      {saveError && saveState === 'error' && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {saveError}
        </Alert>
      )}

      {/* 1. Availability */}
      {!aiLoading && aiConfig?.graphEnabled === false && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Connected knowledge is turned off on this deployment. Your choices are saved and apply
          when an administrator turns it on.
        </Alert>
      )}
      {!aiLoading && aiConfig && !aiConfig.keyConfigured && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          Extraction and AI matching run on your own AI provider key, and you have not added one
          yet.{' '}
          <Link component={RouterLink} to="/settings/ai">
            Add your AI provider key
          </Link>
        </Alert>
      )}

      {/* 2. Extraction */}
      <Section title="Extraction" id="kg-extraction-heading">
        <FormControlLabel
          control={
            <Switch
              checked={preferences.extraction.autoExtract}
              onChange={(event) => void update({ extraction: { autoExtract: event.target.checked } })}
            />
          }
          label="Extract a graph proposal when a note is ready"
        />
        <FormHelperText sx={{ mt: 0 }}>
          Runs on your AI key. You can always extract a note by hand.
        </FormHelperText>
      </Section>

      {/* 3. Resolution */}
      <Section title="Resolution" id="kg-resolution-heading">
        <Stack spacing={3}>
          <FormControl>
            <FormLabel id="kg-mode-label">When a name might be someone already in your graph</FormLabel>
            <RadioGroup
              aria-labelledby="kg-mode-label"
              value={preferences.resolution.mode}
              onChange={(event) =>
                void update({
                  resolution: { mode: event.target.value as 'precheck_confident' | 'review_all' },
                })
              }
            >
              <FormControlLabel
                value="precheck_confident"
                control={<Radio />}
                label="Pre-check confident matches"
              />
              <FormControlLabel value="review_all" control={<Radio />} label="Let me review every row" />
            </RadioGroup>
          </FormControl>

          <Box>
            <Typography id="kg-autolink-label" gutterBottom>
              Link automatically at {percent(autoLink)}
            </Typography>
            <Slider
              aria-labelledby="kg-autolink-label"
              min={AUTO_LINK_MIN}
              max={AUTO_LINK_MAX}
              step={0.01}
              marks={[{ value: SAFE_AUTO_LINK, label: percent(SAFE_AUTO_LINK) }]}
              value={autoLink}
              valueLabelDisplay="auto"
              valueLabelFormat={percent}
              getAriaValueText={percent}
              onChange={(_, value) => setAutoLink(value as number)}
              onChangeCommitted={(_, value) => void commitAutoLink(value as number)}
            />
            {autoLink < SAFE_AUTO_LINK && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Lower than the measured-safe default (90 %). More wrong links will arrive
                pre-checked.
              </Alert>
            )}
          </Box>

          <Box>
            <Typography id="kg-new-label" gutterBottom>
              Treat as new below {percent(newBelow)}
            </Typography>
            <Slider
              aria-labelledby="kg-new-label"
              min={NEW_MIN}
              max={newMax}
              step={0.01}
              value={Math.min(newBelow, newMax)}
              valueLabelDisplay="auto"
              valueLabelFormat={percent}
              getAriaValueText={percent}
              onChange={(_, value) => setNewBelow(value as number)}
              onChangeCommitted={(_, value) =>
                void update({ resolution: { newThreshold: value as number } })
              }
            />
            <FormHelperText sx={{ mt: 0 }}>
              Between the two, a match is suggested but left for you to confirm.
            </FormHelperText>
          </Box>

          <Box>
            <FormControlLabel
              control={
                <Switch
                  checked={preferences.resolution.adjudication === 'llm'}
                  onChange={(event) =>
                    void update({
                      resolution: { adjudication: event.target.checked ? 'llm' : 'off' },
                    })
                  }
                />
              }
              label="Ask the AI about uncertain matches"
            />
            <FormHelperText sx={{ mt: 0 }}>
              Uses your AI key for a small request per uncertain match.
            </FormHelperText>
          </Box>

          <Box>
            <Button variant="outlined" onClick={() => void update({ resolution: null })}>
              Reset to defaults
            </Button>
          </Box>
        </Stack>
      </Section>

      {/* 4. Domains */}
      <Section title="Domains" id="kg-domains-heading">
        <Typography variant="body2" color="text.secondary">
          Which kinds of things extraction looks for.
        </Typography>
        <List>
          {domainKeys.map((key) => {
            const copy = DOMAIN_COPY[key] ?? { label: key, description: '' };
            const labelId = `kg-domain-${key}`;
            let checked: boolean;
            let disabled: boolean;
            let caption = copy.description;
            if (key === 'core') {
              checked = true;
              disabled = true;
              caption = `${copy.description}. Always on.`;
            } else if (key === 'work') {
              checked = preferences.domains.work;
              disabled = false;
            } else {
              checked = false;
              disabled = true;
              caption = 'Coming in a later release';
            }
            return (
              <ListItem
                key={key}
                divider
                secondaryAction={
                  <Switch
                    edge="end"
                    checked={checked}
                    disabled={disabled}
                    slotProps={{
                      input: {
                        'aria-labelledby': labelId,
                        'aria-describedby': `${labelId}-caption`,
                      },
                    }}
                    onChange={(event) => {
                      if (key !== 'work') return;
                      if (!event.target.checked) setConfirmWorkOff(true);
                      else void setDomain(true);
                    }}
                  />
                }
              >
                <ListItemText
                  primary={<span id={labelId}>{copy.label}</span>}
                  secondary={<span id={`${labelId}-caption`}>{caption}</span>}
                />
              </ListItem>
            );
          })}
        </List>
      </Section>

      {/* 5. Attributes */}
      <Section title="Your attributes" id="kg-attributes-heading">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Add the facts you want to keep about people and organizations beyond the built-in
          ones. An attribute is never deleted — deprecating it hides it and keeps its values.
        </Typography>
        <AttributeDefsBrowser ontology={ontology} />
      </Section>

      <Dialog
        open={confirmWorkOff}
        onClose={() => setConfirmWorkOff(false)}
        aria-labelledby="kg-work-off-title"
      >
        <DialogTitle id="kg-work-off-title">Turn off Work?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Work types won&apos;t be offered to extraction. Nothing already in your graph is
            removed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmWorkOff(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmWorkOff(false);
              void setDomain(false);
            }}
          >
            Turn off
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
