/**
 * The home page's search entry point — issue #172, epic #166 ("Home at Scale").
 *
 * `VISION.md` describes one flow — Capture → Correct → Transform → Use → **Find
 * it again later** — and `HomePage`'s own header restates the last stage as
 * question 4 that a person arrives with. Until this issue the landing screen
 * answered it with nothing at all: a user who knew exactly what they were
 * looking for had to first navigate to a library destination and find the
 * search box that lives there. This is the missing front door, and it is
 * deliberately nothing more than that.
 *
 * =============================================================================
 * A NAVIGATE-TO-THE-LIBRARY FIELD, NOT A LIVE RESULTS DROPDOWN
 * =============================================================================
 *
 * The obvious "better" version of this control is a combobox that queries as
 * you type and drops a list of matches under the field. It is rejected, and not
 * on taste:
 *
 *   1. It is A REQUEST PER KEYSTROKE FROM THE LANDING SCREEN. `HomePage`'s rule
 *      is "one request per CONTENT TYPE, all fired in parallel, and no
 *      per-section list fetches" — a rule that exists so a phone on a cellular
 *      link makes two round trips to render this page. A type-ahead is an
 *      unbounded number of additional requests on exactly the screen that rule
 *      protects, and debouncing does not change the category, only the count.
 *      This control therefore issues NO request at all; it types locally and
 *      navigates once, on submit. `HomePage.test.tsx` asserts the page's exact
 *      request list, so a regression here fails a test rather than quietly
 *      costing every user a round trip per character.
 *
 *   2. REAL SEARCH IS SOMEBODY ELSE'S SURFACE. Issue #164 (Content Search) is
 *      the feature that will own ranking, cross-type results, snippets and the
 *      empty state that explains a miss. Building half of it inside the hero
 *      would mean two search implementations with two sets of semantics, and
 *      the one on the landing screen would be the weaker of the two.
 *
 * So: a form, a term, one navigation. That is the entire contract.
 *
 * =============================================================================
 * WHY THE DESTINATION IS `/transcripts?q=` TODAY — AND THE KNOWN SEAM
 * =============================================================================
 *
 * ⚠ THIS IS A DELIBERATE PLACEHOLDER DESTINATION, NOT AN OVERSIGHT. Epic #166
 * records that this field's destination becomes the Content Search surface
 * (**issue #164**) once that lands. A `/search` route invented here and now
 * would be a route with nothing behind it: a page this issue would have to
 * build, ship, and then delete when #164 replaces it, plus an entry the
 * `config/destinations.ts` model and the AppBar title resolver would each have
 * to be taught about for a surface with a lifespan of one epic.
 *
 * `/transcripts?q=` is instead a REAL, WORKING destination that exists today.
 * The library view already owns a search box; issue #170 makes it seed that box
 * from `?q=`, which is the other half of this feature and lands separately (do
 * not add that seeding here — it belongs to the view, not to the producer of
 * the URL). When #164 ships, the follow-up is `searchPathFor()` below returning
 * `/search?q=…` — ONE LINE, one function, one test. Naming the seam is the
 * point: the next reader should be able to see that this is a known staging
 * post rather than a destination somebody picked at random.
 *
 * =============================================================================
 * WHY IT SEARCHES TRANSCRIPTS AND NOT BOTH CONTENT TYPES
 * =============================================================================
 *
 * A submit has exactly ONE destination, and today there are two content
 * libraries (`/transcripts` and `/notes`, sibling destinations since epic #105)
 * and no merged surface to send anybody to. The alternatives were all worse
 * than picking one:
 *
 *   - Two buttons ("search transcripts" / "search notes") makes the user do the
 *     routing, on a landing screen, before they know which half their words are
 *     in — and for a note generated FROM a transcript the honest answer is
 *     "both".
 *   - A type dropdown beside the field is the same question wearing a select.
 *   - Firing at both and merging client-side is a merged search surface built in
 *     the hero, which is #164's job and item 2 above.
 *
 * Transcripts is the right single answer while there is one to pick: it is the
 * larger corpus, it is what a recording's words actually live in, and a note is
 * reachable from the transcript it was generated from. #164 removes the choice.
 *
 * =============================================================================
 * PERMISSION, AND WHY IT IS READ HERE RATHER THAN THREADED AS A PROP
 * =============================================================================
 *
 * Gated on `transcripts:read` — the exact string `transcripts.controller.ts`
 * enforces and the one `config/destinations.ts` gives the `transcripts`
 * destination — because a field that navigates somewhere the router will bounce
 * the user off is worse than no field, the identical argument
 * `NewTranscriptButton` makes for hiding itself from a user without
 * `transcripts:write`.
 *
 * It is read with `usePermissions()` here rather than threaded from `HomePage`,
 * which is the opposite of what `HomeHero` does for `canCreateNote` — and the
 * difference is real: `HomePage` ALREADY computes `notes:write` for
 * `RecentNotes`, so a second read of it would be a second place for one screen
 * to disagree with itself about one user. `transcripts:read` is computed
 * nowhere on that page, so threading it would add a prop, a default, and a
 * caller that can forget it, to move a read that has no second reader.
 * `NewTranscriptButton` already establishes this exact shape for its own gate.
 *
 * =============================================================================
 * NO BREAKPOINT GATE, AND NO DISABLED SUBMIT
 * =============================================================================
 *
 * Not one `useMediaQuery` — see `HomePage`'s header. The field is full width on
 * a phone and capped from `sm` up, and that is a pair of `sx` breakpoint objects
 * resolved in CSS, so the five coupled gates in `docs/specs/settings-ui.md` §5
 * remain exactly five.
 *
 * The submit button is NEVER disabled on an empty field, deliberately. Enter
 * submits a form whatever any button's `disabled` says, so the "an empty term
 * does not navigate" rule has to live in the submit handler regardless — and a
 * second copy of it expressed as a disabled attribute is two rules that must
 * agree about trimming, about whitespace, and forever. One rule,
 * `searchPathFor`, is the whole of it.
 */

import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import SearchIcon from '@mui/icons-material/Search';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';

/**
 * The submitted term as a path, or `null` when there is nothing to search for.
 *
 * Exported and pure for the same reason `firstNameOf` is: the two decisions in
 * it are rules rather than details, and a rule is worth asserting directly.
 *
 *   - TRIM FIRST, THEN DECIDE. `'   '` is a user who hit the space bar, not a
 *     query; navigating to `/transcripts?q=%20%20%20` would send them to a
 *     library filtered to nothing with no visible reason why.
 *   - ENCODE THE TERM, ALWAYS. `&` would otherwise start a second query
 *     parameter and `#` would truncate the term into a fragment — so searching
 *     for "budget & scope#q4" would silently search for "budget ".
 *
 * `null` rather than `''` so a caller cannot navigate to a falsy-but-truthy
 * path by accident.
 *
 * ⚠ THE ONE-LINE SEAM. When issue #164 (Content Search) ships, this returns
 * `/search?q=…` and every caller, test and comment above stays as it is.
 */
export function searchPathFor(term: string): string | null {
  const trimmed = term.trim();
  if (trimmed === '') return null;
  return `/transcripts?q=${encodeURIComponent(trimmed)}`;
}

export function HomeSearchField() {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const [term, setTerm] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    // A REAL `<form>`, not an input with an `onKeyDown`. It is what makes Enter
    // work without a keyboard handler of our own, what makes a mobile keyboard
    // offer a Search key, and what makes the adornment below a submit control a
    // screen reader announces as one.
    event.preventDefault();
    const path = searchPathFor(term);
    if (path === null) return;
    navigate(path);
  };

  // See the header: no reachable destination, so no control. Hooks stay above
  // this line.
  if (!hasPermission('transcripts:read')) return null;

  return (
    <Box
      component="form"
      // A `search` landmark, so the one thing on this page a screen-reader user
      // is most likely to jump to is jumpable-to.
      role="search"
      onSubmit={handleSubmit}
      sx={{
        // Full width on a phone, where it is one more full-bleed row in a
        // column of them; capped from `sm` up, where a search field stretched
        // across a 1440px hero reads as a banner rather than as a control —
        // the same reasoning, and the same 420px cap, `SettingsHub`'s own
        // search field already uses.
        width: '100%',
        maxWidth: { xs: '100%', sm: 420 },
        mt: { xs: 2, sm: 2.5 },
      }}
    >
      <TextField
        fullWidth
        size="small"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search your transcripts"
        slotProps={{
          htmlInput: {
            // An explicit accessible name, matching `SettingsHub` and
            // `QuickSearchField`: the placeholder is not a label and it
            // vanishes the moment the user types, taking the only announced
            // name with it. DISTINCT from the submit button's name below —
            // "Search transcripts" (what this box is) versus "Search" (what
            // that button does) — so the two controls are never two
            // identically-named things in a screen reader's forms list.
            'aria-label': 'Search transcripts',
            // The mobile keyboard's Enter key reads "Search" rather than
            // "Go"/"Return".
            enterKeyHint: 'search',
          },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  type="submit"
                  size="small"
                  aria-label="Search"
                  edge="end"
                  // WCAG 2.5.8: a real touch target, not a 24px glyph.
                  sx={{ minWidth: 44, minHeight: 44 }}
                >
                  <SearchIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
        sx={{ '& .MuiInputBase-root': { minHeight: 44 } }}
      />
    </Box>
  );
}

export default HomeSearchField;
