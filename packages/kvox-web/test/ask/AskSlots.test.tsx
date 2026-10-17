import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { render } from './helpers.js';
import { graphReader, noGraphUser } from '../graph/graphTestUsers.js';
import { AskEntityButtonSlot, AskEntityPanelSlot, kvoxAskRoutes } from '../../src/ask/ui/index.js';

/**
 * The slot components of the graph entity page (#504): they draw only for a
 * viewer holding `graph:read` on a deployment with connected knowledge on, so a
 * host wires them unconditionally.
 */

const PANEL_PROPS = {
  entityId: 'e1',
  entityLabel: 'Joe Rivera',
  entityType: 'Person',
  open: true,
  onClose: vi.fn(),
  conversationId: null,
  onConversationChange: vi.fn(),
};

describe('AskEntityButtonSlot', () => {
  it('draws the action for a viewer with graph:read when connected knowledge is on', () => {
    render(<AskEntityButtonSlot entityId="e1" entityLabel="Joe Rivera" onClick={vi.fn()} />, {
      wrapperOptions: { user: graphReader },
    });
    expect(screen.getByRole('button', { name: 'Ask about Joe Rivera' })).toBeInTheDocument();
  });

  it('draws nothing when connected knowledge is off or unknown', () => {
    for (const graphEnabled of [false, undefined]) {
      const { container, unmount } = render(
        <AskEntityButtonSlot entityId="e1" entityLabel="Joe Rivera" onClick={vi.fn()} />,
        { wrapperOptions: { user: graphReader }, hostOptions: { features: { graphEnabled } } },
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('draws nothing without graph:read', () => {
    const { container } = render(
      <AskEntityButtonSlot entityId="e1" entityLabel="Joe Rivera" onClick={vi.fn()} />,
      { wrapperOptions: { user: noGraphUser } },
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AskEntityPanelSlot', () => {
  it('draws the panel for a viewer with graph:read when connected knowledge is on', async () => {
    render(<AskEntityPanelSlot {...PANEL_PROPS} />, { wrapperOptions: { user: graphReader } });
    expect(await screen.findByRole('dialog', { name: 'Ask about Joe Rivera' })).toBeInTheDocument();
  });

  it('draws nothing, and reads no configuration, when it is off or the viewer lacks graph:read', () => {
    const off = render(<AskEntityPanelSlot {...PANEL_PROPS} />, {
      wrapperOptions: { user: graphReader },
      hostOptions: { features: { graphEnabled: false } },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(off.host.calls.filter((call) => call.port === 'http')).toEqual([]);
    off.unmount();

    const denied = render(<AskEntityPanelSlot {...PANEL_PROPS} />, { wrapperOptions: { user: noGraphUser } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(denied.host.calls.filter((call) => call.port === 'http')).toEqual([]);
  });
});

describe('kvoxAskRoutes', () => {
  it('is one route with an optional conversation segment, gated on graph:read', () => {
    expect(kvoxAskRoutes.map(({ path, permission }) => ({ path, permission }))).toEqual([
      { path: '/ask/:conversationId?', permission: 'graph:read' },
    ]);
  });
});
