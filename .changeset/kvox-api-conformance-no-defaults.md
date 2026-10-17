---
"@marinoscar/kvox-api": patch
---

The ports conformance kit gains an opt-in `noDefaults` settings fixture (`KvoxNoDefaultsSettingsFixture`): a user namespace registered with `defaults: undefined` must read `undefined` before any write, without running its schema, and the parsed value after `patchUser`.
