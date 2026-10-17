// The Ask golden question file (issue #382), shipped beside the meetings it is
// asked about. The schema and the parser are the `ask` slice's; this is only
// where the committed file is.

import { join } from 'path';

import { loadAskEvalQuestions, type AskEvalQuestion } from '../ask/index.js';
import { GOLDEN_SET_DIR } from './load.js';

/**
 * The committed Ask question file (`fixtures/kg-golden/ask-questions.json`).
 *
 * @stability experimental
 */
export const ASK_QUESTIONS_PATH = join(GOLDEN_SET_DIR, 'ask-questions.json');

/**
 * The committed Ask questions, parsed and validated.
 *
 * @returns every question, in file order.
 * @throws `AskEvalQuestionLoadError` when the file is not valid JSON or does not match the schema.
 * @stability experimental
 */
export function loadGoldenAskQuestions(): AskEvalQuestion[] {
  return loadAskEvalQuestions(ASK_QUESTIONS_PATH);
}
