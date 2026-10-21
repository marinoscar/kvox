---
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-web': patch
---

New `@marinoscar/kvox-contract/brand` entry point: `KVOX_IDENTITY`, `BRAND_TOKENS`, the `MARK_*` logo geometry and `brandMarkSvg()`, moved out of `@marinoscar/kvox-web/brand` (which re-exports them, so its imports do not change). `@marinoscar/kvox-api` core gains `KVOX_DOCUMENT_THEME`, `mixHex`, `docxColor`, `brandMarkPng`, `brandMarkSvgBuffer` and the vector `drawBrandMark` for on-brand PDF and Word exports.
