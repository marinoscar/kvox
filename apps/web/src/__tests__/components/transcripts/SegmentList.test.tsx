import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { SegmentList } from '../../../components/transcripts/SegmentList';
import type {
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptWord,
} from '../../../services/transcripts';

/**
 * The virtualized transcript.
 *
 * =============================================================================
 * WHY THIS FILE INSTALLS LAYOUT STUBS
 * =============================================================================
 *
 * jsdom performs no layout: every box is 0×0 and `ResizeObserver` is a no-op
 * (see `__tests__/setup.ts`). `@tanstack/react-virtual` reads the scroll
 * container's rect once on mount and each row's rect through `measureElement`,
 * so with jsdom's real geometry it would compute a zero-height viewport and
 * render a single row — which would make the "row count stays bounded"
 * assertion below pass for entirely the wrong reason.
 *
 * The stubs are the same recipe `components/datatable/__tests__/testUtils/
 * layoutStubs.ts` established for MUI X's own virtualizer, narrowed to what
 * this component needs: a 600px-tall scroll container, 80px rows, and an
 * `Element.prototype.scrollTo` (jsdom defines `scrollTo` on `window` only, and
 * `scrollToIndex` calls it on the element).
 *
 * ⚠ `offsetHeight`, NOT `getBoundingClientRect`. Both the viewport measurement
 * (`getRect`) and the per-row one (`measureElement`) read `offsetWidth` /
 * `offsetHeight` — stubbing the rect instead leaves both at jsdom's zero and
 * the virtualizer renders nothing at all, which looks exactly like a broken
 * component.
 */

const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 80;

let scrollTo: ReturnType<typeof vi.fn>;

function isRowElement(element: Element): boolean {
  return (element as HTMLElement).dataset?.testid === 'segment-row';
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isRowElement(this) ? ROW_HEIGHT : VIEWPORT_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
});

afterAll(() => {
  // `delete` restores jsdom's own accessor from further up the prototype
  // chain; assigning `undefined` would leave a getter that answers undefined.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

beforeEach(() => {
  scrollTo = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
});

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
    startMs: index * 5000,
    endMs: index * 5000 + 4000,
    ordinal: index + 1,
    text: `Line number ${index}`,
    wordsAlignment: 'exact' as const,
    confidence: 0.9,
    origin: 'ai' as const,
    rev: 1,
    editedAt: null,
  }));
}

function renderList(
  overrides: Partial<Parameters<typeof SegmentList>[0]> = {},
  segments = makeSegments(50),
) {
  const onPlayFrom = vi.fn();
  const result = render(
    <SegmentList
      segments={segments}
      speakers={SPEAKERS}
      currentSegmentIndex={-1}
      positionMs={0}
      wordsBySegment={new Map<string, TranscriptWord[]>()}
      onPlayFrom={onPlayFrom}
      selectedSpeakerIds={[]}
      {...overrides}
    />,
  );
  return { ...result, onPlayFrom };
}

describe('SegmentList — virtualization', () => {
  it('keeps the DOM row count bounded across a 6,000-segment transcript', () => {
    // The benchmark fixture issue #30 names. The whole point of virtualizing
    // is that this number does not track the transcript's length: a ten-hour
    // conversation is tens of thousands of segments, and rendering them all on
    // a phone is a blank screen rather than a slow one.
    renderList({}, makeSegments(6000));

    const rows = screen.getAllByTestId('segment-row');
    expect(rows.length).toBeGreaterThan(0);
    // A 600px viewport over 80px rows is ~8 visible plus 6 overscan each side.
    // The generous ceiling is what keeps this a VIRTUALIZATION assertion rather
    // than a brittle count of the overscan constant.
    expect(rows.length).toBeLessThan(100);
  });

  it('renders the same bounded count for 50 segments as for 6,000', () => {
    // The complement: if the count tracked the input, the assertion above
    // would pass for a list that simply had fewer rows to draw.
    const { unmount } = renderList({}, makeSegments(50));
    const small = screen.getAllByTestId('segment-row').length;
    unmount();

    renderList({}, makeSegments(6000));
    const large = screen.getAllByTestId('segment-row').length;

    expect(large).toBe(small);
  });

  it('reserves the FULL scroll height, so the scrollbar tells the truth', () => {
    // Virtualizing the rows must not virtualize the scroll range: a 6,000-row
    // transcript whose container is 20 rows tall would be unscrollable.
    const { container } = renderList({}, makeSegments(6000));
    const sizer = container.querySelector('[role="region"] > div') as HTMLElement;

    // `getComputedStyle`, not `.style`: the height comes from an `sx` prop, so
    // emotion emits it as a class rule rather than as an inline declaration.
    const height = parseInt(window.getComputedStyle(sizer).height, 10);
    expect(height).toBeGreaterThan(6000 * ROW_HEIGHT * 0.9);
  });
});

describe('SegmentList — content', () => {
  it('renders each speaker’s name beside their text', () => {
    renderList();

    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ben').length).toBeGreaterThan(0);
    expect(screen.getByText('Line number 0')).toBeInTheDocument();
  });

  it('plays from a segment when its timestamp is activated', async () => {
    const user = userEvent.setup();
    const { onPlayFrom } = renderList();

    await user.click(screen.getByRole('button', { name: 'Play from 0:10' }));

    expect(onPlayFrom).toHaveBeenCalledWith(10_000);
  });

  it('names the timestamp control by what it DOES, not by its digits', () => {
    // "0:10" is a fine visual label and a useless accessible one — it does not
    // say that activating it starts playback.
    renderList();

    expect(screen.getByRole('button', { name: 'Play from 0:05' })).toBeInTheDocument();
  });

  it('highlights the current word when word timings are in hand', () => {
    const words: TranscriptWord[] = [
      { t: 'hello', s: 0, e: 500, c: 0.9 },
      { t: 'there', s: 500, e: 1000, c: 0.9 },
    ];

    renderList({
      currentSegmentIndex: 0,
      positionMs: 600,
      wordsBySegment: new Map([['s0', words]]),
    });

    // Rendered as words rather than as the segment's plain text, which is what
    // makes per-word highlighting possible at all.
    expect(screen.getByText('there')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('falls back to the segment text when no word timings have arrived', () => {
    // Word windows are fetched lazily and their failure is silent by design —
    // the transcript must read correctly without them.
    renderList({ currentSegmentIndex: 0, positionMs: 600 });

    expect(screen.getByText('Line number 0')).toBeInTheDocument();
  });

  it('is a named region, so a screen-reader user can jump straight to it', () => {
    renderList();

    expect(screen.getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
  });

  it('says so plainly when there are no segments', () => {
    renderList({}, []);

    expect(screen.getByText(/no segments/i)).toBeInTheDocument();
  });
});

describe('SegmentList — auto-follow and "Jump to current"', () => {
  it('follows the current segment while the reader has not scrolled', () => {
    const { rerender } = renderList({ currentSegmentIndex: 0 });
    scrollTo.mockClear();

    rerender(
      <SegmentList
        segments={makeSegments(50)}
        speakers={SPEAKERS}
        currentSegmentIndex={20}
        positionMs={100_000}
        wordsBySegment={new Map()}
        onPlayFrom={vi.fn()}
        selectedSpeakerIds={[]}
      />,
    );

    expect(scrollTo).toHaveBeenCalled();
  });

  it('offers no "Jump to current" button while it is already following', () => {
    // A permanently visible button that is sometimes a no-op trains the reader
    // to ignore it.
    renderList({ currentSegmentIndex: 5 });

    expect(
      screen.queryByRole('button', { name: 'Jump to current' }),
    ).not.toBeInTheDocument();
  });

  it('disengages following on a user scroll gesture and offers the button', () => {
    // Continuing to yank the viewport back while somebody is re-reading is the
    // single most hostile thing a transcript reader can do.
    renderList({ currentSegmentIndex: 5 });
    const region = screen.getByRole('region', { name: 'Transcript' });

    fireEvent.wheel(region);

    expect(screen.getByRole('button', { name: 'Jump to current' })).toBeInTheDocument();
  });

  it('disengages on touch and on a keyboard scroll too', () => {
    renderList({ currentSegmentIndex: 5 });
    const region = screen.getByRole('region', { name: 'Transcript' });

    fireEvent.touchStart(region);
    expect(screen.getByRole('button', { name: 'Jump to current' })).toBeInTheDocument();
  });

  it('stops following once disengaged, even as the current segment moves', () => {
    const { rerender } = renderList({ currentSegmentIndex: 5 });
    fireEvent.wheel(screen.getByRole('region', { name: 'Transcript' }));
    scrollTo.mockClear();

    rerender(
      <SegmentList
        segments={makeSegments(50)}
        speakers={SPEAKERS}
        currentSegmentIndex={30}
        positionMs={150_000}
        wordsBySegment={new Map()}
        onPlayFrom={vi.fn()}
        selectedSpeakerIds={[]}
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('re-engages following when the button is used, and hides itself again', async () => {
    // Engaging is always explicit, disengaging always implicit — the reverse
    // would mean the reader has to fight the page first and find the control
    // second.
    const user = userEvent.setup();
    renderList({ currentSegmentIndex: 5 });
    fireEvent.wheel(screen.getByRole('region', { name: 'Transcript' }));
    scrollTo.mockClear();

    await user.click(screen.getByRole('button', { name: 'Jump to current' }));

    expect(scrollTo).toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Jump to current' }),
    ).not.toBeInTheDocument();
  });

  it('offers no button when there is no current segment to jump to', () => {
    renderList({ currentSegmentIndex: -1 });
    fireEvent.wheel(screen.getByRole('region', { name: 'Transcript' }));

    expect(
      screen.queryByRole('button', { name: 'Jump to current' }),
    ).not.toBeInTheDocument();
  });
});

describe('SegmentList — per-line playback (#108)', () => {
  it('gives every row a play button named by speaker and time', () => {
    // "Play" alone would be four identical buttons on screen at once, and a
    // screen-reader user moving by button would have no way to tell which line
    // they were about to hear.
    renderList({ onPlaySegment: vi.fn() });

    expect(
      screen.getByRole('button', { name: 'Play this line, Ana at 0:00' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Play this line, Ben at 0:05' }),
    ).toBeInTheDocument();
  });

  it('mounts NO play button when no handler is given', () => {
    // The read-only preview (the history page, the visual baselines) gets the
    // reader #30 shipped: the control does not exist rather than existing
    // disabled, because a disabled button is still something to announce.
    renderList();

    expect(screen.queryByRole('button', { name: /^Play this line/ })).toBeNull();
  });

  it('shows Pause, and reports itself pressed, on the line actually playing', () => {
    renderList({ onPlaySegment: vi.fn(), activeSegmentId: 's1', isPlaying: true });

    const pause = screen.getByRole('button', { name: 'Pause this line' });
    expect(pause).toHaveAttribute('aria-pressed', 'true');
    // Exactly one row at a time, and every other row is unpressed.
    expect(screen.queryAllByRole('button', { name: 'Pause this line' })).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Play this line, Ana at 0:00' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows Play again when the active line is paused', () => {
    // `activeSegmentId` outlives a browser-level pause for a moment; a Pause
    // icon over silent audio is worse than a slightly late one.
    renderList({ onPlaySegment: vi.fn(), activeSegmentId: 's1', isPlaying: false });

    expect(screen.queryByRole('button', { name: 'Pause this line' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Play this line, Ben at 0:05' }),
    ).toBeInTheDocument();
  });

  it('hands the WHOLE segment to the handler, not just its bounds', async () => {
    const user = userEvent.setup();
    const onPlaySegment = vi.fn();
    const segments = makeSegments(50);
    renderList({ onPlaySegment }, segments);

    await user.click(screen.getByRole('button', { name: 'Play this line, Ben at 0:05' }));

    expect(onPlaySegment).toHaveBeenCalledWith(segments[1]);
  });

  it('pauses instead of restarting when the line is already playing', async () => {
    const user = userEvent.setup();
    const onPlaySegment = vi.fn();
    const onPause = vi.fn();
    renderList({ onPlaySegment, onPause, activeSegmentId: 's1', isPlaying: true });

    await user.click(screen.getByRole('button', { name: 'Pause this line' }));

    expect(onPause).toHaveBeenCalled();
    expect(onPlaySegment).not.toHaveBeenCalled();
  });

  it('does not disengage auto-follow when the button is clicked', () => {
    // A click is not a `wheel`/`touchstart`/`keydown` on the scroll region, so
    // following survives — which is what a reader who just asked to hear a line
    // wants. See the component header for the keyboard case.
    renderList({ onPlaySegment: vi.fn(), currentSegmentIndex: 5 });

    fireEvent.click(screen.getByRole('button', { name: 'Play this line, Ana at 0:00' }));

    expect(screen.queryByRole('button', { name: 'Jump to current' })).toBeNull();
  });

  it('has no accessibility violations with the buttons mounted', async () => {
    const { container } = renderList({
      onPlaySegment: vi.fn(),
      onPause: vi.fn(),
      activeSegmentId: 's1',
      isPlaying: true,
      currentSegmentIndex: 1,
    });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('SegmentList — the speaker name control (#220)', () => {
  it('renders the speaker name as a button stating the all-lines scope, when editable with a handler', () => {
    // A two-row fixture, one speaker each, so each speaker's button is the
    // only one of its name on screen.
    renderList({ editable: true, onOpenSpeakerActions: vi.fn() }, makeSegments(2));

    expect(
      screen.getByRole('button', {
        name: 'Rename Ana or merge, applies to every line they speak',
      }),
    ).toBeInTheDocument();
  });

  it('opens speaker actions for THIS ROW’s speaker id, not the segment id', async () => {
    const user = userEvent.setup();
    const onOpenSpeakerActions = vi.fn();
    renderList({ editable: true, onOpenSpeakerActions }, makeSegments(2));

    await user.click(
      screen.getByRole('button', {
        name: 'Rename Ben or merge, applies to every line they speak',
      }),
    );

    expect(onOpenSpeakerActions).toHaveBeenCalledTimes(1);
    const [speakerId, anchor] = onOpenSpeakerActions.mock.calls[0];
    // s1 is Ben's line (odd index) — asserting the SPEAKER id here, not the
    // segment id, is the whole point: the #220 defect was exactly this scope
    // getting confused one layer up, in `SegmentActions`.
    expect(speakerId).toBe('sp2');
    expect(anchor).toBeInstanceOf(HTMLElement);
  });

  it('renders the speaker name as plain text — no button, nothing in the tab order — for the read-only preview', () => {
    // Neither prop given: the viewer path, and the history page's read-only
    // preview, must render exactly what #30 shipped.
    renderList();

    expect(
      screen.queryByRole('button', { name: /Rename Ana or merge/ }),
    ).not.toBeInTheDocument();
    const name = screen.getAllByText('Ana')[0];
    expect(name).not.toHaveAttribute('role', 'button');
    expect(name).not.toHaveAttribute('tabindex');
  });

  it('stays plain text when editable but no handler is given', () => {
    // The button is gated on BOTH `editable` AND `onOpenSpeakerActions` —
    // `editable` alone (e.g. a page mid-transition) must not mount a control
    // with nothing to call.
    renderList({ editable: true }, makeSegments(2));

    expect(
      screen.queryByRole('button', { name: /Rename Ana or merge/ }),
    ).not.toBeInTheDocument();
  });
});
