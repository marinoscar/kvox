/**
 * "You in the graph" — the Knowledge graph settings card's self-identity control
 * (#778; docs/specs/ontology.md §6.1).
 *
 * Says which Person in the user's graph is the user. Notes that name them link to
 * that Person, extraction treats its names as the note's owner, and the explorer
 * draws it as "You". The choice is the `graph.self.entityId` preference.
 *
 * NEVER CHOOSES FOR THE USER. While nothing is chosen the API offers Persons that
 * match the profile name; each is a button the user must press. Three ways in: pick
 * an existing Person (the same search field re-linking uses), accept a suggestion,
 * or add a Person by hand (a write through the graph's one write service, cited
 * "Set by hand").
 *
 * Layout is CSS only (a stack that wraps), so the five breakpoint gates are untouched.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormHelperText from '@mui/material/FormHelperText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import type { GraphSelfEntity } from '../../../headless/clients/graph.js';
import { useGraphSelf } from '../../../headless/hooks/useGraphSelf.js';
import { EntitySearchField } from '../schema/EntitySearchField.js';

/**
 * Props of {@link SelfIdentitySection}.
 *
 * @stability experimental
 */
export interface SelfIdentitySectionProps {
  /** Stores the choice (`graph.self.entityId`); `null` clears it. Resolves `true` when it landed. */
  onChoose: (entityId: string | null) => Promise<boolean>;
  /** The stored id; a change re-reads the resolved Person. */
  storedEntityId: string | null;
}

/**
 * The self-identity control.
 *
 * @param props - the write and the stored id.
 * @returns the section body.
 *
 * @stability experimental
 */
export function SelfIdentitySection({ onChoose, storedEntityId }: SelfIdentitySectionProps) {
  const { data, isLoading, error, refresh, create } = useGraphSelf();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);

  async function choose(id: string | null) {
    setBusy(true);
    try {
      if (await onChoose(id)) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addByHand(label: string) {
    setBusy(true);
    try {
      const id = await create(label);
      if (id && (await onChoose(id))) await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Typography variant="body2">Loading…</Typography>;

  const self = data?.self ?? null;
  const suggestions = data?.suggestions ?? [];
  const typed = name ?? data?.displayName ?? '';
  const stale = self === null && storedEntityId !== null;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Pick the Person that is you. Notes that name you link to it, extraction knows those names
        are the note&apos;s owner, and the graph explorer shows it as &ldquo;You&rdquo;.
      </Typography>

      {error && <Alert severity="error">{error}</Alert>}
      {stale && (
        <Alert severity="info">
          The Person you chose is no longer in your graph. Choose another, or clear the choice.
        </Alert>
      )}

      {self ? (
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography>
            You are <strong>{self.label}</strong>
            {self.aliases.length > 0 ? ` (also ${self.aliases.join(', ')})` : ''}
          </Typography>
          <Button size="small" disabled={busy} onClick={() => void choose(null)}>
            Clear
          </Button>
        </Stack>
      ) : (
        suggestions.length > 0 && (
          <Box>
            <Typography id="kg-self-suggest" variant="subtitle2" component="p" gutterBottom>
              Is this you?
            </Typography>
            <Stack spacing={1} aria-labelledby="kg-self-suggest" role="group">
              {suggestions.map((person: GraphSelfEntity) => (
                <Stack key={person.id} direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                  <Typography>{person.label}</Typography>
                  <Button size="small" variant="outlined" disabled={busy} onClick={() => void choose(person.id)}>
                    That&apos;s me
                  </Button>
                </Stack>
              ))}
            </Stack>
          </Box>
        )
      )}

      <Box>
        <EntitySearchField
          label={self ? 'Choose a different Person' : 'Find yourself in your graph'}
          types={['Person']}
          value={null}
          disabled={busy}
          onChange={(person) => {
            if (person) void choose(person.id);
          }}
          helperText="Search the Persons already in your graph."
        />
      </Box>

      {!self && (
        <Box>
          <Typography variant="subtitle2" component="p" gutterBottom>
            Not in your graph yet?
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
            <TextField
              size="small"
              label="Your name"
              value={typed}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              sx={{ flexGrow: 1 }}
              slotProps={{ htmlInput: { maxLength: 200 } }}
            />
            <Button variant="outlined" disabled={busy || typed.trim().length === 0} onClick={() => void addByHand(typed.trim())}>
              Add me to the graph
            </Button>
          </Stack>
          <FormHelperText sx={{ ml: 0 }}>
            Adds a Person for you, cited as set by hand, and chooses it.
          </FormHelperText>
        </Box>
      )}
    </Stack>
  );
}
