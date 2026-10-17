import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { KvoxWebHostProvider } from '../headless/host.js';
import type { KvoxWebHost } from '../headless/host.js';

/**
 * Options of {@link renderWithKvoxHost}.
 *
 * @stability experimental
 */
export interface RenderWithKvoxHostOptions extends Omit<RenderOptions, 'wrapper'> {
  /** The MUI theme. Default: `createTheme()`. Pass the app's theme to test its tokens. */
  theme?: Theme;
  /** The first location of the `MemoryRouter`. Default `/`. */
  route?: string;
  /** A wrapper placed INSIDE the host provider and the router (an extra provider). */
  wrapper?: (props: { children: ReactNode }) => ReactElement;
}

/**
 * Renders `ui` the way a slice sees it in a host: inside `KvoxWebHostProvider`,
 * an MUI theme and a `MemoryRouter`.
 *
 * @param ui - The element under test.
 * @param host - The host, usually `createFakeKvoxWebHost()`.
 * @param options - Theme, first route, an inner wrapper and Testing Library options.
 * @returns Testing Library's render result.
 *
 * @stability experimental
 */
export function renderWithKvoxHost(
  ui: ReactElement,
  host: KvoxWebHost,
  options: RenderWithKvoxHostOptions = {},
): RenderResult {
  const { theme, route = '/', wrapper: Inner, ...renderOptions } = options;
  const muiTheme = theme ?? createTheme();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <KvoxWebHostProvider host={host}>
      <ThemeProvider theme={muiTheme}>
        <MemoryRouter initialEntries={[route]}>
          {Inner ? <Inner>{children}</Inner> : children}
        </MemoryRouter>
      </ThemeProvider>
    </KvoxWebHostProvider>
  );
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
