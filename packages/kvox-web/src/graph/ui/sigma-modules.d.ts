// Type declarations for `@react-sigma/core`, which `GraphCanvas.tsx` is the one
// file to import.
//
// WHY THIS FILE EXISTS. The library ships `lib/index.d.ts` with extensionless
// relative re-exports (`export * from './hooks/context'`). Under this
// package's `NodeNext` resolution those re-exports do not resolve, so every
// named import from `@react-sigma/core` fails to type-check even though the
// module loads fine at run time. An ambient declaration is looked up before
// the file system, so the members the canvas uses are declared here, with the
// library's own signatures.

declare module '@react-sigma/core' {
  import type { CSSProperties, ReactElement, ReactNode, RefAttributes } from 'react';
  import type Sigma from 'sigma';
  import type { Settings } from 'sigma/settings';
  import type { CameraEvents, MouseCaptorEvents, SigmaEvents, TouchCaptorEvents } from 'sigma/types';
  import type { AnimateOptions } from 'sigma/utils';
  import type { MultiDirectedGraph, UndirectedGraph } from 'graphology';

  /** Properties of {@link SigmaContainer}. */
  export interface SigmaContainerProps {
    graph?: MultiDirectedGraph | UndirectedGraph;
    settings?: Partial<Settings>;
    id?: string;
    className?: string;
    style?: CSSProperties;
  }

  /** Creates the Sigma instance and provides it to its children. */
  export const SigmaContainer: (
    props: SigmaContainerProps & { children?: ReactNode } & RefAttributes<Sigma | null>,
  ) => ReactElement;

  /** The Sigma instance of the surrounding container. */
  export function useSigma(): Sigma;
  /** Updates Sigma's settings. */
  export function useSetSettings(): (newSettings: Partial<Settings>) => void;
  /** Registers Sigma event handlers for the life of the component. */
  export function useRegisterEvents(): (
    eventHandlers: Partial<SigmaEvents & TouchCaptorEvents & MouseCaptorEvents & CameraEvents>,
  ) => void;
  /** Camera controls. */
  export function useCamera(options?: Partial<AnimateOptions> & { factor?: number }): {
    zoomIn: (options?: Partial<AnimateOptions> & { factor?: number }) => void;
    zoomOut: (options?: Partial<AnimateOptions> & { factor?: number }) => void;
    reset: (options?: Partial<AnimateOptions>) => void;
  };
}

declare module '@react-sigma/core/lib/style.css';
