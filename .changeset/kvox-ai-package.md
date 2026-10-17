---
"@marinoscar/kvox-ai": minor
---

New package `@marinoscar/kvox-ai`: the host-neutral model mechanics of KVox (#579). The pure files of the web app's AI port move in unchanged (strict JSON-schema checks, the chat and tool-call mapping, the task vocabulary and `chooseTaskModel`, the local token estimate, the embedding catalog, the call and event types), and the interfaces a host supplies are declared (`KvoxAiRuntime`, `KvoxTaskModelSource`, `KvoxModelCatalog`). `createKvoxAi`, the direct runtime and the `./testing` entry follow in the next release.
