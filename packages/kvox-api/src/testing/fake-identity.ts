import type { ExecutionContext } from '@nestjs/common';

import type { KvoxIdentityPort, KvoxPrincipal } from '../ports/index.js';

/**
 * A principal as a test writes it: plain arrays instead of a `ReadonlySet`.
 *
 * @stability experimental
 */
export interface KvoxPrincipalInput {
  /** The user id. Defaults to `user-1`. */
  userId?: string;
  /** The active organization. Defaults to `null`. */
  orgId?: string | null;
  /** Role names. Defaults to none. */
  roles?: readonly string[];
  /** Permission strings. Defaults to none. */
  permissions?: Iterable<string>;
}

/**
 * Builds a {@link KvoxPrincipal} from loose input.
 *
 * @param input - the fields to set.
 * @returns the principal, with `permissions` as a `Set`.
 * @stability experimental
 */
export function kvoxPrincipal(input: KvoxPrincipalInput = {}): KvoxPrincipal {
  return {
    userId: input.userId ?? 'user-1',
    orgId: input.orgId ?? null,
    roles: input.roles ?? [],
    permissions: new Set(input.permissions ?? []),
  };
}

/**
 * Builds a minimal Nest execution context for a test: an HTTP request with the
 * given headers.
 *
 * @param headers - request headers, keyed in lower case.
 * @returns the context; `getHandler` and `getClass` return placeholder functions.
 * @stability experimental
 */
export function createFakeKvoxExecutionContext(headers: Record<string, string> = {}): ExecutionContext {
  const request: Record<string | symbol, unknown> = { headers };
  const handler = function handler(): void {};
  class Controller {}
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    getType: () => 'http',
    getArgs: () => [request],
    getArgByIndex: (index: number) => [request][index],
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
    switchToRpc: () => ({ getData: () => undefined, getContext: () => undefined }),
    switchToWs: () => ({ getData: () => undefined, getClient: () => undefined, getPattern: () => undefined }),
  } as unknown as ExecutionContext;
}

/**
 * A fake {@link KvoxIdentityPort}.
 *
 * @stability experimental
 */
export interface FakeKvoxIdentity extends KvoxIdentityPort {
  /** The principals the fake knows, by user id. */
  readonly principals: Map<string, KvoxPrincipal>;
}

/**
 * Builds a fake identity port. A request is authenticated when it carries an
 * `authorization` header: `Bearer <userId>` selects that user among
 * `principals`, any other value selects the single `principal`. A request with
 * no header is anonymous and gets `null`.
 *
 * @param options - the principal(s) the fake knows.
 * @returns the fake.
 * @stability experimental
 */
export function createFakeKvoxIdentity(
  options: { principal?: KvoxPrincipal | KvoxPrincipalInput; principals?: KvoxPrincipal[] } = {},
): FakeKvoxIdentity {
  const principals = new Map<string, KvoxPrincipal>();
  const single =
    options.principal === undefined && options.principals === undefined
      ? kvoxPrincipal()
      : options.principal !== undefined
        ? isPrincipal(options.principal)
          ? options.principal
          : kvoxPrincipal(options.principal)
        : undefined;
  if (single) principals.set(single.userId, single);
  for (const principal of options.principals ?? []) principals.set(principal.userId, principal);

  return {
    principals,

    async authenticate(context) {
      const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | undefined> }>();
      const header = request?.headers?.authorization;
      if (!header) return null;
      const wanted = /^Bearer (.+)$/.exec(header)?.[1];
      return (wanted ? principals.get(wanted) : undefined) ?? single ?? null;
    },

    async hasPermission(userId, permission) {
      return principals.get(userId)?.permissions.has(permission) ?? false;
    },
  };
}

function isPrincipal(value: KvoxPrincipal | KvoxPrincipalInput): value is KvoxPrincipal {
  return (
    value.permissions instanceof Set &&
    typeof (value as KvoxPrincipal).userId === 'string' &&
    Array.isArray((value as KvoxPrincipal).roles) &&
    (value as KvoxPrincipal).orgId !== undefined
  );
}
