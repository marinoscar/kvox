/**
 * "This costs real money, and it is yours" — issue #56, epic #45.
 *
 * =============================================================================
 * IT IS A LINE NEXT TO THE BUTTON, NOT A MODAL, AND THAT IS THE REQUIREMENT
 * =============================================================================
 *
 * A preview is a REAL generation on the user's own provider account, billed at
 * their provider's rates (`note-templates.controller.ts` says so in as many
 * words, and the response DTO repeats it). Issue #56 requires the UI to say so
 * **before the button is pressed** — and specifically as a short line beside
 * the action rather than a confirmation dialog.
 *
 * The distinction is not cosmetic. A modal is a thing to dismiss: it arrives
 * AFTER the decision has been made, it is read once and clicked through
 * thereafter, and it costs the user a keystroke on every iteration of a loop
 * this feature exists to make cheap (adjust, re-run, adjust, re-run). A line
 * standing next to the control is present at the moment of the decision, every
 * time, and costs nothing.
 *
 * ONE COMPONENT rather than a string repeated at each call site, for the same
 * reason `AiKeyRequired` takes no props: the moment two surfaces word this
 * differently, a user who read one and met the other has been told two
 * different things about their own bill.
 */

import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

/** The id a Preview control points `aria-describedby` at, so the notice is announced with it. */
export const PREVIEW_COST_NOTICE_ID = 'preview-cost-notice';

export function PreviewCostNotice() {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      id={PREVIEW_COST_NOTICE_ID}
      sx={{ alignItems: 'flex-start', color: 'text.secondary' }}
    >
      <InfoOutlinedIcon fontSize="small" sx={{ mt: '2px' }} aria-hidden="true" />
      <Typography variant="caption" component="p">
        Running a preview generates a real sample on <strong>your own AI provider
        account</strong>, and your provider charges you for it — the same as generating a
        note. Nothing is saved, and each run costs again.
      </Typography>
    </Stack>
  );
}

export default PreviewCostNotice;
