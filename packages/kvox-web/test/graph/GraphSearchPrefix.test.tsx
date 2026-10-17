import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { render } from './helpers.js';
import { graphReader, noGraphUser } from './graphTestUsers.js';
import { GraphSearchPrefix } from '../../src/graph/ui/slots/GraphSearchPrefix.js';
import { graphSearchRequests } from './searchRequests.js';

/**
 * The search-prefix slot is wired unconditionally by a host, so it gates
 * itself: nothing renders, and nothing is asked of the API, unless connected
 * knowledge is on AND the viewer can read the graph.
 */

describe('GraphSearchPrefix', () => {
  it('shows the entity hits for a viewer with graph:read on a deployment with connected knowledge', async () => {
    const requests = graphSearchRequests();
    render(<GraphSearchPrefix query="acme" />, { wrapperOptions: { user: graphReader } });

    expect(await screen.findByRole('heading', { name: 'People & organizations' })).toBeInTheDocument();
    expect(requests()).toHaveLength(1);
  });

  it('renders nothing and asks nothing while connected knowledge is off', async () => {
    const requests = graphSearchRequests();
    const { container } = render(<GraphSearchPrefix query="acme" />, {
      wrapperOptions: { user: graphReader },
      hostOptions: { features: { graphEnabled: false } },
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(requests()).toHaveLength(0);
  });

  it('renders nothing and asks nothing while the host has not said whether it is on', async () => {
    const requests = graphSearchRequests();
    const { container } = render(<GraphSearchPrefix query="acme" />, {
      wrapperOptions: { user: graphReader },
      hostOptions: { features: { graphEnabled: undefined } },
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(requests()).toHaveLength(0);
  });

  it('renders nothing and asks nothing without graph:read', async () => {
    const requests = graphSearchRequests();
    const { container } = render(<GraphSearchPrefix query="acme" />, {
      wrapperOptions: { user: noGraphUser },
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(requests()).toHaveLength(0);
  });
});
