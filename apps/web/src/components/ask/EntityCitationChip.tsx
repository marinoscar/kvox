/**
 * `EntityCitationChip` — an Ask answer citing an ENTITY itself (`[^entN]`,
 * #380): a label chip linking to that entity's page (#373).
 *
 * A link, not a button: it navigates, and a keyboard user reaches it with Tab
 * and follows it with Enter like any other link in running text.
 */

import Chip from '@mui/material/Chip';
import { Link as RouterLink } from 'react-router-dom';

import { EntityTypeIcon } from '../graph/entityTypeIcon';
import { entityPath } from '../graph/EntityListRow';

export interface EntityCitationChipProps {
  entityId: string;
  /** The entity's label at answer time; falls back to "Entity". */
  label: string | null;
  /** The ontology type, when known, for the icon. */
  type?: string | null;
}

export function EntityCitationChip({ entityId, label, type }: EntityCitationChipProps) {
  const text = label?.trim() || 'Entity';
  return (
    <Chip
      component={RouterLink}
      to={entityPath(entityId)}
      clickable
      size="small"
      variant="outlined"
      color="primary"
      icon={type ? <EntityTypeIcon type={type} /> : undefined}
      label={text}
      aria-label={`Open ${text}`}
      sx={{ height: 22, mx: 0.25, verticalAlign: 'middle', maxWidth: '100%' }}
    />
  );
}

export default EntityCitationChip;
