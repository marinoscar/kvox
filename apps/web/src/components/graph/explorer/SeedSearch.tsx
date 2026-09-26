/**
 * `SeedSearch` — where the explorer starts when there is nothing to start
 * from (#374; spec §22.2): no `?seed=`, no hand-off from the overview, and no
 * recently viewed entity. A centred search over the caller's own entities
 * (`listGraphEntities({ q, limit: 8 })`, debounced by `useGraphEntities`) plus
 * the six most recently updated ones as chips.
 */

import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { useGraphEntities } from '../../../hooks/useGraphEntities';
import type { GraphEntitySummary } from '../../../services/graph';
import { EntityTypeIcon } from '../entityTypeIcon';

export const SEED_SEARCH_LABEL = 'Start from a person, organization or project';

export interface SeedSearchProps {
  onChoose: (id: string) => void;
  /** An extra line above the search — e.g. the `?cluster=` reload hint. */
  hint?: string;
}

export function SeedSearch({ onChoose, hint }: SeedSearchProps) {
  const [input, setInput] = useState('');
  const search = useGraphEntities({ q: input, limit: 8, enabled: input.trim().length > 0 });
  const recent = useGraphEntities({ limit: 6 });

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: { xs: 3, sm: 6 } }}>
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, width: '100%', maxWidth: 560 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Where do you want to start?
        </Typography>
        {hint && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {hint}
          </Typography>
        )}
        <Autocomplete<GraphEntitySummary, false, false, false>
          options={input.trim() ? search.data : []}
          getOptionLabel={(option) => option.label}
          filterOptions={(options) => options}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          loading={search.isLoading && input.trim().length > 0}
          inputValue={input}
          onInputChange={(_event, value) => setInput(value)}
          onChange={(_event, value) => {
            if (value) onChoose(value.id);
          }}
          noOptionsText={input.trim() ? 'Nothing in your graph matches' : 'Type a name'}
          renderOption={(optionProps, option) => {
            const { key, ...rest } = optionProps as typeof optionProps & { key: string };
            return (
              <li key={key} {...rest}>
                <EntityTypeIcon type={option.type} fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {option.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {option.type}
                  </Typography>
                </Box>
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={SEED_SEARCH_LABEL}
              slotProps={{
                ...params.slotProps,
                htmlInput: { ...params.slotProps.htmlInput, 'aria-label': SEED_SEARCH_LABEL },
              }}
            />
          )}
        />
        {recent.data.length > 0 && (
          <Box sx={{ mt: 2.5 }}>
            <Typography variant="subtitle2" component="h3" color="text.secondary" gutterBottom>
              Recently updated
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {recent.data.slice(0, 6).map((entity) => (
                <Chip
                  key={entity.id}
                  icon={<EntityTypeIcon type={entity.type} fontSize="small" />}
                  label={entity.label}
                  onClick={() => onChoose(entity.id)}
                  variant="outlined"
                />
              ))}
            </Box>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
