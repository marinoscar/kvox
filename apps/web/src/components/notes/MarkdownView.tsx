/**
 * Rendered markdown — issue #56, epic #45.
 *
 * =============================================================================
 * WHY MARKDOWN IS RENDERED AT ALL, RATHER THAN SHOWN AS TEXT
 * =============================================================================
 *
 * A note template's whole purpose is to shape the OUTPUT: headings, a numbered
 * structure, bullets, a table of decisions. A preview that showed `## Decisions`
 * as the literal characters `#`, `#`, space would be asking the user to judge
 * their template through a layer of noise the real note will not have. Issue
 * #56 requires the sample to be rendered for exactly that reason: the point of
 * the try-before-you-trust loop is to see the real thing.
 *
 * =============================================================================
 * ⚠ RAW HTML IS DISABLED, AND NOTHING MAY TURN IT ON
 * =============================================================================
 *
 * `react-markdown` ignores embedded HTML unless `rehype-raw` (or an equivalent)
 * is added to `rehypePlugins`. IT IS NOT ADDED HERE AND MUST NOT BE. The text
 * rendered by this component is model output — generated from a transcript
 * whose contents this application did not write — so treating it as markup
 * would be handing an untrusted party a path to `<script>`, `<iframe>` and
 * inline event handlers in the app's own origin.
 *
 * This is also what keeps the repository's existing posture intact: there is no
 * `dangerouslySetInnerHTML` anywhere in `apps/web`, and adding a markdown
 * renderer must not be the change that introduces one. `react-markdown` builds
 * a React element tree — it never sets HTML from a string — so the guarantee is
 * structural rather than a sanitiser that has to be kept correct.
 *
 * `remark-gfm` is included because tables, strikethrough and task lists are
 * things a model asked for "meeting notes" genuinely produces, and none of them
 * introduces markup: GFM is a parser extension, not an HTML escape hatch.
 *
 * =============================================================================
 * THE COMPONENT MAP IS MUI, NOT A STYLESHEET
 * =============================================================================
 *
 * Headings, paragraphs and list items are mapped onto MUI `Typography` so the
 * sample inherits the app's type scale and — the part that matters for the
 * accessibility criterion — the app's THEME colours in both light and dark.
 * A raw `<h2>` inside a `Paper` inherits the browser's default margins and the
 * body text colour, which is what produces the contrast failures a global
 * markdown stylesheet then has to chase.
 */

import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/**
 * Markdown element → MUI element.
 *
 * HEADING LEVELS ARE PRESERVED, not flattened: the sample's own structure is
 * what the user is judging, and a screen-reader user navigating it by heading
 * needs the same outline a sighted user sees. They are rendered at reduced
 * `variant`s so a model's `#` does not out-shout the page's own `h1`, while
 * the semantic level stays whatever the markdown said.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <Typography variant="h6" component="h1" sx={{ mt: 2, mb: 1 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography variant="subtitle1" component="h2" sx={{ mt: 2, mb: 1, fontWeight: 600 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography variant="subtitle2" component="h3" sx={{ mt: 2, mb: 0.5, fontWeight: 600 }}>
      {children}
    </Typography>
  ),
  h4: ({ children }) => (
    <Typography variant="subtitle2" component="h4" sx={{ mt: 1.5, mb: 0.5 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography variant="body2" component="p" sx={{ mb: 1.5 }}>
      {children}
    </Typography>
  ),
  li: ({ children }) => (
    <Typography variant="body2" component="li" sx={{ mb: 0.5 }}>
      {children}
    </Typography>
  ),
  hr: () => <Divider sx={{ my: 2 }} />,
  a: ({ href, children }) => (
    // A link in model output points anywhere at all, so it opens in a new tab
    // with `noreferrer` — the same treatment every other cross-origin link in
    // this app gets, for the same reason.
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  ),
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        borderLeft: 3,
        borderColor: 'divider',
        pl: 2,
        my: 1.5,
        mx: 0,
        color: 'text.secondary',
      }}
    >
      {children}
    </Box>
  ),
};

export interface MarkdownViewProps {
  /** The markdown source. Model output — never treated as markup. */
  children: string;
}

/**
 * The wrapper styling every rendered markdown body shares — exported (issue
 * #334) so the visual editor (`VisualMarkdownEditor`) lays out tables, lists
 * and code exactly as this read view does. It styles CONTAINERS only; the
 * element typography comes from `COMPONENTS` above, which the editor mirrors
 * with its own selectors because Tiptap renders raw elements, not MUI ones.
 */
export const MARKDOWN_CONTAINER_SX = {
  // Tables are the one GFM construct that can legitimately exceed the
  // panel, and the page body must never scroll horizontally because of
  // one. Scoped to this container rather than applied to the page.
  '& table': { borderCollapse: 'collapse', width: '100%', display: 'block', overflowX: 'auto' },
  '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left' },
  '& ul, & ol': { pl: 3, mt: 0, mb: 1.5 },
  '& code': {
    fontFamily: 'monospace',
    fontSize: '0.85em',
    bgcolor: 'action.hover',
    px: 0.5,
    borderRadius: 0.5,
  },
  '& pre': { overflowX: 'auto', bgcolor: 'action.hover', p: 1.5, borderRadius: 1 },
  '& > :first-of-type': { mt: 0 },
} as const;

export function MarkdownView({ children }: MarkdownViewProps) {
  return (
    <Box sx={MARKDOWN_CONTAINER_SX}>
      {/* ⚠ NO `rehypePlugins`. See this file's header — adding `rehype-raw`
          here would enable raw HTML from model output. */}
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </Markdown>
    </Box>
  );
}

export default MarkdownView;
