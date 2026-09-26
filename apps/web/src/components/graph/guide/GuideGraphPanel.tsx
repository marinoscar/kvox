/**
 * "Guide the graph" — steer the next extraction (#368, epic #346;
 * ontology.md §6, §19). Controlled: the parent holds a #363
 * `userGuidanceSchema` value and this panel only edits it.
 *
 *   Focus on          entities of the user's own graph, found with the same
 *                     `EntitySearchField` the review sheet re-links with;
 *                     shown as chips, at most 50.
 *   Extract these     one checkbox chip per extractable type of the EFFECTIVE
 *   types             ontology (never a type outside it, §6), grouped by
 *                     domain. All checked is spelled as an absent field; the
 *                     last entity type cannot be unchecked. Relation types sit
 *                     in a nested disclosure.
 *   Instructions      free text, 2 000 characters, counted.
 *
 * `invalid` names what a 400 refused (`details.unknownTypes`,
 * `details.invalidPinnedIds`) so those chips are drawn in the error colour.
 */

import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import FormHelperText from '@mui/material/FormHelperText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

import { GUIDANCE_MAX_INSTRUCTIONS, GUIDANCE_MAX_PINNED } from '../../../services/graph';
import type { GraphOntology, ProposalItem, UserGuidance } from '../../../services/graph';
import { EntitySearchField } from '../schema/EntitySearchField';
import { entityLabel, offeredEntityTypes, offeredRelationTypes, rememberEntityLabel } from './guidance';

export interface GuideGraphPanelProps {
  value: UserGuidance;
  onChange: (value: UserGuidance) => void;
  ontology: GraphOntology;
  disabled?: boolean;
  /** What the server refused, highlighted in place. */
  invalid?: { unknownTypes?: readonly string[]; invalidPinnedIds?: readonly string[] };
  /** Proposal rows whose resolution candidates can name a pinned id. */
  items?: readonly ProposalItem[];
}

export const INSTRUCTIONS_PLACEHOLDER =
  'e.g. Only the vendor migration; ignore small talk; Sam is our CTO, not a client.';

function toggle(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

interface TypeChipProps {
  label: string;
  checked: boolean;
  invalid: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function TypeChip({ label, checked, invalid, disabled, onToggle }: TypeChipProps) {
  return (
    <Chip
      label={label}
      size="small"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      color={invalid ? 'error' : checked ? 'primary' : 'default'}
      variant={checked ? 'filled' : 'outlined'}
      onClick={onToggle}
      sx={{ minHeight: 32 }}
    />
  );
}

export function GuideGraphPanel({ value, onChange, ontology, disabled, invalid, items = [] }: GuideGraphPanelProps) {
  const [relationsOpen, setRelationsOpen] = useState(Boolean(value.relationTypes));
  const [lastTypeWarning, setLastTypeWarning] = useState(false);
  const typesHeadingId = useId();
  const relationsId = useId();
  const counterId = useId();

  const entityTypes = offeredEntityTypes(ontology);
  const relationTypes = offeredRelationTypes(ontology);
  const entityKeys = entityTypes.map((type) => type.key);
  const relationKeys = relationTypes.map((type) => type.key);
  const selectedEntities = value.entityTypes ?? entityKeys;
  const selectedRelations = value.relationTypes ?? relationKeys;
  const unknown = new Set(invalid?.unknownTypes ?? []);
  const invalidPins = new Set(invalid?.invalidPinnedIds ?? []);

  const domains = ontology.domains.filter((domain) => entityTypes.some((type) => type.domain === domain.key));

  const setEntityTypes = (next: string[]) => {
    if (next.length === 0) {
      setLastTypeWarning(true);
      return;
    }
    setLastTypeWarning(false);
    const all = entityKeys.every((key) => next.includes(key));
    onChange({ ...value, entityTypes: all ? undefined : next });
  };

  const setRelationTypes = (next: string[]) => {
    const all = relationKeys.every((key) => next.includes(key));
    onChange({ ...value, relationTypes: all ? undefined : next });
  };

  const pins = value.pinnedEntityIds;
  const atPinLimit = pins.length >= GUIDANCE_MAX_PINNED;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
          Focus on
        </Typography>
        <EntitySearchField
          label="Search your graph"
          value={null}
          disabled={disabled || atPinLimit}
          excludeIds={pins}
          helperText={
            atPinLimit
              ? `You can focus on at most ${GUIDANCE_MAX_PINNED} entities`
              : 'People, projects or organizations this meeting is about'
          }
          onChange={(entity) => {
            if (!entity || pins.includes(entity.id)) return;
            rememberEntityLabel(entity.id, entity.label);
            onChange({ ...value, pinnedEntityIds: [...pins, entity.id] });
          }}
        />
        {pins.length > 0 && (
          <Box component="ul" aria-label="Focused entities" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 0, m: 0, mt: 1, listStyle: 'none' }}>
            {pins.map((id) => {
              const label = entityLabel(id, items) ?? 'A pinned entity';
              const bad = invalidPins.has(id);
              return (
                <li key={id}>
                  <Chip
                    size="small"
                    label={bad ? `${label} (no longer in your graph)` : label}
                    color={bad ? 'error' : 'default'}
                    disabled={disabled}
                    onDelete={() =>
                      onChange({ ...value, pinnedEntityIds: pins.filter((entry) => entry !== id) })
                    }
                  />
                </li>
              );
            })}
          </Box>
        )}
      </Box>

      <Box>
        <Typography id={typesHeadingId} variant="subtitle2" component="h3" sx={{ mb: 1 }}>
          Extract these types
        </Typography>
        <Stack spacing={1.5} role="group" aria-labelledby={typesHeadingId}>
          {domains.map((domain) => (
            <Box key={domain.key}>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
                {domain.label}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {entityTypes
                  .filter((type) => type.domain === domain.key)
                  .map((type) => (
                    <TypeChip
                      key={type.key}
                      label={type.label}
                      checked={selectedEntities.includes(type.key)}
                      invalid={unknown.has(type.key)}
                      disabled={disabled}
                      onToggle={() => setEntityTypes(toggle(selectedEntities, type.key))}
                    />
                  ))}
              </Box>
            </Box>
          ))}
        </Stack>
        <FormHelperText error={lastTypeWarning}>
          {lastTypeWarning
            ? 'Keep at least one type — to extract nothing, close this dialog.'
            : value.entityTypes
              ? `${value.entityTypes.length} of ${entityKeys.length} types`
              : 'All types'}
        </FormHelperText>

        {relationTypes.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Button
              size="small"
              onClick={() => setRelationsOpen((open) => !open)}
              aria-expanded={relationsOpen}
              aria-controls={relationsId}
              endIcon={relationsOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            >
              {`Relationships (${value.relationTypes ? `${value.relationTypes.length} of ${relationKeys.length}` : 'all'})`}
            </Button>
            <Collapse in={relationsOpen} id={relationsId}>
              <Box role="group" aria-label="Relationships to extract" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, pt: 1 }}>
                {relationTypes.map((type) => (
                  <TypeChip
                    key={type.key}
                    label={type.label}
                    checked={selectedRelations.includes(type.key)}
                    invalid={unknown.has(type.key)}
                    disabled={disabled}
                    onToggle={() => setRelationTypes(toggle(selectedRelations, type.key))}
                  />
                ))}
              </Box>
            </Collapse>
          </Box>
        )}
      </Box>

      <Box>
        <TextField
          label="Instructions"
          multiline
          minRows={3}
          fullWidth
          size="small"
          disabled={disabled}
          placeholder={INSTRUCTIONS_PLACEHOLDER}
          value={value.instructions}
          onChange={(event) =>
            onChange({ ...value, instructions: event.target.value.slice(0, GUIDANCE_MAX_INSTRUCTIONS) })
          }
          helperText={
            <Box component="span" id={counterId} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
              <span>Narrows what the AI proposes; it never overrides the extraction rules.</span>
              <span>{`${value.instructions.length} / ${GUIDANCE_MAX_INSTRUCTIONS}`}</span>
            </Box>
          }
          slotProps={{ htmlInput: { maxLength: GUIDANCE_MAX_INSTRUCTIONS } }}
        />
      </Box>
    </Stack>
  );
}

export default GuideGraphPanel;
