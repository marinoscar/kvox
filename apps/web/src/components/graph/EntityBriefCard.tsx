/**
 * `EntityBriefCard` — "what's the latest on Joe?" (#373 over #372's contract;
 * spec §9.1–§9.2).
 *
 * =============================================================================
 * THE PAGE NEVER ASKS FOR AI PROSE
 * =============================================================================
 *
 * The Summary is the STORED digest (`kg.entity_digest`'s output) and nothing
 * else. There is no "Write summary" button and no model picker: the GET
 * enqueues a refresh when the digest is stale, and this card says so —
 * "Updating summary…" while it is pending, the reason when it cannot be
 * refreshed, "may be out of date" + Refresh after a recent failure. No digest
 * and nothing coming → no Summary at all.
 *
 * Then the five deterministic sections, IN SPEC ORDER (§9.1): What changed ·
 * Decisions · Open commitments (Theirs / Yours) · Risks / claims · People
 * changes. Each entry carries its numbered evidence chips. Sections are
 * collapsible `Accordion`s — one destination's sequential content, not tabs
 * (Settings UI Pattern rule 2's reasoning).
 *
 * `sensitive` PersonFacts never appear: #372 excludes them server-side.
 */

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type {
  BriefEntry,
  DigestUnavailableReason,
  EntityBrief,
  PeopleChange,
  RelatedSource,
} from '../../services/graph';
import { formatPrecisionDate, relationTypeLabel } from '../../utils/graphDisplay';
import type { GraphOntology } from '../../services/graph';
import { SearchSnippet } from '../search/SearchSnippet';
import { EvidenceChips } from './EvidenceChip';
import { entityPath } from './EntityListRow';

export interface EntityBriefCardProps {
  brief: EntityBrief;
  ontology: GraphOntology | null;
  onRefresh: () => void;
}

export const DIGEST_UNAVAILABLE_COPY: Record<DigestUnavailableReason, string> = {
  ai_key_missing: 'Add your AI key in Settings → AI to keep this summary up to date',
  graph_disabled: 'Knowledge summaries are turned off for this deployment',
  ai_not_configured: 'No AI provider is set up on this deployment',
  model_lacks_capability: "The configured model can't write cited summaries",
};

/** The five section titles, in the order §9.1 fixes. Exported for the order test. */
export const BRIEF_SECTION_TITLES = [
  'What changed',
  'Decisions',
  'Open commitments',
  'Risks / claims',
  'People changes',
] as const;

function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function EntryRow({ entry }: { entry: BriefEntry }) {
  const heading = entry.title ?? entry.statement;
  return (
    <Box component="li" sx={{ py: 1, listStyle: 'none' }}>
      <Typography
        variant="body2"
        component="p"
        sx={{
          fontWeight: entry.title ? 600 : 400,
          textDecoration: entry.superseded ? 'line-through' : 'none',
          color: entry.superseded ? 'text.secondary' : 'text.primary',
        }}
      >
        {heading}
        <EvidenceChips ids={entry.evidenceIds} />
      </Typography>
      {entry.title && entry.statement !== entry.title && (
        <Typography variant="body2" color="text.secondary">
          {entry.statement}
        </Typography>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          {formatPrecisionDate(entry.occurredAt, entry.precision)}
        </Typography>
        {entry.superseded && <Chip size="small" label="Superseded" />}
        {entry.dueAt && <Chip size="small" variant="outlined" label={`Due ${formatDay(entry.dueAt)}`} />}
        {entry.ownerPerson && (
          <Link component={RouterLink} to={entityPath(entry.ownerPerson.id)} variant="caption">
            {entry.ownerPerson.label}
          </Link>
        )}
        {entry.counterparty && (
          <Typography variant="caption" color="text.secondary">
            to{' '}
            <Link component={RouterLink} to={entityPath(entry.counterparty.id)}>
              {entry.counterparty.label}
            </Link>
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function EntryList({ entries, empty }: { entries: readonly BriefEntry[]; empty: string }) {
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {empty}
      </Typography>
    );
  }
  return (
    <Box component="ul" sx={{ m: 0, p: 0 }}>
      {entries.map((entry) => (
        <EntryRow key={entry.itemId} entry={entry} />
      ))}
    </Box>
  );
}

function PeopleChangeRow({ change, ontology }: { change: PeopleChange; ontology: GraphOntology | null }) {
  const verb = change.change === 'started' ? 'Started' : 'Ended';
  const relation = relationTypeLabel(change.type, ontology).toLowerCase();
  return (
    <Box component="li" sx={{ py: 1, listStyle: 'none' }}>
      <Typography variant="body2" component="p">
        <Link component={RouterLink} to={entityPath(change.person.id)}>
          {change.person.label}
        </Link>{' '}
        — {verb.toLowerCase()} {relation}
        {change.title ? ` “${change.title}”` : ''} at{' '}
        <Link component={RouterLink} to={entityPath(change.other.id)}>
          {change.other.label}
        </Link>
        <EvidenceChips ids={change.evidenceIds} />
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {formatPrecisionDate(change.at, change.precision)}
      </Typography>
    </Box>
  );
}

function relatedHref(source: RelatedSource): string {
  if (source.kind === 'note') return `/notes/${encodeURIComponent(source.id)}`;
  const base = `/transcripts/${encodeURIComponent(source.id)}`;
  return source.startMs !== null ? `${base}?t=${source.startMs}` : base;
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Accordion defaultExpanded disableGutters elevation={0} sx={{ '&::before': { display: 'none' }, bgcolor: 'transparent' }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
        <Typography variant="subtitle1" component="span" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant="subtitle1" component="span" color="text.secondary" sx={{ ml: 1 }}>
          {count}
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0, pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}

function DigestSummary({ brief, onRefresh }: { brief: EntityBrief; onRefresh: () => void }) {
  const { digest, digestPending, digestStale, digestUnavailable } = brief;

  let status: ReactNode = null;
  if (digestPending) {
    status = (
      <Typography variant="caption" color="text.secondary" role="status">
        Updating summary…
      </Typography>
    );
  } else if (digestStale && digestUnavailable) {
    const copy = DIGEST_UNAVAILABLE_COPY[digestUnavailable];
    status =
      digestUnavailable === 'ai_key_missing' ? (
        <Typography variant="caption" color="text.secondary">
          <Link component={RouterLink} to="/settings/ai">
            {copy}
          </Link>
        </Typography>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {copy}
        </Typography>
      );
  } else if (digestStale && digest) {
    status = (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          Summary may be out of date
        </Typography>
        <Button size="small" onClick={onRefresh}>
          Refresh
        </Button>
      </Stack>
    );
  }

  if (!digest && !status) return null;

  return (
    <Box component="section" aria-labelledby="entity-brief-summary" sx={{ mb: 2 }}>
      <Typography id="entity-brief-summary" variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 0.5 }}>
        Summary
      </Typography>
      {digest && (
        <>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {digest.statements.map((statement, index) => (
              <Typography key={index} component="li" variant="body2" sx={{ py: 0.25 }}>
                {statement.text}
                <EvidenceChips ids={statement.evidenceIds} />
              </Typography>
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
            Summary as of {formatDay(digest.generatedAt)}
          </Typography>
        </>
      )}
      {status}
    </Box>
  );
}

export function EntityBriefCard({ brief, ontology, onRefresh }: EntityBriefCardProps) {
  const { sections, window } = brief;
  const since = window.since ? formatDay(window.since) : null;
  const sinceLine = since
    ? `Since ${since}${window.sinceSource === 'last_viewed' ? ' — since you last looked' : ''}`
    : 'Everything so far';

  const commitmentCount = sections.openCommitments.theirs.length + sections.openCommitments.yours.length;

  return (
    <Paper variant="outlined" component="section" aria-labelledby="entity-brief-title" sx={{ p: { xs: 2, sm: 2.5 }, mb: 3 }}>
      <Typography id="entity-brief-title" variant="h6" component="h2" sx={{ fontWeight: 600 }}>
        Brief
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {sinceLine}
      </Typography>

      <DigestSummary brief={brief} onRefresh={onRefresh} />

      <Section title={BRIEF_SECTION_TITLES[0]} count={sections.whatChanged.length}>
        <EntryList entries={sections.whatChanged} empty="Nothing new in this window." />
      </Section>
      <Section title={BRIEF_SECTION_TITLES[1]} count={sections.decisions.length}>
        <EntryList entries={sections.decisions} empty="No decisions recorded." />
      </Section>
      <Section title={BRIEF_SECTION_TITLES[2]} count={commitmentCount}>
        <Typography variant="subtitle2" component="h4" sx={{ mt: 0.5 }}>
          Theirs
        </Typography>
        <EntryList entries={sections.openCommitments.theirs} empty="Nothing open." />
        <Typography variant="subtitle2" component="h4" sx={{ mt: 1.5 }}>
          Yours
        </Typography>
        <EntryList entries={sections.openCommitments.yours} empty="Nothing open." />
      </Section>
      <Section title={BRIEF_SECTION_TITLES[3]} count={sections.risksClaims.length}>
        <EntryList entries={sections.risksClaims} empty="No risks or claims recorded." />
      </Section>
      <Section title={BRIEF_SECTION_TITLES[4]} count={sections.peopleChanges.length}>
        {sections.peopleChanges.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No role or reporting changes.
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            {sections.peopleChanges.map((change) => (
              <PeopleChangeRow key={`${change.relationId}-${change.change}`} change={change} ontology={ontology} />
            ))}
          </Box>
        )}
      </Section>

      {brief.related.length > 0 && (
        <Box component="section" aria-labelledby="entity-brief-related" sx={{ mt: 2 }}>
          <Typography id="entity-brief-related" variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            Related
          </Typography>
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            {brief.related.map((source) => (
              <Box component="li" key={`${source.kind}-${source.id}`} sx={{ listStyle: 'none', py: 0.75 }}>
                <Link component={RouterLink} to={relatedHref(source)} variant="body2" sx={{ fontWeight: 600 }}>
                  {source.title}
                </Link>
                {source.snippetHtml && (
                  <SearchSnippet
                    snippet={{
                      html: source.snippetHtml,
                      startMs: source.startMs,
                      field: source.kind === 'note' ? 'body' : 'segment',
                    }}
                  />
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {sections.whatChanged.length === 0 &&
        sections.decisions.length === 0 &&
        commitmentCount === 0 &&
        sections.risksClaims.length === 0 &&
        sections.peopleChanges.length === 0 &&
        !brief.digest && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Nothing has been recorded about {brief.entity.label} yet.
          </Alert>
        )}
    </Paper>
  );
}

export default EntityBriefCard;
