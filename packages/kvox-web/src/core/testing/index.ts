// Test helpers for the web slices: an in-memory host, a render helper that wraps
// the host provider, theme and router, a query-aware matchMedia, a fake
// XMLHttpRequest and the conformance suites. Import from test code only.

export { describeKvoxWebConformance, scanKvoxWebSources } from './conformance.js';
export type { KvoxWebConformanceHarness, KvoxWebConformanceOptions, KvoxWebExpectation } from './conformance.js';
export { createFakeXhrFactory, flush } from './fake-xhr.js';
export type { FakeXhrController, FakeXhrRequest } from './fake-xhr.js';
export { createFakeKvoxWebHost, fakeApiError } from './fake-host.js';
export type {
  FakeBlobAnswer,
  FakeHostCall,
  FakeKvoxWebHost,
  FakeKvoxWebHostOptions,
  FakeMetaAnswer,
  FakeRoute,
  FakeRouteRequest,
  FakeSseContext,
  FakeSsePostScript,
  FakeSseScript,
  FakeUploadedPart,
  FakeViewerInit,
} from './fake-host.js';
export { renderWithKvoxHost } from './render.js';
export type { RenderWithKvoxHostOptions } from './render.js';
export { installMatchMedia, resetViewportWidth, setViewportWidth } from './viewport.js';
