---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
'@marinoscar/kvox-db': minor
'@marinoscar/kvox-web': minor
---

The graph now knows who the account owner is (#778). A new per-user graph preference, `self.entityId` (none by default), names the Person that is you; Settings, Knowledge graph has a "You in the graph" control to pick an existing Person, accept a suggestion that matches your profile name, or add a Person by hand. Nothing is ever chosen for you. When it is set, extraction tells the model those names are the note's owner and offers the Person as a known entity, a mention of the owner's name or an alias links to it at or above the auto-link threshold, and the graph explorer draws the node as "You" with its own ring and always labels it. The read APIs mark it with `isSelf`. A graph without a chosen Person is unchanged, and so is the extraction prompt.
