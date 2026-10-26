---
'@marinoscar/kvox-ai': patch
'@marinoscar/kvox-api': patch
'@marinoscar/kvox-eval': patch
'@marinoscar/kvox-web': patch
---

Dependency and peer ranges on the platform packages move from 0.1.0-next.14 to 0.1.0-next.16, the releases whose CLI engine picks free host ports for each app on a shared server and lets an app choose the manifests the deploy version step writes (`deploy.versionedManifests`). No code in these packages changes.
