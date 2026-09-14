/**
 * Read the app-wide upload manager — issue #22, epic #19.
 *
 * Lives in `hooks/` rather than next to the provider so a consumer imports one
 * thing (`useUploadManager`) and cannot accidentally reach for the raw
 * context, and so a test can `vi.mock('../hooks/useUploadManager')` to render
 * issue #30's and #32's screens without standing up a real engine.
 *
 * THROWS when no provider is mounted, deliberately — matching `useAuth` and
 * `useThemeContext` rather than `useNotifications`' tolerant `null`. A screen
 * that renders upload controls outside the authenticated shell is a routing
 * mistake, and silently returning "no uploads" would present a working-looking
 * Upload button that does nothing.
 */

import { useContext } from 'react';
import {
  UploadManagerContext,
  type UploadManagerContextValue,
} from '../contexts/UploadManagerContext';

export function useUploadManager(): UploadManagerContextValue {
  const context = useContext(UploadManagerContext);
  if (!context) {
    throw new Error('useUploadManager must be used within an UploadManagerProvider');
  }
  return context;
}

export type {
  ManagedUpload,
  StartUploadInput,
  UploadManagerContextValue,
} from '../contexts/UploadManagerContext';
