// The ask slice's public surface (re-exported by the package root): the PURE
// half of the Ask evaluation. The run itself (seeding a graph, the real
// `ask.respond` handler) needs the web app's database and stays there.
export {
  ASK_EVAL_CATEGORIES,
  AskEvalQuestionLoadError,
  askEvalExpectedSchema,
  askEvalQuestionFileSchema,
  askEvalQuestionSchema,
  loadAskEvalQuestions,
  parseAskEvalQuestions,
  selectAskEvalQuestions,
} from './question-schema.js';
export type { AskEvalCategory, AskEvalExpected, AskEvalQuestion } from './question-schema.js';
export { askEvalReportSchema, buildAskEvalReport, formatAnswersMarkdown, formatAskEvalReport } from './report.js';
export type { AskEvalReport } from './report.js';
export {
  scoreAnswer,
  scoreAnswerMatch,
  scoreCitationValidity,
  scoreCited,
  scoreCiteFromHit,
  scoreEntityRecall,
  scoreSensitiveLeak,
} from './scorer.js';
export type { AskEvalScore, EvidenceSourceMap } from './scorer.js';
