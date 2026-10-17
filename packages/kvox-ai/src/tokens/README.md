# tokens

The local token estimate every budget is checked against.

## Purpose and scope

`countTokens` and `CHARS_PER_TOKEN`: the larger of characters / 4 and the word count, rounded up, because a count that is too low lets an over-budget prompt reach the vendor after the user has paid for it. No network, no model lookup.

Status: moved from `apps/api/src/ai-port/count-tokens.ts` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

None.

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure; usable offline.
