/**
 * `@marinoscar/kvox-eval/fixtures`: the synthetic golden set and its contract.
 *
 * @remarks
 * The committed meetings (`fixtures/kg-golden/meetings/`) and the Ask question
 * file beside them, the schema every fixture is validated with, and the loaders.
 * Every meeting is invented: no real recording, transcript, note, name, company,
 * email address or phone number belongs in the set (`fixtures/kg-golden/README.md`).
 *
 * @packageDocumentation
 */
export {
  evidenceLabelSchema,
  goldenEntityLabelSchema,
  goldenFixtureSchema,
  goldenItemLabelSchema,
  goldenRelationLabelSchema,
  isoDateSchema,
  ITEM_LABEL_KINDS,
  itemAddress,
  itemsByAddress,
  validPrecisionSchema,
} from './fixture-schema.js';
export type {
  EvidenceLabel,
  GoldenEntityLabel,
  GoldenFixture,
  GoldenFixtureInput,
  GoldenItemLabel,
  GoldenRelationLabel,
  ItemLabelKind,
  ValidPrecisionLabel,
} from './fixture-schema.js';
export { fixtureDomains, PERSONAL_FIXTURE_TAG } from './domains.js';
export {
  GOLDEN_MEETINGS_DIR,
  GOLDEN_SET_DIR,
  KgEvalLoadError,
  listFixtureFiles,
  loadFixtureFile,
  loadGoldenMeetings,
  loadGoldenSet,
  selectFixtures,
} from './load.js';
export { ASK_QUESTIONS_PATH, loadGoldenAskQuestions } from './questions.js';
