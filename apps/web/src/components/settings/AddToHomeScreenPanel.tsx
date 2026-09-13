/**
 * THE iOS "ADD TO HOME SCREEN" WALKTHROUGH.
 *
 * Issue #231, epic #215. Rendered by `NotificationSettings.tsx` in place of the
 * normal permission banner whenever `useNotificationCapability` reports
 * `'ios-needs-install'` — see that hook's file header for the full precedence
 * argument, and `browserChannelState` in `NotificationSettings.tsx` for the
 * short inline note (`'Add to Home Screen to enable'`) this panel supplements
 * rather than replaces.
 *
 * =============================================================================
 * WHY THIS EXISTS AS ITS OWN COMPONENT, NOT JUST A LONGER `alert.body` STRING
 * =============================================================================
 *
 * `browserChannelState`'s `ios-needs-install` arm deliberately ships a SHORT
 * body ("#231 adds the illustrated step-by-step panel; this is the inline note
 * that has to be right on its own until then"). That shortness was correct for
 * a one-line `Alert` body rendered with `white-space: pre-line`, but the actual
 * remedy has two concrete, orderable steps with a specific icon and a specific
 * menu-item title — content that reads better as a short list than as a
 * sentence, which is why this is a distinct component with structure (an
 * ordered `List`) rather than a longer string threaded through the existing
 * `alert: { severity, title, body }` shape.
 *
 * =============================================================================
 * WHY THE COPY IS THIS SPECIFIC
 * =============================================================================
 *
 * "Tap the Share button" is useless on its own — Safari's toolbar has several
 * icons and "Share" is not written on any of them. The icon actually shown is
 * a square with an arrow pointing up out of it, so that is what the copy
 * describes, and the icon rendered here (`IosShareIcon`) is the closest
 * standard glyph to it. Likewise the target menu item is named here exactly as
 * Safari labels it — "Add to Home Screen" — because a paraphrase ("install
 * it", "save it") sends the user hunting through a menu for words that are not
 * there.
 *
 * =============================================================================
 * DELIBERATELY DUMB
 * =============================================================================
 *
 * No props, no platform detection, no `useNotificationCapability` call of its
 * own. The ONE place that decides whether iOS, non-standalone, applies is
 * `resolveNotificationCapability` (`hooks/useNotificationCapability.ts`); this
 * component only renders the remedy for that decision, exactly like
 * `browserChannelState`'s other arms render their own alerts without
 * re-deriving the capability that chose them. A second gate here would be a
 * second place that could disagree with the first about when to show it.
 */

import { Alert, AlertTitle, List, ListItem, ListItemIcon, ListItemText, Typography } from '@mui/material';
import IosShareIcon from '@mui/icons-material/IosShare';
import AddToHomeScreenIcon from '@mui/icons-material/AddToHomeScreen';

export function AddToHomeScreenPanel() {
  return (
    <Alert severity="info">
      <AlertTitle>Add this app to your Home Screen</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        iOS and iPadOS permit web notifications only for an app added to the
        Home Screen — never for a page open in an ordinary Safari tab, no
        matter what permission you grant there. Add it once, then open the app
        from its Home Screen icon to turn notifications on.
      </Typography>

      <List dense disablePadding>
        <ListItem disableGutters alignItems="flex-start">
          <ListItemIcon sx={{ minWidth: 32, mt: '2px' }}>
            <IosShareIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="1. Tap the Share button"
            secondary={
              // The square-with-an-upward-arrow icon, not a labelled "Share"
              // button — Safari's toolbar never spells the word out.
              "The square icon with an arrow pointing up, in Safari's toolbar."
            }
          />
        </ListItem>
        <ListItem disableGutters alignItems="flex-start">
          <ListItemIcon sx={{ minWidth: 32, mt: '2px' }}>
            <AddToHomeScreenIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary='2. Choose "Add to Home Screen"'
            secondary="It's further down the share sheet's list of actions."
          />
        </ListItem>
      </List>

      <Typography variant="body2" sx={{ mt: 1 }}>
        Then open the app from that new Home Screen icon — not from Safari —
        and allow notifications when it asks.
      </Typography>
    </Alert>
  );
}

export default AddToHomeScreenPanel;
