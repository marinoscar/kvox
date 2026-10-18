# fixtures

The synthetic golden set and its contract: `goldenFixtureSchema` and its types, the loaders, the domains a fixture is read against, and where the committed files are.

## Purpose and scope

`GOLDEN_SET_DIR`, `GOLDEN_MEETINGS_DIR` and `ASK_QUESTIONS_PATH` resolve against the package root, so they work from `dist/` and from `src/` under ts-jest. `loadGoldenMeetings(ids?)`, `loadGoldenSet(dir?)`, `loadFixtureFile`, `listFixtureFiles` and `selectFixtures` load and narrow the set; a malformed file throws `KgEvalLoadError` naming it. `fixtureDomains` gives `core ∪ work`, plus `personal` for a fixture tagged `personal` (#383). `loadGoldenAskQuestions` parses the committed Ask question file with the `ask` slice's schema.

Status: issue #580 (from `apps/api/scripts/kg-eval/` and `apps/api/test/fixtures/kg-golden/`). The data's own rules: [fixtures/kg-golden/README.md](../../fixtures/kg-golden/README.md).

## Entry point

`@marinoscar/kvox-eval/fixtures`.

## Peer dependencies

`zod` (the schema) and `@marinoscar/kvox-contract` (`DomainKey`). It imports the `ask` slice (the question schema).

## Configuration

None.

## Extension-point catalog

None.
