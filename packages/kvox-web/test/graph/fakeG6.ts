/**
 * A stand-in for `@antv/g6`'s `Graph` (#775). jsdom has no canvas, so the canvas tests replace the module
 * with this class (`vi.mock('@antv/g6', () => ({ Graph: FakeGraph }))`) and drive it: emit the events G6
 * would emit, read the data, states, layout and plugins the canvas set, and check the camera calls.
 *
 * The camera is a plain affine map: viewport = canvas * zoom + position.
 *
 * Like G6, the instance has NO VIEWPORT until its first `draw()`/`render()` finishes and loses it on
 * `destroy()`: the camera methods then throw `Cannot read properties of undefined (reading 'getZoom')`.
 */

type Listener = (event: Record<string, unknown>) => void;
type Datum = { id: string; style?: Record<string, unknown>; data?: Record<string, unknown>; [key: string]: unknown };

export class FakeGraph {
  static instances: FakeGraph[] = [];

  static reset(): void {
    FakeGraph.instances = [];
  }

  static last(): FakeGraph {
    const graph = FakeGraph.instances.at(-1);
    if (!graph) throw new Error('No G6 graph was created');
    return graph;
  }

  options: Record<string, unknown>;
  listeners = new Map<string, Set<Listener>>();
  nodes: Datum[] = [];
  edges: Datum[] = [];
  states: Record<string, string[]> = {};
  layoutOptions: Record<string, unknown> | null = null;
  plugins: Array<Record<string, unknown>> = [];
  nodeOptions: Record<string, unknown> | null = null;
  edgeOptions: Record<string, unknown> | null = null;
  calls: string[] = [];
  zoom = 1;
  position: [number, number] = [0, 0];
  size: [number, number];
  destroyed = false;
  /** Whether G6 would have a viewport (drawn once, not destroyed). */
  viewport = false;
  /** Where `render()` moves a node that is free to move (no `fx`): `null` leaves it where it is. */
  layoutTo: ((datum: Datum) => [number, number]) | null = (datum) => [
    Number(datum.style?.x ?? 0) + 100,
    Number(datum.style?.y ?? 0) + 50,
  ];

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.size = [Number(options.width ?? 800), Number(options.height ?? 600)];
    FakeGraph.instances.push(this);
  }

  // --- events ---------------------------------------------------------------
  on(name: string, listener: Listener): this {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
    return this;
  }

  emit(name: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  /** Emits a node or edge event as G6 does: `target.id` and `targetType`. */
  emitElement(name: string, id: string, extra: Record<string, unknown> = {}): void {
    const [type] = name.split(':');
    this.emit(name, { target: { id }, targetType: type, ...extra });
  }

  // --- data -----------------------------------------------------------------
  setData(data: { nodes?: Datum[]; edges?: Datum[] }): void {
    this.calls.push('setData');
    this.nodes = (data.nodes ?? []).map((node) => ({ ...node, style: { ...node.style } }));
    this.edges = (data.edges ?? []).map((edge) => ({ ...edge, style: { ...edge.style } }));
    this.states = {};
  }

  getNodeData(): Datum[] {
    return this.nodes;
  }

  getEdgeData(): Datum[] {
    return this.edges;
  }

  hasNode(id: string): boolean {
    return this.nodes.some((node) => node.id === id);
  }

  hasEdge(id: string): boolean {
    return this.edges.some((edge) => edge.id === id);
  }

  updateNodeData(patch: Datum[]): void {
    for (const change of patch) {
      const node = this.nodes.find((candidate) => candidate.id === change.id);
      if (node) node.style = { ...node.style, ...change.style };
    }
  }

  updateEdgeData(patch: Datum[]): void {
    for (const change of patch) {
      const edge = this.edges.find((candidate) => candidate.id === change.id);
      if (edge) edge.style = { ...edge.style, ...change.style };
    }
  }

  node(id: string): Datum {
    const node = this.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`No node ${id}`);
    return node;
  }

  setLayout(options: Record<string, unknown>): void {
    this.layoutOptions = options;
  }

  async render(): Promise<void> {
    this.calls.push('render');
    if (this.layoutTo) {
      for (const node of this.nodes) {
        if (typeof node.fx === 'number' && typeof node.fy === 'number') continue;
        const [x, y] = this.layoutTo(node);
        node.style = { ...node.style, x, y };
      }
    }
    this.viewport = true;
    this.emit('afterlayout');
    this.emit('afterdraw');
  }

  async draw(): Promise<void> {
    this.calls.push('draw');
    this.viewport = true;
    this.emit('afterdraw');
  }

  setNode(options: Record<string, unknown>): void {
    this.nodeOptions = options;
  }

  setEdge(options: Record<string, unknown>): void {
    this.edgeOptions = options;
  }

  setOptions(options: Record<string, unknown>): void {
    Object.assign(this.options, options);
  }

  setPlugins(plugins: Array<Record<string, unknown>>): void {
    this.plugins = plugins;
  }

  async setElementState(states: Record<string, string[]>): Promise<void> {
    Object.assign(this.states, states);
  }

  getElementPosition(id: string): [number, number] {
    const style = this.node(id).style ?? {};
    return [Number(style.x ?? 0), Number(style.y ?? 0)];
  }

  getElementRenderBounds(id: string): { min: [number, number]; max: [number, number] } {
    const [x, y] = this.getElementPosition(id);
    const size = Number(this.node(id).data?.diameter ?? 20) / 2;
    return { min: [x - size, y - size], max: [x + size, y + size] };
  }

  // --- camera ---------------------------------------------------------------
  getSize(): [number, number] {
    return this.size;
  }

  resize(width: number, height: number): void {
    this.requireViewport();
    this.calls.push(`resize:${width}x${height}`);
    this.size = [width, height];
  }

  private requireViewport(): void {
    if (!this.viewport) throw new TypeError("Cannot read properties of undefined (reading 'getZoom')");
  }

  getZoom(): number {
    this.requireViewport();
    return this.zoom;
  }

  private transformed(): void {
    this.emit('aftertransform');
  }

  async zoomTo(zoom: number): Promise<void> {
    const [min, max] = (this.options.zoomRange as [number, number] | undefined) ?? [0.01, 100];
    const next = Math.min(max, Math.max(min, zoom));
    // Zoom about the viewport centre, as G6 does by default.
    const [cx, cy] = this.getViewportCenter();
    const [gx, gy] = this.getCanvasByViewport([cx, cy]);
    this.zoom = next;
    this.position = [cx - gx * next, cy - gy * next];
    this.calls.push(`zoomTo:${next}`);
    this.transformed();
  }

  async zoomBy(ratio: number): Promise<void> {
    await this.zoomTo(this.zoom * ratio);
  }

  async translateBy([dx, dy]: [number, number]): Promise<void> {
    this.position = [this.position[0] + dx, this.position[1] + dy];
    this.calls.push(`translateBy:${Math.round(dx)},${Math.round(dy)}`);
    this.transformed();
  }

  async focusElement(ids: string | string[]): Promise<void> {
    const list = Array.isArray(ids) ? ids : [ids];
    const points = list.map((id) => this.getElementPosition(id));
    const x = (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2;
    const y = (Math.min(...points.map((p) => p[1])) + Math.max(...points.map((p) => p[1]))) / 2;
    const [vx, vy] = this.getViewportByCanvas([x, y]);
    const [cx, cy] = this.getViewportCenter();
    this.calls.push(`focus:${list.join(',')}`);
    await this.translateBy([cx - vx, cy - vy]);
  }

  getViewportCenter(): [number, number] {
    return [this.size[0] / 2, this.size[1] / 2];
  }

  getViewportByCanvas([x, y]: readonly number[]): [number, number] {
    this.requireViewport();
    return [x! * this.zoom + this.position[0], y! * this.zoom + this.position[1]];
  }

  getCanvasByViewport([x, y]: readonly number[]): [number, number] {
    this.requireViewport();
    return [(x! - this.position[0]) / this.zoom, (y! - this.position[1]) / this.zoom];
  }

  destroy(): void {
    this.destroyed = true;
    this.viewport = false;
    this.calls.push('destroy');
  }
}

/** A `ResizeObserver` jsdom lacks; `trigger()` calls every observer, like a resize would. */
export class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>();
  callback: () => void;
  targets = new Set<Element>();

  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.all.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    FakeResizeObserver.all.delete(this);
  }

  static trigger(): void {
    for (const observer of FakeResizeObserver.all) observer.callback();
  }
}
