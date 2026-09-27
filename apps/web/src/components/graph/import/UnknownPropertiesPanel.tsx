/**
 * "Unknown properties" on the import page (#387; spec §17.1, §17.3, §18.3).
 *
 * Closed by default: a property the file used that your ontology does not
 * declare was removed before validation and is offered here — Accept creates
 * it as one of your own attributes and keeps its values on the imported rows;
 * Reject drops them. Nothing is kept silently. A property that sat only on
 * relations can never become an attribute, so it arrives already rejected.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { GraphImportOffer } from '../../../services/graph';

const KIND_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  url: 'Link',
  entity_ref: 'Reference',
  select: 'Choice',
  multi_select: 'Choices',
};

export interface UnknownPropertiesPanelProps {
  offers: readonly GraphImportOffer[];
  canDecide: boolean;
  busyOfferId: string | null;
  onAccept: (offer: GraphImportOffer) => void;
  onReject: (offer: GraphImportOffer) => void;
}

function offerTitle(offer: GraphImportOffer): string {
  return offer.label ?? offer.iri.split(/[#/]/).filter(Boolean).pop() ?? offer.iri;
}

export function UnknownPropertiesPanel({ offers, canDecide, busyOfferId, onAccept, onReject }: UnknownPropertiesPanelProps) {
  if (offers.length === 0) return null;
  const undecided = offers.filter((o) => o.status === 'offered').length;
  return (
    <Paper variant="outlined" component="section" aria-labelledby="unknown-properties-heading" sx={{ p: 2, mb: 2 }}>
      <Typography id="unknown-properties-heading" variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
        Unknown properties
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Your file uses {offers.length === 1 ? 'a property' : `${offers.length} properties`} your ontology does not
        have. Accept one to add it as an attribute and keep its values; reject it to leave them out.
        {undecided > 0 ? ` ${undecided} still to decide.` : ''}
      </Typography>
      <Stack spacing={1.5} component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {offers.map((offer) => {
          const onRelationsOnly = offer.subjectTypes.length > 0 && offer.subjectTypes.every((t) => t === 'Assertion');
          const busy = busyOfferId === offer.offerId;
          return (
            <Box component="li" key={offer.offerId} data-testid={`offer-${offer.offerId}`} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {offerTitle(offer)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-all' }}>
                    {offer.iri}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {offer.count} {offer.count === 1 ? 'value' : 'values'} on {offer.subjectTypes.join(', ')} · suggested
                    kind: {KIND_LABELS[offer.suggestedKind] ?? offer.suggestedKind}
                  </Typography>
                  {offer.sampleValues.length > 0 && (
                    <Typography variant="caption" component="div" sx={{ wordBreak: 'break-word' }}>
                      e.g. {offer.sampleValues.map((v) => `“${v}”`).join(', ')}
                    </Typography>
                  )}
                </Box>
                <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
                  {offer.status === 'offered' && canDecide ? (
                    <>
                      <Button size="small" variant="contained" disabled={busy} onClick={() => onAccept(offer)}>
                        Accept
                      </Button>
                      <Button size="small" disabled={busy} onClick={() => onReject(offer)}>
                        Reject
                      </Button>
                    </>
                  ) : (
                    <Chip
                      size="small"
                      label={offer.status === 'accepted' ? 'Added as attribute' : offer.status === 'rejected' ? 'Left out' : 'Undecided'}
                      color={offer.status === 'accepted' ? 'success' : 'default'}
                    />
                  )}
                </Stack>
              </Stack>
              {onRelationsOnly && (
                <Alert severity="info" variant="outlined" sx={{ mt: 1, py: 0 }}>
                  Only on relations — attributes belong to people, organizations and other entities.
                </Alert>
              )}
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}

export default UnknownPropertiesPanel;
