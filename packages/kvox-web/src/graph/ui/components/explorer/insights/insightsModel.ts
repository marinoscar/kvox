/**
 * The pure half of the Insights panel (GIC-16, #677; epic #661): which sections
 * exist, what each says when empty, which canvas seeds a tap on an item builds,
 * and what the panel says about a stale or pending snapshot. No React, no
 * network: `insightsModel.test.ts` pins it.
 */

import type {
  GraphInsightConnector,
  GraphInsightFadingTie,
  GraphInsightRisk,
  GraphInsightTheme,
  GraphInsights,
  GraphInsightsWindow,
} from '../../../../headless/clients/graph.js';

/**
 * The sections of the panel, in order.
 *
 * @stability experimental
 */
export const INSIGHT_SECTIONS = ['themes', 'connectors', 'rising', 'fadingTies', 'openRisks'] as const;

/**
 * One of {@link INSIGHT_SECTIONS}.
 *
 * @stability experimental
 */
export type InsightSectionKey = (typeof INSIGHT_SECTIONS)[number];

/** Section headings. */
export const INSIGHT_SECTION_TITLES: Record<InsightSectionKey, string> = {
  themes: 'Themes',
  connectors: 'Connectors',
  rising: 'Rising',
  fadingTies: 'Fading ties',
  openRisks: 'Open risks',
};

/** One line under a heading, saying what the section is. */
export const INSIGHT_SECTION_HINTS: Record<InsightSectionKey, string> = {
  themes: 'The groups your notes keep coming back to.',
  connectors: 'People and things that link otherwise separate groups.',
  rising: 'Coming up more often than before.',
  fadingTies: 'Relationships that have gone quiet.',
  openRisks: 'Risks raised and not yet closed.',
};

/** What a section says when it has nothing to show. */
export const INSIGHT_EMPTY_TEXT: Record<InsightSectionKey, string> = {
  themes: 'Themes appear once your graph has grown enough to be laid out.',
  connectors: 'No one stands out as a connector yet.',
  rising: 'Nothing is coming up noticeably more often.',
  fadingTies: 'No relationship has gone quiet.',
  openRisks: 'No open risks.',
};

/** Shown while a connectors-less (older) snapshot is all there is. */
export const CONNECTORS_REFRESH_TEXT = 'Connectors appear after the overview is next refreshed.';
/** Shown when the layout snapshot lags the graph. */
export const INSIGHTS_STALE_TEXT = 'Your graph has changed since the themes and connectors were worked out.';
/** Shown while a layout is being computed. */
export const INSIGHTS_PENDING_TEXT = 'Updating themes and connectors…';
/** Shown when the graph is too large for a layout. */
export const INSIGHTS_TOO_LARGE_TEXT = 'Your graph is too large for themes and connectors.';
/** Shown while no snapshot exists. */
export const INSIGHTS_NONE_TEXT = 'Themes and connectors appear once your map is built.';

/**
 * The windows offered, with their button labels.
 *
 * @stability experimental
 */
export const INSIGHT_WINDOWS: ReadonlyArray<{ key: GraphInsightsWindow; label: string }> = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: '365d', label: 'A year' },
];

/** The most entities one tap puts on the canvas. */
export const INSIGHT_SEED_MAX = 10;

/** Most members of each bridged cluster a connector tap adds beside the connector itself. */
export const CONNECTOR_MEMBERS_PER_CLUSTER = 3;

/**
 * What a tap on an Insights item puts on the canvas.
 *
 * @stability experimental
 */
export interface InsightSeeds {
  /** The entities to start from. */
  seedIds: string[];
  /** The one to select and fly to once it is drawn. */
  focusId: string | null;
  /** Entities to ring (the clusters a connector joins). */
  markIds: string[];
}

/** A theme: its sample members. */
export function themeSeeds(theme: GraphInsightTheme): InsightSeeds {
  const seedIds = theme.memberSample.map((m) => m.id).slice(0, INSIGHT_SEED_MAX);
  return { seedIds, focusId: theme.labelEntityId && seedIds.includes(theme.labelEntityId) ? theme.labelEntityId : null, markIds: [] };
}

/**
 * A connector: the node itself plus the top members of every cluster it joins, so the canvas
 * shows both groups with the connector between them. The members are ringed.
 */
export function connectorSeeds(connector: GraphInsightConnector, themes: readonly GraphInsightTheme[]): InsightSeeds {
  const members: string[] = [];
  for (const group of connector.clusters) {
    const theme = themes.find((t) => t.clusterId === group.id);
    for (const m of (theme?.memberSample ?? []).slice(0, CONNECTOR_MEMBERS_PER_CLUSTER)) {
      if (m.id !== connector.entity.id && !members.includes(m.id)) members.push(m.id);
    }
  }
  const markIds = members.slice(0, INSIGHT_SEED_MAX - 1);
  return { seedIds: [connector.entity.id, ...markIds], focusId: connector.entity.id, markIds };
}

/** A fading tie: both ends, focused on the first. */
export function tieSeeds(tie: GraphInsightFadingTie): InsightSeeds {
  return { seedIds: [tie.from.id, tie.to.id], focusId: tie.from.id, markIds: [] };
}

/** A risk: the risk item itself (the inspector opens on it). */
export function riskSeeds(risk: GraphInsightRisk): InsightSeeds {
  return { seedIds: [risk.id], focusId: risk.id, markIds: [] };
}

/** One entity. */
export function entitySeeds(id: string): InsightSeeds {
  return { seedIds: [id], focusId: id, markIds: [] };
}

/** The sentence about the snapshot, or `null` when there is nothing to say. */
export function snapshotNotice(insights: GraphInsights | null): string | null {
  if (!insights) return null;
  if (insights.pending) return INSIGHTS_PENDING_TEXT;
  if (insights.tooLarge) return INSIGHTS_TOO_LARGE_TEXT;
  if (insights.status === 'none') return INSIGHTS_NONE_TEXT;
  if (insights.stale) return INSIGHTS_STALE_TEXT;
  return null;
}

/** The empty text of a section, aware of why connectors may be missing. */
export function emptyText(key: InsightSectionKey, insights: GraphInsights | null): string {
  if (key === 'connectors' && insights && insights.status === 'ready' && !insights.connectorsReady) {
    return CONNECTORS_REFRESH_TEXT;
  }
  return INSIGHT_EMPTY_TEXT[key];
}

/** How many items a section holds. */
export function sectionCount(key: InsightSectionKey, insights: GraphInsights | null): number {
  return insights ? insights[key].length : 0;
}

/** The risk's line: its title, else its statement. */
export function riskLine(risk: GraphInsightRisk): string {
  return risk.title ?? risk.statement;
}
