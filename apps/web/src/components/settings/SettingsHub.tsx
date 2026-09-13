/**
 * The settings hub — ONE component, every settings surface.
 *
 * Issue #93, epic #90. This is the page the epic exists to produce: a
 * searchable, grouped view of a settings registry that renders as a card grid
 * from `sm` up and as an iOS-style drill-down list below it.
 *
 * WHY THIS LIVES IN `components/settings/` AND TAKES PROPS, rather than being
 * `pages/Admin/SettingsHubPage.tsx` reading `ADMIN_SECTIONS` directly.
 * Issue #96 renders exactly this treatment for the per-user surface at
 * `/settings`, from `USER_SETTINGS_SECTIONS`. The two hubs are the same page
 * with a different array — and a second hub COPIED from the first is precisely
 * the failure epic #90 was filed to remove. It is the identical argument
 * `visibleSettingsSections` makes for taking `sections` as a parameter instead
 * of closing over the admin registry: one implementation cannot drift from
 * itself, two near-identical ones drift within a release. So the shared
 * component is parameterised from the start, and each surface contributes only
 * a thin binding (`pages/Admin/SettingsHubPage.tsx`) that supplies its registry
 * and its constants.
 *
 * Everything surface-specific arrives through `SettingsHubProps`. Nothing in
 * this file names "admin", and nothing in it may.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Grid,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { usePermissions } from '../../hooks/usePermissions';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { visibleSettingsSections } from '../../config/adminSections';
import type { SettingsSectionDef } from '../../config/adminSections';

export interface SettingsHubProps {
  /**
   * The registry to draw — `ADMIN_SECTIONS` (#93) or `USER_SETTINGS_SECTIONS`
   * (#96). Passed UNFILTERED: the permission and search gates both live in
   * `visibleSettingsSections`, so a caller cannot accidentally apply its own.
   */
  sections: SettingsSectionDef[];
  /**
   * Stable scroll-restoration key for this surface, e.g.
   * `'admin-settings-hub'`. Namespaced per surface so the admin hub and the
   * user hub never restore each other's offset — they are different documents
   * of different heights, and sharing a key would land the user in an
   * arbitrary place on whichever one they opened second.
   */
  hubKey: string;
  /**
   * The `h4`. Comes from the registry's own hub constant (`ADMIN_HUB_TITLE` /
   * `USER_HUB_TITLE`) rather than defaulting to `'Settings'` here: the AppBar's
   * title resolver (#95) falls back to those same constants, and a default
   * baked into this component would be a second place that decides what a hub
   * is called — the exact duplication the registry removes.
   */
  title: string;
  /** The `body1` secondary line under the title. Surface-specific prose. */
  subtitle: string;
}

export function SettingsHub({ sections, hubKey, title, subtitle }: SettingsHubProps) {
  const navigate = useNavigate();
  const theme = useTheme();
  const { hasPermission } = usePermissions();
  const [query, setQuery] = useState('');

  // 600px — `down('sm')`, byte-identical to `BottomNav`'s gate, the exact
  // complement of `Layout`'s `showRail` (`up('sm')`), and identical to the
  // compact AppBar gate #95 adds.
  //
  // ⚠️ FIVE COUPLED GATES — the full list and the reasoning live in
  // `common/Layout.tsx`. This is member (4). If the hub and the AppBar ever
  // disagree the user gets one of two broken screens: a back-arrow drill-down
  // header sitting above a card grid, or a full toolbar above a drill-down list
  // with no way back up. Below `sm` there is no rail to swap into Console mode
  // (#94), so the hub IS the navigation, and iOS Settings is the model every
  // phone user already holds.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  // The make-or-break detail of a drill-down: returning from a settings page
  // near the bottom of a long hub must land where the user left it, not at the
  // top. Called UNCONDITIONALLY, before any early return and outside any
  // branch, per the rules of hooks — `isCompactWindow` flips on a plain resize,
  // and a hook called only in the compact branch would change the hook order
  // mid-session and crash the tree.
  useScrollRestoration(hubKey);

  // ONE declaration, three consumers — see `config/adminSections.tsx`. The
  // permission gate AND the title search live in that shared helper, so this
  // page, the Console rail (#94) and the AppBar title resolver (#95) cannot
  // disagree about what the current user may see. Sections emptied by either
  // gate are dropped by the helper, so no bare group header ever renders.
  const visibleSections = visibleSettingsSections(sections, hasPermission, query);
  const trimmedQuery = query.trim();

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        {subtitle}
      </Typography>

      <TextField
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        size="small"
        placeholder="Search settings"
        // NO DEBOUNCE, deliberately. This filters an in-memory array of a few
        // dozen items; a timer would buy nothing and cost visible input lag —
        // characters appearing before the list they filter is the single most
        // common way a "responsive" search feels broken. Search is also the
        // only navigation aid here that stays constant-effort as the surface
        // grows, which is why the epic chose it over a tab strip.
        sx={{ mb: 3, width: '100%', maxWidth: { xs: '100%', sm: 420 } }}
        slotProps={{
          // The field has no visible <label> — the placeholder is not one, and
          // a placeholder disappears the moment the user types, taking the only
          // announced name with it. So the accessible name is explicit.
          htmlInput: { 'aria-label': 'Search settings' },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" color="disabled" />
              </InputAdornment>
            ),
            // Rendered only when there is something to clear. A permanently
            // mounted clear button is a dead tab stop on an empty field and
            // reads as an affordance that does nothing.
            endAdornment: query ? (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label="Clear settings search"
                  onClick={() => setQuery('')}
                >
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : null,
          },
        }}
      />

      {/* ONLY EVER A SEARCH MISS. The `trimmedQuery !== ''` half is
          load-bearing, not defensive: a user with zero visible sections and an
          EMPTY query has a permission problem, and telling them "No settings
          match" would blame their typing for an authorization state they cannot
          see or fix. Whitespace alone is not a query either — it matches
          everything in `visibleSettingsSections`, so it can never produce this
          branch and must not be phrased as though it could. */}
      {visibleSections.length === 0 && trimmedQuery !== '' && (
        <Typography variant="body2" color="text.secondary">
          No settings match “{trimmedQuery}”.
        </Typography>
      )}

      {visibleSections.map((section) => (
        <Box key={section.label} sx={{ mb: 4 }}>
          <Typography
            variant="overline"
            sx={{
              display: 'block',
              // Tighter above a list than above a grid: list rows carry their
              // own dividers and vertical padding, so a grid's gap under the
              // header would read as a break in the group rather than a label
              // attached to it.
              mb: isCompactWindow ? 0.5 : 1.5,
              color: 'text.secondary',
              fontWeight: 600,
              letterSpacing: '0.1em',
            }}
          >
            {section.label}
          </Typography>

          {/* CHOSEN BY MOUNTING, never by rendering both and hiding one with
              CSS. A hidden duplicate doubles the DOM, doubles the tab order
              with targets a keyboard user reaches but cannot see, and gives any
              `aria-current` two owners. This is the same rule `Layout` follows
              for the rail and the bottom bar, and it is why the treatments are
              a ternary rather than two `display` rules. */}
          {isCompactWindow ? (
            <List disablePadding>
              {section.cards.map((card) => {
                // A card with no `path` is "declared but not yet routed" — as
                // inert as an explicitly `disabled` one, and treated
                // identically here so it can never render as a focusable row
                // whose click does nothing.
                const inert = card.disabled || !card.path;
                return (
                  <ListItemButton
                    key={card.title}
                    disabled={inert}
                    onClick={() => card.path && navigate(card.path)}
                    sx={{
                      borderRadius: 1,
                      borderBottom: `1px solid ${theme.palette.divider}`,
                      // Matches the disabled CARD's 0.6 rather than taking
                      // MUI's default disabled opacity (0.38): the two
                      // treatments are the same surface at two widths, and a
                      // "Coming soon" row that fades harder than its card reads
                      // as a different state instead of the same one.
                      '&.Mui-disabled': { opacity: 0.6 },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 40, color: 'primary.main' }}>
                      <card.Icon fontSize="small" />
                    </ListItemIcon>
                    {/* TITLE ONLY. Descriptions are dropped at this width on
                        purpose: they roughly triple the list's height and
                        destroy the scannability the drill-down exists to
                        provide. They stay on the card grid, where there is
                        horizontal room to pay for them. */}
                    <ListItemText primary={card.title} />
                    {inert ? (
                      <Chip label="Coming soon" size="small" />
                    ) : (
                      <ChevronRightIcon fontSize="small" color="disabled" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          ) : (
            // 2 columns at `sm`, 3 from `md` up — both fall out of these sizes,
            // so the tablet and desktop treatments are one code path, not two.
            <Grid container spacing={2}>
              {section.cards.map((card) => {
                const inert = card.disabled || !card.path;
                return (
                  <Grid key={card.title} size={{ xs: 12, sm: 6, md: 4 }}>
                    {inert ? (
                      // No `CardActionArea` at all, rather than a disabled one:
                      // an inert card must not be a tab stop, and must not
                      // ripple or raise on hover as though it were about to do
                      // something.
                      <Card
                        variant="outlined"
                        sx={{ height: '100%', opacity: 0.6, cursor: 'default' }}
                      >
                        <CardContent>
                          <card.Icon sx={{ fontSize: 40 }} color="primary" />
                          <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1 }}>
                            {card.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {card.description}
                          </Typography>
                          <Chip label="Coming soon" size="small" sx={{ mt: 1 }} />
                        </CardContent>
                      </Card>
                    ) : (
                      // `height: '100%'` on BOTH the card and the action area,
                      // or a short card in a row with a tall one leaves dead
                      // space below its click target that looks clickable and
                      // is not. `alignItems: 'flex-start'` because the action
                      // area is a flex container and would otherwise centre the
                      // content block vertically, so cards in the same row
                      // would not share an icon baseline.
                      <Card variant="outlined" sx={{ height: '100%' }}>
                        <CardActionArea
                          onClick={() => card.path && navigate(card.path)}
                          sx={{ height: '100%', alignItems: 'flex-start' }}
                        >
                          <CardContent>
                            <card.Icon sx={{ fontSize: 40 }} color="primary" />
                            <Typography variant="subtitle1" sx={{ fontWeight: 600, mt: 1 }}>
                              {card.title}
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                              {card.description}
                            </Typography>
                          </CardContent>
                        </CardActionArea>
                      </Card>
                    )}
                  </Grid>
                );
              })}
            </Grid>
          )}
        </Box>
      ))}
    </Box>
  );
}

export default SettingsHub;
