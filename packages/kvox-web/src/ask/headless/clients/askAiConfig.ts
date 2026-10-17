/**
 * `GET /api/ai-tasks/config`, narrowed to what Ask reads: the tool-capable
 * models it may offer, the `graph.agent` default, whether the viewer has a key
 * and whether connected knowledge is on.
 *
 * `keyConfigured` describes the viewer (they saved a provider key), `available`
 * the deployment (AI is on and a model is permitted); they are independent on
 * purpose, so a surface can say "your administrator has not turned this on" and
 * "you have not added a key" as the two different sentences they are.
 */

import { kvoxGet } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

/**
 * One enabled model, as Ask offers it.
 *
 * @stability experimental
 */
export interface AskAiModel {
  /** The provider's own model id, for example `gpt-5.4`. */
  id: string;
  /** What a person reads in the picker. */
  label: string;
  /** Whether the model can call tools; Ask only offers models that can. */
  toolCalling?: boolean;
}

/**
 * The viewer's AI availability, as Ask needs it.
 *
 * @stability experimental
 */
export interface AskAiConfig {
  /** The deployment permits AI at all. */
  available?: boolean;
  /** The viewer has saved a provider key. */
  keyConfigured: boolean;
  /**
   * The deployment switch for connected knowledge. `undefined` means an older
   * server that does not say: unknown, never off. Only an explicit `false`
   * turns the page off.
   */
  graphEnabled?: boolean;
  /** The enabled models, ordered by id. */
  models: AskAiModel[];
  /** The model to offer first, or `null`. */
  defaultModel: string | null;
  /** What each connected-knowledge task would run on for the viewer, keyed by task (`graph.agent`, ...). */
  taskModels?: Record<string, {
    /** The model the task runs on, or `null` when none is available. */
    model: string | null;
  }>;
}

/**
 * Reads the viewer's AI availability. Requires `notes:read`, which every seeded role holds.
 *
 * @param host - The host.
 * @param signal - Aborts the request.
 * @returns The configuration.
 *
 * @stability experimental
 */
export function getAskAiConfig(host: KvoxWebHost, signal?: AbortSignal): Promise<AskAiConfig> {
  return kvoxGet<AskAiConfig>(host, '/ai-tasks/config', { signal });
}
