# ask

The pure half of the Ask evaluation: the question schema and loader, the scorer and the report.

## Purpose and scope

`askEvalQuestionSchema` (and `parseAskEvalQuestions`, `loadAskEvalQuestions`, `selectAskEvalQuestions`) is the contract of `ask-questions.json`; `scoreAnswer` and its parts score one answered turn (the citation-validity and sensitive-leak gates included); `buildAskEvalReport`, `formatAskEvalReport` and `formatAnswersMarkdown` roll a run up. No Nest, no Prisma, no provider: the run that produces the answers (seeding the gold graph, the real `ask.respond` handler) is the [ask-run](../ask-run/README.md) slice (`kvox-eval ask`, headless), and the web app's replay spec (`apps/api/test/ask/ask-eval.replay.db.spec.ts`) scores with these same functions.

Status: issue #580 (from `apps/api/scripts/ask-eval/`; #382 before it). The run itself is headless since #608.

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice).

## Peer dependencies

`zod` and `@marinoscar/kvox-contract` (`/ask`: `AskCitation`, `AskMessageResponse`, as types).

## Configuration

None.

## Extension-point catalog

None.
