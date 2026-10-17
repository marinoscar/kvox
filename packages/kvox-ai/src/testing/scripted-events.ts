import type { AiResponse, AiStreamEvent } from '@marinoscar/platform-api/ai';

// =============================================================================
// Provider events and responses for a scripted runtime (issue #579)
// =============================================================================
//
// The few builders every spec of this package, the conformance suite and a host's
// own tests need to write what a provider says: a streamed text delta, a function
// call, a completed response. They produce the provider-adapter types of
// `@marinoscar/platform-api/ai` and nothing else, so a host that drives its own
// platform client with them (the web edition's `AiService` stand-in) says exactly
// what a scripted runtime says.
// =============================================================================

/**
 * A complete provider response with usage, for a script to start from.
 *
 * @stability experimental
 */
export const SCRIPTED_RESPONSE: AiResponse = {
  id: 'resp-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  output: [],
  outputText: '',
  usage: { inputTokens: 12, outputTokens: 7 },
  finishReason: 'stop',
};

/**
 * One `response.completed` event.
 *
 * @param overrides - fields of the response to change (a `finishReason`, a `usage`).
 * @returns the event.
 * @stability experimental
 */
export function completedEvent(overrides: Partial<AiResponse> = {}): AiStreamEvent {
  return { type: 'response.completed', response: { ...SCRIPTED_RESPONSE, ...overrides } };
}

/**
 * One streamed text delta.
 *
 * @param delta - the new text.
 * @returns the event.
 * @stability experimental
 */
export function textDeltaEvent(delta: string): AiStreamEvent {
  return { type: 'output_text.delta', delta };
}

/**
 * One finished function-call item (the model asking for a tool).
 *
 * @param callId - the call's id.
 * @param name - the tool's name.
 * @param args - the arguments, as the JSON text the provider streams.
 * @returns the event.
 * @stability experimental
 */
export function functionCallEvent(callId: string, name: string, args = '{}'): AiStreamEvent {
  return { type: 'output_item.done', item: { type: 'function_call', callId, name, arguments: args } };
}

/**
 * The provider's in-band `error` event (a stream that fails after it started).
 *
 * @param code - a platform `AiErrorCode`.
 * @param message - the provider's message.
 * @returns the event.
 * @stability experimental
 */
export function errorEvent(code: Extract<AiStreamEvent, { type: 'error' }>['code'], message: string): AiStreamEvent {
  return { type: 'error', code, message };
}

/**
 * The events of a plain streamed answer: the text in one delta, then completion.
 *
 * @param text - the answer.
 * @param overrides - fields of the completed response to change.
 * @returns the events, in order.
 * @stability experimental
 */
export function textAnswer(text: string, overrides: Partial<AiResponse> = {}): AiStreamEvent[] {
  return [textDeltaEvent(text), completedEvent(overrides)];
}

/**
 * Yields events as an async stream, throwing any `Error` in the list at its
 * position (a stream that breaks halfway).
 *
 * @param list - events, or an error to throw when reached.
 * @returns the async generator.
 * @stability experimental
 */
export async function* eventStream(...list: Array<AiStreamEvent | Error>): AsyncGenerator<AiStreamEvent> {
  for (const event of list) {
    if (event instanceof Error) throw event;
    yield event;
  }
}

/**
 * Drains an async iterable into an array.
 *
 * @param iterable - the stream.
 * @returns every item, in order.
 * @stability experimental
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
