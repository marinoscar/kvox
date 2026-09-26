import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { SpeakerFilter } from '../../../components/transcripts/SpeakerFilter';
import type { TranscriptSegment, TranscriptSpeaker } from '../../../services/transcripts';

/**
 * The speaker row, and the phone-width scroll affordance (#112).
 *
 * =============================================================================
 * WHY THIS FILE STUBS SCROLL GEOMETRY
 * =============================================================================
 *
 * jsdom performs no layout, so `scrollWidth`, `clientWidth` and `scrollLeft`
 * are all a flat `0` on every element. The component decides whether to wear
 * its right-edge fade from exactly those three numbers, and `0 + 0 < 0 - 1` is
 * false — so with jsdom's own geometry every assertion about the fade would
 * pass for the wrong reason (there is never a fade, whatever the content).
 *
 * The stubs are the recipe `components/datatable/__tests__/testUtils/
 * layoutStubs.ts` and `SegmentList.test.tsx` both use — prototype getters over
 * a module-level variable — narrowed to the three properties this component
 * reads, and switchable per test so one file can render both an overflowing
 * row and a row that fits.
 *
 * ⚠ The fade itself is `mask-image` in an emotion-generated class, and jsdom's
 * CSS parser drops properties it does not implement, so neither
 * `getComputedStyle` nor the inline `style` can see it. The component mirrors
 * the same measured state onto `data-can-scroll-right` for exactly this
 * reason, and that attribute is what these tests assert on.
 */

interface Geometry {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

/** A row that fits: nothing to the right, so no fade. */
const FITS: Geometry = { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 };
/** A 390px phone showing the first of several chips. */
const OVERFLOWS: Geometry = { scrollWidth: 900, clientWidth: 358, scrollLeft: 0 };

let geometry: Geometry = FITS;

beforeAll(() => {
  for (const prop of ['scrollWidth', 'clientWidth', 'scrollLeft'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => geometry[prop],
    });
  }
});

afterAll(() => {
  // `delete` restores jsdom's own accessor from further up the prototype
  // chain; assigning `undefined` would leave a getter answering undefined.
  for (const prop of ['scrollWidth', 'clientWidth', 'scrollLeft'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

beforeEach(() => {
  geometry = FITS;
});

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
  { id: 'sp3', label: 'C', displayName: 'Carolina Fernández', colorIndex: 2, rev: 1 },
];

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 6 }, (_, index) => ({
  id: `s${index}`,
  speakerId: SPEAKERS[index % SPEAKERS.length].id,
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

function renderChips(selectedSpeakerIds: string[] = []) {
  return render(
    <SpeakerFilter
      speakers={SPEAKERS}
      segments={SEGMENTS}
      selectedSpeakerIds={selectedSpeakerIds}
      onToggleSpeaker={vi.fn()}
      variant="chips"
    />,
  );
}

const row = () => screen.getByRole('group', { name: 'Speakers' });

describe('SpeakerFilter — the chip row’s scroll affordance (#112)', () => {
  it('fades the right edge while the row still has chips off-screen', () => {
    geometry = OVERFLOWS;
    renderChips();

    expect(row()).toHaveAttribute('data-can-scroll-right', 'true');
  });

  it('shows no fade on a row that fits, where it would be a lie about more', () => {
    geometry = FITS;
    renderChips();

    expect(row()).not.toHaveAttribute('data-can-scroll-right');
  });

  it('drops the fade once the row is scrolled to its end', () => {
    // The listener, and the one-pixel epsilon it measures with: a row scrolled
    // fully right routinely reports a `scrollLeft` a fraction short of the
    // difference, and without the epsilon the fade would never switch off.
    geometry = OVERFLOWS;
    renderChips();
    expect(row()).toHaveAttribute('data-can-scroll-right', 'true');

    geometry = { ...OVERFLOWS, scrollLeft: OVERFLOWS.scrollWidth - OVERFLOWS.clientWidth };
    fireEvent.scroll(row());

    expect(row()).not.toHaveAttribute('data-can-scroll-right');
  });

  it('keeps every chip’s accessible name under the fade', () => {
    // The fade is decorative and a mask hides nothing from assistive
    // technology — the chip beneath it is still a named, reachable button.
    geometry = OVERFLOWS;
    renderChips();

    for (const name of ['Play only Ana', 'Play only Ben', 'Play only Carolina Fernández']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('still flips a chip’s name to the "stop" verb when it is selected', () => {
    geometry = OVERFLOWS;
    renderChips(['sp1']);

    expect(screen.getByRole('button', { name: 'Stop playing only Ana' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play only Ben' })).toBeInTheDocument();
  });

  it('keeps the editable row’s action-sheet names', () => {
    geometry = OVERFLOWS;
    render(
      <SpeakerFilter
        speakers={SPEAKERS}
        segments={SEGMENTS}
        selectedSpeakerIds={[]}
        onToggleSpeaker={vi.fn()}
        variant="chips"
        editable
        onOpenSpeakerActions={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Actions for Ana' })).toBeInTheDocument();
  });

  it('still toggles the speaker when a chip under the fade is activated', async () => {
    const user = userEvent.setup();
    const onToggleSpeaker = vi.fn();
    geometry = OVERFLOWS;
    render(
      <SpeakerFilter
        speakers={SPEAKERS}
        segments={SEGMENTS}
        selectedSpeakerIds={[]}
        onToggleSpeaker={onToggleSpeaker}
        variant="chips"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Play only Carolina Fernández' }));

    expect(onToggleSpeaker).toHaveBeenCalledWith('sp3');
  });

  it('has no axe violations while the fade is on', async () => {
    geometry = OVERFLOWS;
    const { container } = renderChips();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on a row that fits', async () => {
    geometry = FITS;
    const { container } = renderChips();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('SpeakerFilter — the panel variant is untouched by #112', () => {
  it('never carries the chip row’s scroll attribute', () => {
    geometry = OVERFLOWS;
    render(
      <SpeakerFilter
        speakers={SPEAKERS}
        segments={SEGMENTS}
        selectedSpeakerIds={[]}
        onToggleSpeaker={vi.fn()}
        variant="panel"
      />,
    );

    expect(screen.getByRole('list', { name: 'Speakers' })).not.toHaveAttribute(
      'data-can-scroll-right',
    );
    expect(screen.getByRole('button', { name: 'Play only Ana' })).toBeInTheDocument();
  });
});

describe('SpeakerFilter — person links to the knowledge graph (#373)', () => {
  const ENTITY_IDS = { sp1: 'entity-ana' };

  function renderWith(variant: 'chips' | 'panel', onOpen = vi.fn(), editable = false) {
    return {
      onOpen,
      ...render(
        <SpeakerFilter
          speakers={SPEAKERS}
          segments={SEGMENTS}
          selectedSpeakerIds={[]}
          onToggleSpeaker={vi.fn()}
          variant={variant}
          editable={editable}
          onOpenSpeakerActions={vi.fn()}
          speakerEntityIds={ENTITY_IDS}
          onOpenSpeakerEntity={onOpen}
        />,
      ),
    };
  }

  it.each(['chips', 'panel'] as const)(
    'renders a link only for a mapped speaker (%s variant) and fires the callback',
    async (variant) => {
      const user = userEvent.setup();
      const { onOpen, container } = renderWith(variant);

      const link = screen.getByRole('button', { name: "Open Ana's page" });
      expect(screen.queryByRole('button', { name: "Open Ben's page" })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Open Carolina/ })).not.toBeInTheDocument();

      await user.click(link);
      expect(onOpen).toHaveBeenCalledWith('entity-ana');
      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    },
  );

  it('keeps the actions button beside the link in the editable panel', () => {
    renderWith('panel', vi.fn(), true);
    expect(screen.getByRole('button', { name: "Open Ana's page" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Ana' })).toBeInTheDocument();
  });

  it('renders no link without the callback, even with a map', () => {
    render(
      <SpeakerFilter
        speakers={SPEAKERS}
        segments={SEGMENTS}
        selectedSpeakerIds={[]}
        onToggleSpeaker={vi.fn()}
        variant="chips"
        speakerEntityIds={ENTITY_IDS}
      />,
    );
    expect(screen.queryByRole('button', { name: "Open Ana's page" })).not.toBeInTheDocument();
  });
});
