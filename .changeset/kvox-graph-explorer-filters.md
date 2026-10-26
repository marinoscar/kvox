---
"@marinoscar/kvox-web": patch
"@marinoscar/kvox-api": patch
"@marinoscar/kvox-contract": patch
---

Graph explorer type filter selects what shows (#764). The type and domain chips now work like the `/graph` index's chips: with none selected every type shows, and selecting "Products" shows only Products. Seeds are filtered too; a filtered seed still anchors the next request. A filter that leaves the canvas empty shows "No Products in your graph yet" (or "Nothing matches these filters") with a Clear filters button, and an empty `types` list is never sent to the API. `?types=` still lists the shown types (absent means all). The legend is display-only in the explorer. `GraphLegend`'s `onToggleType` is now optional. `useLegendTypeFilter` returns `selectedTypes`. New headless helpers: `selectedTypesFromParam`, `typesParamFromSelected` and `hiddenFromSelected`.

API: the explore and neighbourhood type filter no longer exempts seeds, and an explicitly empty `types` array matches nothing (absent or blank still means every type).
