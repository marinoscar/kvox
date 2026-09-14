/**
 * Settings → Note Templates (`/settings/note-templates`).
 *
 * Issue #56, epic #45. A card in `config/userSettingsSections.tsx`'s `Account`
 * group and a route in `App.tsx` — a registry destination, never a free route
 * (CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1), which is also what
 * earns this page its AppBar drill-down title and its hub row for free.
 *
 * =============================================================================
 * THIS IS THE SURFACE THE EPIC WAS ASKED FOR BY NAME
 * =============================================================================
 *
 * "A form where I edit the template for a note, and an AI way to test it."
 * Everything here is in service of that second half: without a way to generate
 * a sample, authoring a template means writing instructions blind, generating a
 * real note, reading it, guessing what to change, and repeating — with no way
 * to tell which edit caused which difference. The try-before-you-trust loop is
 * what makes this usable by someone who is not a prompt engineer.
 *
 * =============================================================================
 * ⚠ THE PREVIEW SENDS THE LIVE FORM STATE, NOT THE SAVED ROW
 * =============================================================================
 *
 * `handlePreview` builds its request body from `draft` — the editor's current,
 * possibly-unsaved state — via `toInlineTemplate`, and sends it as the inline
 * `template` member. It never sends `templateId`, even when editing a saved
 * row, because "what is tested is what is on screen" is the whole flow: a
 * preview of the last SAVED version would answer a question the user is not
 * asking, and would force them to commit to a template in order to find out
 * whether they want it. `UserNoteTemplatesPage.test.tsx` asserts this against
 * the request body rather than against the UI, because it is the request that
 * makes it true.
 *
 * =============================================================================
 * `keyConfigured: false` RENDERS `AiKeyRequired` AND NOTHING ELSE
 * =============================================================================
 *
 * Templates COULD be edited without a key — the CRUD endpoints have nothing to
 * do with AI. The issue rejects that anyway, and the reason is worth keeping:
 * a template editor whose only verification tool is dead is a trap. The user
 * would author blind, save, and discover at generation time that the loop this
 * page exists for was never available. One clear state beats a half-working
 * page, and no generation request is issued from this branch at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { NoteTemplateEditor } from '../components/notes/NoteTemplateEditor';
import { NoteTemplateList } from '../components/notes/NoteTemplateList';
import { TemplatePreviewPanel } from '../components/notes/TemplatePreviewPanel';
import type { PreviewSourceOption } from '../components/notes/TemplatePreviewPanel';
import { useAiConfig } from '../hooks/useAiConfig';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNoteTemplates } from '../hooks/useNoteTemplates';
import { useTemplatePreview } from '../hooks/useTemplatePreview';
import { getTranscripts } from '../services/transcripts';
import {
  draftFromTemplate,
  emptyDraft,
  toCreateInput,
  toInlineTemplate,
  toUpdateInput,
} from '../services/noteTemplates';
import type { NoteTemplate, NoteTemplateDraft } from '../services/noteTemplates';

/** Mirrors the `Note Templates` card, so the hub, the AppBar title and this `h1` agree. */
const PAGE_TITLE = 'Note Templates';
const PAGE_DESCRIPTION =
  'Describe the notes you want from a recording, and generate a sample to check the result before you rely on it.';

/** How many recordings the source picker offers. Newest first, from the API's own order. */
const SOURCE_PAGE_SIZE = 20;

/** Which half of the page is on screen. A saved row and a new one share the editor. */
type Mode = { kind: 'list' } | { kind: 'edit'; template: NoteTemplate | null };

export default function UserNoteTemplatesPage() {
  const {
    config,
    isLoading: isConfigLoading,
    loadError: configError,
    keyConfigured,
  } = useAiConfig();

  const {
    templates,
    isLoading: isTemplatesLoading,
    loadError: templatesError,
    isSaving,
    actionError,
    clearActionError,
    create,
    update,
    duplicate,
    archive,
  } = useNoteTemplates();

  const preview = useTemplatePreview();
  const isMounted = useIsMounted();

  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [draft, setDraft] = useState<NoteTemplateDraft>(emptyDraft);
  const [message, setMessage] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // The preview's sources
  // ---------------------------------------------------------------------------
  //
  // The user's own transcripts, newest first, so the default is the recording
  // they most recently made. Issue #56 rejects a synthetic built-in sample
  // outright: the user is finding out whether this template works on THEIR
  // meetings, with their names, jargon and messiness, and a clean fixture would
  // flatter every template equally.
  const [sources, setSources] = useState<PreviewSourceOption[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');

  const loadSources = useCallback(async () => {
    try {
      setIsLoadingSources(true);
      setSourcesError(null);
      const page = await getTranscripts({ scope: 'owned', limit: SOURCE_PAGE_SIZE });
      if (!isMounted()) return;
      const options = page.items.map((item) => ({
        id: item.id,
        label: item.title,
      }));
      setSources(options);
      // The FIRST row is the most recent: `GET /api/transcripts` is
      // cursor-paginated over `(updatedAt, id)` descending.
      setSelectedSourceId((current) =>
        current && options.some((option) => option.id === current)
          ? current
          : (options[0]?.id ?? ''),
      );
    } catch {
      if (isMounted()) {
        setSourcesError('Your recordings could not be loaded, so there is nothing to preview against.');
        setSources([]);
      }
    } finally {
      if (isMounted()) setIsLoadingSources(false);
    }
  }, [isMounted]);

  // ⚠ GATED ON `keyConfigured`. The `AiKeyRequired` branch must issue no
  // generation request, and the source list exists only to feed one — so it is
  // not fetched at all when the page is going to render that state.
  useEffect(() => {
    if (!keyConfigured) return;
    void loadSources();
  }, [keyConfigured, loadSources]);

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  const openNew = () => {
    preview.reset();
    setDraft(emptyDraft());
    setMode({ kind: 'edit', template: null });
  };

  const openExisting = (template: NoteTemplate) => {
    preview.reset();
    setDraft(draftFromTemplate(template));
    setMode({ kind: 'edit', template });
  };

  const backToList = () => {
    // Closes any live stream. The effect cleanup in `useTemplatePreview` covers
    // an actual unmount; this covers leaving the editor while the page stays.
    preview.reset();
    setMode({ kind: 'list' });
  };

  const handleDuplicate = async (template: NoteTemplate) => {
    const copy = await duplicate(template.id);
    if (!copy) return;
    setMessage(`Copied to “${copy.name}”`);
    // Duplicating OPENS THE COPY, rather than dropping the user back on a list
    // where they have to find it: the only reason to duplicate a built-in is to
    // change it, so the next step is the editor.
    openExisting(copy);
  };

  const handleArchive = async (template: NoteTemplate) => {
    const result = await archive(template.id);
    if (!result) return;
    setMessage(
      result.outcome === 'deleted'
        ? `“${template.name}” was deleted`
        : `“${template.name}” was archived — ${result.noteCount} note${result.noteCount === 1 ? '' : 's'} still reference it`,
    );
  };

  const handleSave = async () => {
    if (mode.kind !== 'edit') return;
    const saved = mode.template
      ? await update(mode.template.id, toUpdateInput(draft))
      : await create(toCreateInput(draft));
    if (!saved) return;
    setMessage(`“${saved.name}” saved`);
    setMode({ kind: 'edit', template: saved });
  };

  /**
   * ⚠ THE LIVE DRAFT, SENT INLINE. See the file header.
   *
   * `template` and never `templateId`, even for a saved row — the point of the
   * endpoint accepting an inline body is that nothing has to be committed in
   * order to be tried.
   */
  const handlePreview = () => {
    if (!selectedSourceId) return;
    void preview.start({
      template: toInlineTemplate(draft),
      source: { type: 'transcript', transcriptId: selectedSourceId },
    });
  };

  const canRunPreview = useMemo(
    () => draft.instructions.trim().length > 0 && selectedSourceId !== '',
    [draft.instructions, selectedSourceId],
  );

  const canSave = draft.name.trim().length > 0 && draft.instructions.trim().length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const header = (
    <>
      <Typography variant="h4" component="h1" gutterBottom>
        {PAGE_TITLE}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        {PAGE_DESCRIPTION}
      </Typography>
    </>
  );

  if (isConfigLoading) {
    return <LoadingSpinner />;
  }

  if (!keyConfigured) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          {header}
          {configError && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {configError}
            </Alert>
          )}
          {/* The whole page. No editor, no preview, no request. */}
          <AiKeyRequired />
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {header}

        {templatesError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {templatesError}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={clearActionError}>
            {actionError}
          </Alert>
        )}

        {mode.kind === 'list' ? (
          <>
            <Stack
              direction="row"
              spacing={2}
              sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}
            >
              {/* A real `h2` between the page's `h1` and each row's `h3`.
                  Not decoration: a list of `h3`s directly under an `h1` is a
                  broken outline, which axe reports as `heading-order` and a
                  screen-reader user experiences as a level that came from
                  nowhere. */}
              <Typography variant="h6" component="h2">
                Your templates
              </Typography>
              <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>
                New template
              </Button>
            </Stack>

            {isTemplatesLoading ? (
              <LoadingSpinner />
            ) : (
              <NoteTemplateList
                templates={templates}
                busy={isSaving}
                onEdit={openExisting}
                onDuplicate={(template) => void handleDuplicate(template)}
                onArchive={(template) => void handleArchive(template)}
              />
            )}
          </>
        ) : (
          <>
            <Stack
              direction="row"
              spacing={2}
              sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}
            >
              <Button startIcon={<ArrowBackIcon />} onClick={backToList}>
                All templates
              </Button>
              <Button variant="contained" onClick={() => void handleSave()} disabled={!canSave || isSaving}>
                {isSaving ? 'Saving…' : mode.template ? 'Save changes' : 'Create template'}
              </Button>
            </Stack>

            {/* Side by side from `md` up, stacked below it. The editor stays
                EDITABLE while a preview streams — the adjust/re-run loop is the
                point, and disabling the form mid-stream would break it. */}
            <Box
              sx={{
                display: 'grid',
                gap: 3,
                gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                alignItems: 'start',
              }}
            >
              <NoteTemplateEditor
                draft={draft}
                onChange={setDraft}
                models={config?.models ?? []}
                defaultModel={config?.defaultModel ?? null}
                disabled={isSaving}
              />

              <TemplatePreviewPanel
                sources={sources}
                isLoadingSources={isLoadingSources}
                sourcesError={sourcesError}
                selectedSourceId={selectedSourceId}
                onSelectSource={setSelectedSourceId}
                status={preview.status}
                content={preview.content}
                preview={preview.preview}
                error={preview.error}
                isRunning={preview.isRunning}
                canRun={canRunPreview}
                onRun={handlePreview}
              />
            </Box>
          </>
        )}

        <Snackbar
          open={!!message}
          autoHideDuration={4000}
          onClose={() => setMessage(null)}
          message={message}
        />
      </Box>
    </Container>
  );
}
