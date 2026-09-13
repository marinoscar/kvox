import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiClient, resolveApiBaseUrl, type ApiResponse } from '../../api-client.js';
import { API_PATH_PREFIX, CLI_NAME } from '../../branding.js';
import {
  ALLOWED_METHODS,
  BODYLESS_METHODS,
  parseRequestPath,
  type AllowedMethod,
} from '../../commands/api.js';
import { requireCredentials } from '../../config.js';
import { formatError } from '../../errors.js';
import { formatJson } from '../../output.js';
import { resolveRequestBody } from '../../request-body.js';
import { ErrorNotice, Field, Frame } from '../layout.js';
import { ScrollBox } from '../scroll-box.js';

// =============================================================================
// The endpoint invoker  (issue #145, epic #110)
// =============================================================================
//
// #145's third screen: method, path, body, and the response rendered scrollably.
// It is the TUI face of `appctl api` (#144) and it reuses that command's
// validation rather than re-deriving it — `parseRequestPath` for the path (the
// leading slash, the optional `/api` prefix, the "that is a URL, not a path"
// refusal), `resolveRequestBody` for the payload, `ALLOWED_METHODS` for the
// pick-list. A second copy of any of those is how the two interfaces start
// disagreeing about what a valid request is.
//
// -----------------------------------------------------------------------------
// A LINEAR WIZARD, NOT A FORM WITH FOCUS MANAGEMENT
// -----------------------------------------------------------------------------
// One field at a time — method, then path, then body, then the result. The
// alternative (all three on screen, Tab between them) needs focus state, needs
// every `useInput` handler to know whether it is the focused one, and puts a
// text cursor in a place the user cannot see when the terminal is narrow. The
// wizard has exactly one thing accepting input at any moment, which also means
// `useInput` handlers can never fight over a keystroke — the failure that turns
// a typed `q` into an unexplained quit.
//
// THE CREDENTIAL COMES FROM `requireCredentials()`, AND THERE IS NO SERVER FIELD.
// Deliberately, and for the same reason `commands/api.ts` has no `--server`
// flag: the server and the token are a PAIR. A PAT minted for one host is
// worthless on another and must never be sent to one, and a screen that let
// them be set independently would put leaking a bearer token to an arbitrary
// host one typo away.
// =============================================================================

export interface InvokeScreenProps {
  onDone: () => void;
}

interface MethodItem {
  key: string;
  label: string;
  value: AllowedMethod;
}

const METHOD_ITEMS: MethodItem[] = ALLOWED_METHODS.map((method) => ({
  key: method,
  label: method,
  value: method,
}));

type Step =
  | { kind: 'method' }
  | { kind: 'path'; method: AllowedMethod }
  | { kind: 'body'; method: AllowedMethod; path: string }
  | { kind: 'running'; method: AllowedMethod; path: string }
  | {
      kind: 'result';
      method: AllowedMethod;
      path: string;
      status: number;
      durationMs: number;
      lines: string[];
    }
  | { kind: 'failed'; message: string };

export function InvokeScreen({ onDone }: InvokeScreenProps): ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'method' });
  const [path, setPath] = useState('/api/auth/me');
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  // Same reasoning as the login screen: an in-flight request holds the event
  // loop open, so leaving the screen must cancel it or the process lingers
  // after the UI is gone. `ApiClient` combines this signal with its own timeout.
  const abortRef = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      abortRef.current?.abort();
    },
    [],
  );

  const send = useCallback(async (method: AllowedMethod, rawPath: string, rawBody: string) => {
    setFieldError(undefined);

    // Everything that can be diagnosed WITHOUT a socket is diagnosed first, and
    // reported as a field error that leaves the user on the step they got it
    // wrong on. Sending a malformed request and relaying the server's 400 or
    // 404 would blame the server for a local mistake — the failure mode #144's
    // header calls out by name.
    let request: { path: string; query: URLSearchParams };
    try {
      request = parseRequestPath(rawPath);
    } catch (error) {
      setFieldError(formatError(error));
      setStep({ kind: 'path', method });
      return;
    }

    let payload: { value: unknown } | undefined;
    try {
      payload = await resolveRequestBody(rawBody.trim().length === 0 ? undefined : rawBody.trim(), {
        // `stdinIsTTY: true` makes `resolveRequestBody` REJECT the `-` sentinel
        // with its own clear message instead of trying to read stdin. In a TUI
        // stdin is the keyboard, held in raw mode by ink: reading it to EOF
        // would swallow every keystroke and hang the app with no way out. The
        // `@file.json` form still works and is the useful one here, since a
        // long JSON body is miserable to type into a single-line field.
        stdinIsTTY: true,
      });
    } catch (error) {
      setFieldError(formatError(error));
      setStep({ kind: 'body', method, path: rawPath });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStep({ kind: 'running', method, path: rawPath });

    const startedAt = Date.now();
    try {
      const credentials = requireCredentials();
      const client = new ApiClient({
        baseUrl: resolveApiBaseUrl(credentials.serverUrl),
        token: credentials.token,
      });

      const queryString = request.query.toString();
      const requestPath =
        queryString.length > 0 ? `${request.path}?${queryString}` : request.path;

      const response: ApiResponse<unknown> = await client.send(method, requestPath, {
        signal: controller.signal,
        // Spread in only when a body was actually given. `ApiClient.send`
        // decides whether to set `Content-Type: application/json` on
        // `body !== undefined`, and Fastify 5 answers 400 to a request that
        // declares a JSON type and carries no bytes — so `{ body: undefined }`
        // and no `body` key are very different things.
        ...(payload === undefined ? {} : { body: payload.value }),
      });

      if (!mounted.current) return;
      setStep({
        kind: 'result',
        method,
        path: displayPath(request.path, queryString),
        status: response.status,
        durationMs: Date.now() - startedAt,
        lines: renderBody(response.body),
      });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      // ApiError's message is already `<status>: <the server's own sentence>`
      // (errors.ts), so a missing permission arrives as
      // `403: Missing permission users:read` rather than "request failed".
      // Nothing here improves on that; passing it through is the whole point.
      setStep({ kind: 'failed', message: formatError(error) });
    }
  }, []);

  useInput(
    (input, key) => {
      if (key.escape) {
        onDone();
        return;
      }
      if (input === 'n' && (step.kind === 'result' || step.kind === 'failed')) {
        setStep({ kind: 'method' });
      }
    },
    // Off while a text field owns the keyboard, or the `n` in `/api/notify`
    // would abandon what the user was typing.
    { isActive: step.kind !== 'path' && step.kind !== 'body' },
  );

  switch (step.kind) {
    case 'method':
      return (
        <Frame title="Call an endpoint" hints={['↑↓ move', 'enter select', 'esc back']}>
          <Box flexDirection="column" gap={1}>
            <Text>Method</Text>
            <SelectInput
              items={METHOD_ITEMS}
              onSelect={(item) => {
                setStep({ kind: 'path', method: item.value });
              }}
            />
          </Box>
        </Frame>
      );

    case 'path':
      return (
        <Frame title={`Call an endpoint · ${step.method}`} hints={['enter continue', 'esc back']}>
          <Box flexDirection="column" gap={1}>
            <Box>
              <Text dimColor>{'Path  '}</Text>
              <TextInput
                value={path}
                onChange={setPath}
                onSubmit={(value) => {
                  if (BODYLESS_METHODS.has(step.method)) {
                    void send(step.method, value, '');
                    return;
                  }
                  setStep({ kind: 'body', method: step.method, path: value });
                }}
                placeholder="/api/auth/me"
              />
            </Box>
            <Text dimColor>
              {`The \`${API_PATH_PREFIX}\` prefix is optional. A query string is accepted inline: /api/users?page=2`}
            </Text>
            {fieldError === undefined ? null : <ErrorNotice message={fieldError} />}
          </Box>
        </Frame>
      );

    case 'body':
      return (
        <Frame
          title={`Call an endpoint · ${step.method}`}
          hints={['enter send', 'esc back']}
        >
          <Box flexDirection="column" gap={1}>
            <Field label="Request" value={`${step.method} ${step.path}`} />
            <Box>
              <Text dimColor>{'Body  '}</Text>
              <TextInput
                value={body}
                onChange={setBody}
                onSubmit={(value) => {
                  void send(step.method, step.path, value);
                }}
                placeholder='{"email":"a@b.com"}   (or @file.json, or leave empty)'
              />
            </Box>
            <Text dimColor>Inline JSON, or @file.json to read one. Empty sends no body.</Text>
            {fieldError === undefined ? null : <ErrorNotice message={fieldError} />}
          </Box>
        </Frame>
      );

    case 'running':
      return (
        <Frame title="Call an endpoint" hints={['esc cancel']}>
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text>
              {' '}
              {step.method} {step.path}…
            </Text>
          </Box>
        </Frame>
      );

    case 'result':
      return (
        <Frame
          title="Call an endpoint"
          hints={['↑↓ scroll', 'g/G top/bottom', 'n new request', 'esc back']}
        >
          <Box flexDirection="column">
            <Box>
              <Text bold>
                {step.method} {step.path}
              </Text>
              <Text> → </Text>
              {/* Colour by class, not by exact code: 2xx green, everything else
                  red. The distinction a user needs at a glance is "did it work",
                  and a 404 and a 500 are both "no" even though only one is
                  their fault. */}
              <Text color={step.status >= 200 && step.status < 300 ? 'green' : 'red'} bold>
                {step.status}
              </Text>
              <Text dimColor> ({Math.round(step.durationMs)}ms)</Text>
            </Box>
            <ScrollBox lines={step.lines} reservedRows={12} />
          </Box>
        </Frame>
      );

    case 'failed':
      return (
        <Frame title="Call an endpoint" hints={['n new request', 'esc back']}>
          <ErrorNotice
            message={step.message}
            hint={`Press n for another request, or esc for the menu. The same call runs as \`${CLI_NAME} api …\`.`}
          />
        </Frame>
      );
  }
}

/**
 * Put the `/api` prefix back for display.
 *
 * `parseRequestPath` strips it so the path can be joined onto a base URL that
 * already carries one — an internal detail. Echoing the stripped form back
 * would show the user a path they did not type and that does not exist on the
 * server, which is exactly what `commands/api.ts` avoids for its status line.
 */
function displayPath(path: string, queryString: string): string {
  const base = `${API_PATH_PREFIX}${path === '/' ? '' : path}`;
  return queryString.length > 0 ? `${base}?${queryString}` : base;
}

/**
 * The response body, as display lines.
 *
 * TWO DECISIONS, both inherited from #144 with one deliberate divergence:
 *
 *   1. `response.body` — the server's own JSON — NOT the unwrapped
 *      `response.data`. `unwrapEnvelope` cannot tell the API's
 *      `{ data, meta }` envelope apart from a paginated endpoint's
 *      `{ data: [...], pagination: {...} }` (nothing can, from outside: they
 *      are the same shape), so unwrapping `GET /api/users` yields the bare
 *      array and SILENTLY DISCARDS THE PAGE COUNT. Showing the envelope is
 *      slightly verbose; hiding the total is quietly wrong.
 *
 *   2. `colour: false`, which is where this differs from the command.
 *      `formatJson`'s coloured output carries raw SGR escape sequences, and
 *      this text is about to be SLICED BY LINE into a scrolling viewport and
 *      handed to ink, which does its own ANSI-aware layout. A window that
 *      begins in the middle of a colour run would leak that colour into the
 *      rest of the frame, and ink's width measurement of a string carrying
 *      sequences it did not emit is not something to rely on for a layout that
 *      redraws on every keypress. Structure is legible without colour; a frame
 *      tinted red because the viewport started inside a string is not.
 */
function renderBody(body: unknown): string[] {
  if (body === undefined) {
    // A 204, or any 2xx with no bytes — `DELETE /api/allowlist/{id}` and
    // `POST /api/auth/logout` both do this. Saying so beats printing `null`,
    // which would claim the server sent a value it never sent.
    return ['(no response body)'];
  }
  return formatJson(body, { colour: false }).split('\n');
}
