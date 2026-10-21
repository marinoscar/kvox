---
'@marinoscar/kvox-api': minor
---

Note PDF and Word exports are redesigned. Both now share one style module and open with a masthead (logo, product name, export date), a kicker, the title and a provenance card; headings take the brand colour, tables repeat their header row on every page, task lists show checkboxes, and quotes and code get their own panels, under a running header and a "Page x of y" footer. The export parser now reads GFM tables, task lists, autolinks, hard breaks and setext headings, drops HTML comments, and renders images as links (nothing is fetched). Word exports use real styles, and ordered lists restart per list and honour their start number instead of continuing the previous list.
