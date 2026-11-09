import type { AiInputItem } from '@marinoscar/platform-ai-providers';

import type { KvoxChatMessage, KvoxToolChoice, KvoxToolDefinition } from '../types/index.js';
import { toolParametersSchema } from './chat-mapping.js';

/**
 * One thing wrong with a prompted tool reply. The same shape as the structured slice's issue,
 * declared here so `chat` does not import `structured` (slice boundary).
 */
export interface PromptedToolIssue {
  /** The path of the offending value inside the reply; empty for the whole reply. */
  path: Array<string | number>;
  /** The validator's code (`invalid_json` when the reply is not JSON at all). */
  code: string;
  /** What is wrong, in the validator's words. */
  message: string;
}

// =============================================================================
// Prompted tool calling: the tools in the prompt, one repair (issue #654)
// =============================================================================
//
// An OpenAI-compatible server that does not implement tool calls (a local model
// behind a gateway) cannot be handed `tools`. For a model whose `toolCallingMode`
// is `prompted`, `createKvoxAi.chat` drives the SAME Ask loop without them. Each
// step is ONE plain call:
//
//   1. REQUEST. The system prompt is the loop's own, then ONE generic block that
//      lists the tools (name, description, JSON Schema of the arguments) and asks
//      for a single JSON value: the tool calls to make, or the final answer. The
//      request carries NO `tools`, and NO `structuredOutput`.
//   2. HISTORY AS TEXT. A server without tool calls cannot take `function_call`
//      items, so the transcript is replayed as plain messages: an assistant turn
//      is the JSON it would have said, the results of a step's tool calls are one
//      user message.
//   3. PARSE AND VALIDATE. Trim, strip one surrounding code fence, `JSON.parse`,
//      then check the shape, that every tool named is one the step may call, and
//      every call's arguments against that tool's JSON Schema.
//   4. ONE REPAIR. A reply that does not validate is answered with ONE more
//      call: the same request plus the bad reply and its problems. Then it fails.
//   5. MAPPED BACK. A tool-call step becomes `tool_call` events, an answer one
//      `delta`, each followed by `step_end` and `done`: the events a native step
//      produces, so the Ask loop cannot tell.
//
// This file is the PURE half (text building, parsing, validation). The calls, the
// finish-reason rules and the error classes are the port's (`port/create-kvox-ai.ts`).
//
// ⚠ A PROMPTED STEP IS NOT STREAMED. The reply is JSON, so it is parsed whole; an
// answer arrives as one delta. (A rate limit therefore never lands after flushed text.)
// ⚠ THE BLOCK IS GENERIC. It names no KVox concept; the loop's prompt and tools
// carry all of the meaning. Changing the wording changes every prompted request.
// =============================================================================

/**
 * One tool call of a prompted step, before the port gives it an id.
 *
 * @stability experimental
 */
export interface PromptedToolCall {
  /** The tool called (one of the step's allowed tools). */
  name: string;
  /** The arguments object, validated against the tool's JSON Schema. */
  arguments: Record<string, unknown>;
}

/**
 * What a prompted step said.
 *
 * @stability experimental
 */
export type PromptedToolStep =
  | {
      /** The model wants these tools run. */
      kind: 'calls';
      /** One or more calls, in order. */
      calls: PromptedToolCall[];
    }
  | {
      /** The model answered. */
      kind: 'answer';
      /** The answer text. */
      text: string;
    };

/**
 * The outcome of {@link parsePromptedToolAnswer}.
 *
 * @stability experimental
 */
export type PromptedToolParse =
  | {
      /** The reply parsed and validated. */
      ok: true;
      /** What it said. */
      step: PromptedToolStep;
    }
  | {
      /** The reply is not usable. */
      ok: false;
      /** True when the reply is not JSON at all. */
      notJson: boolean;
      /** Why, in order. */
      issues: PromptedToolIssue[];
    };

/** The tools a step may call under a tool choice. */
function allowedTools(tools: readonly KvoxToolDefinition[], choice: KvoxToolChoice): KvoxToolDefinition[] {
  if (choice === 'none') return [];
  if (typeof choice === 'object') return tools.filter((tool) => tool.name === choice.name);
  return [...tools];
}

/** Whether a final answer is allowed (not under `required` or a named tool). */
function answerAllowed(choice: KvoxToolChoice): boolean {
  return choice === 'auto' || choice === 'none';
}

/**
 * The system prompt of a prompted tool step: the loop's own system prompt, a blank
 * line, then the generic tool block.
 *
 * @param input - the loop's system prompt, the tools, and the tool choice of the step.
 * @returns the instructions to send.
 * @stability experimental
 */
export function buildPromptedToolInstructions(input: {
  system: string;
  tools: readonly KvoxToolDefinition[];
  toolChoice: KvoxToolChoice;
}): string {
  const tools = allowedTools(input.tools, input.toolChoice);
  const callShape = '{"type":"tool_calls","calls":[{"name":"<tool name>","arguments":{<arguments>}}]}';
  const answerShape = '{"type":"answer","text":"<your answer>"}';

  const parts: string[] = [];
  if (tools.length > 0) {
    parts.push(
      'You can call tools. The tools:',
      tools
        .map((tool) => `- ${tool.name}: ${tool.description}\n  arguments (JSON Schema): ${JSON.stringify(tool.parameters)}`)
        .join('\n'),
    );
  } else {
    parts.push('No tool can be called in this reply.');
  }

  const shapes: string[] = [];
  if (tools.length > 0) {
    shapes.push(
      `To call tools, reply with ${callShape}. Several calls in one reply run together. The results come back in the next message.`,
    );
  }
  if (answerAllowed(input.toolChoice)) {
    shapes.push(`To give your final answer, reply with ${answerShape}.`);
  }
  parts.push('Reply with a single JSON value only: no prose before or after it, and no code fence.', shapes.join('\n'));

  const block = parts.join('\n\n');
  return input.system.length > 0 ? `${input.system}\n\n${block}` : block;
}

/** The text of one message as a platform input item. */
function textMessage(role: 'user' | 'assistant', text: string): AiInputItem {
  return { type: 'message', role, content: [{ type: 'text', text }] };
}

/** The reply an assistant turn would have been, as the model is shown it. */
function replayedTurn(message: Extract<KvoxChatMessage, { role: 'assistant' }>): string | null {
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return JSON.stringify({
      type: 'tool_calls',
      calls: message.toolCalls.map((call) => ({ name: call.name, arguments: safeParse(call.argumentsJson) })),
    });
  }
  return typeof message.content === 'string' && message.content.length > 0
    ? JSON.stringify({ type: 'answer', text: message.content })
    : null;
}

/**
 * A transcript as a prompted tool step sends it.
 *
 * @stability experimental
 */
export interface PromptedToolInput {
  /** The leading `system` messages, joined by a blank line; empty when there are none. */
  system: string;
  /** Every other message, in order, as plain platform messages. */
  input: AiInputItem[];
}

/**
 * The transcript as plain messages a server without tool calls can take: the
 * leading `system` messages are the instructions' business (returned as `system`),
 * an assistant turn is the JSON it would have said, and the results of one step's
 * tool calls are ONE user message. A later `system` message (the forced-answer
 * line) is a user message.
 *
 * @param messages - the whole transcript.
 * @returns the leading system text and the input items.
 * @stability experimental
 */
export function toPromptedToolInput(messages: readonly KvoxChatMessage[]): PromptedToolInput {
  let lead = 0;
  while (lead < messages.length && messages[lead].role === 'system') lead += 1;
  const system = messages
    .slice(0, lead)
    .flatMap((message) => (message.role === 'system' && message.content.length > 0 ? [message.content] : []))
    .join('\n\n');

  const names = new Map<string, string>();
  const input: AiInputItem[] = [];
  let results: string[] = [];
  const flush = (): void => {
    if (results.length > 0) input.push(textMessage('user', results.join('\n\n')));
    results = [];
  };

  for (const message of messages.slice(lead)) {
    if (message.role === 'tool') {
      results.push(
        `Result of the tool call ${message.toolCallId} (${names.get(message.toolCallId) ?? 'tool'}):\n${message.content}`,
      );
      continue;
    }
    flush();
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
      const turn = replayedTurn(message);
      if (turn !== null) input.push(textMessage('assistant', turn));
    } else {
      input.push(textMessage('user', message.content));
    }
  }
  flush();
  return { system, input };
}

/**
 * How many tool calls a transcript already holds, so the port can number new calls
 * without reusing an id.
 *
 * @param messages - the whole transcript.
 * @returns the count.
 * @stability experimental
 */
export function countToolCalls(messages: readonly KvoxChatMessage[]): number {
  let count = 0;
  for (const message of messages) if (message.role === 'assistant') count += message.toolCalls?.length ?? 0;
  return count;
}

/**
 * The id of the n-th tool call of a prompted turn (1-based): stable, and unique
 * within a transcript.
 *
 * @param n - the call's number.
 * @returns the id.
 * @stability experimental
 */
export function promptedToolCallId(n: number): string {
  return `prompted_call_${n}`;
}

/**
 * The input of the one repair request: the original input, the previous reply as
 * an assistant turn, and a user message listing the problems.
 *
 * @param input - the original input items.
 * @param answer - the previous reply, verbatim.
 * @param issues - what was wrong with it.
 * @returns the repair request's input.
 * @stability experimental
 */
export function buildPromptedToolRepairInput(
  input: readonly AiInputItem[],
  answer: string,
  issues: readonly PromptedToolIssue[],
): AiInputItem[] {
  const listed = issues.slice(0, 20).map((issue) => `- ${formatPath(issue.path)}: ${issue.message.slice(0, 200)}`);
  if (issues.length > 20) listed.push(`- ...and ${issues.length - 20} more`);
  return [
    ...input,
    textMessage('assistant', answer),
    textMessage(
      'user',
      [
        'Your previous reply was not a valid JSON value of the requested shape. The problems:',
        listed.length > 0 ? listed.join('\n') : '- the reply could not be read',
        'Reply again with the corrected JSON value only.',
      ].join('\n\n'),
    ),
  ];
}

/**
 * Parses and validates a prompted step's reply.
 *
 * @remarks
 * The reply is `{"type":"tool_calls","calls":[{"name","arguments"}]}` or
 * `{"type":"answer","text"}`. A tool call must name a tool the step may call, with
 * arguments that satisfy that tool's JSON Schema; an answer is refused where the
 * choice forbids one (`required`, a named tool) and a tool call where it forbids
 * those (`none`). `arguments` given as a JSON string is read as that JSON.
 *
 * @param text - the model's text reply.
 * @param tools - every tool of the request.
 * @param toolChoice - the step's tool choice.
 * @returns what the step said, or why it is not usable.
 * @stability experimental
 */
export function parsePromptedToolAnswer(
  text: string,
  tools: readonly KvoxToolDefinition[],
  toolChoice: KvoxToolChoice,
): PromptedToolParse {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch (err) {
    return {
      ok: false,
      notJson: true,
      issues: [{ path: [], code: 'invalid_json', message: err instanceof Error ? err.message : 'not valid JSON' }],
    };
  }

  const fail = (issues: PromptedToolIssue[]): PromptedToolParse => ({ ok: false, notJson: false, issues });
  const issue = (path: Array<string | number>, message: string, code = 'invalid_value'): PromptedToolIssue => ({
    path,
    code,
    message,
  });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail([issue([], 'expected a JSON object with a "type" of "tool_calls" or "answer"')]);
  }
  const body = raw as Record<string, unknown>;
  const allowed = allowedTools(tools, toolChoice);

  if (body.type === 'answer') {
    if (!answerAllowed(toolChoice)) {
      return fail([issue(['type'], 'a tool call is required in this reply; "answer" is not allowed')]);
    }
    if (typeof body.text !== 'string') return fail([issue(['text'], 'expected a string', 'invalid_type')]);
    return { ok: true, step: { kind: 'answer', text: body.text } };
  }

  if (body.type === 'tool_calls') {
    if (allowed.length === 0) return fail([issue(['type'], 'no tool can be called in this reply; reply with "answer"')]);
    if (!Array.isArray(body.calls) || body.calls.length === 0) {
      return fail([issue(['calls'], 'expected a non-empty array of tool calls', 'invalid_type')]);
    }
    const calls: PromptedToolCall[] = [];
    const issues: PromptedToolIssue[] = [];
    body.calls.forEach((entry: unknown, index: number) => {
      const at: Array<string | number> = ['calls', index];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push(issue(at, 'expected an object with "name" and "arguments"', 'invalid_type'));
        return;
      }
      const call = entry as Record<string, unknown>;
      const tool = typeof call.name === 'string' ? allowed.find((candidate) => candidate.name === call.name) : undefined;
      if (tool === undefined) {
        issues.push(issue([...at, 'name'], `expected one of: ${allowed.map((candidate) => candidate.name).join(', ')}`));
        return;
      }
      const args = typeof call.arguments === 'string' ? safeParse(call.arguments) : (call.arguments ?? {});
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        issues.push(issue([...at, 'arguments'], 'expected an object', 'invalid_type'));
        return;
      }
      const checked = toolParametersSchema(tool).safeParse(args);
      if (!checked.success) {
        for (const problem of checked.error.issues) {
          issues.push({
            path: [...at, 'arguments', ...problem.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment))],
            code: problem.code,
            message: problem.message,
          });
        }
        return;
      }
      calls.push({ name: tool.name, arguments: args as Record<string, unknown> });
    });
    return issues.length > 0 ? fail(issues) : { ok: true, step: { kind: 'calls', calls } };
  }

  return fail([issue(['type'], 'expected "tool_calls" or "answer"')]);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** The text without surrounding whitespace and without one surrounding code fence. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function formatPath(path: Array<string | number>): string {
  return path.reduce<string>((out, segment) => (typeof segment === 'number' ? `${out}[${segment}]` : `${out}.${segment}`), '$');
}
