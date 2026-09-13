// =============================================================================
// The screens the TUI can show  (issue #145, epic #110)
// =============================================================================
//
// A one-type module, and it exists so `app.tsx` and `screens/menu.tsx` can name
// the same routes without importing each other. The menu needs the route names
// to build its list; the app needs them to switch on. A direct import either
// way is a cycle, and a cycle across a `.tsx` boundary under NodeNext ESM is
// the kind that resolves at type-check time and then produces a `undefined`
// component at run time.
//
// There is deliberately no history stack. Every screen returns to the menu and
// nowhere else, so "back" has exactly one meaning on every screen — which is
// what lets Esc be bound to it globally without a user ever having to work out
// where they will land.
// =============================================================================

export type Route = 'menu' | 'login' | 'invoke' | 'status' | 'node' | 'deploy' | 'logout';
