import { DeploymentResolutionError, resolveDeployment, type ResolvedDeployment } from './deployment.js';
import { backupEnvFile, confirmationProblem } from './uninstall-guard.js';

// =============================================================================
// Flags and commands of the pre-platform `deploy` surface  (issue #482, epic #478)
// =============================================================================
//
// Before the CLI moved onto the platform's engine, this app's `deploy` commands
// had flags and subcommands the platform's do not. Operators script against
// them (cron files written by `certs renew --install-cron` are on live servers,
// and the deploy end-to-end workflow passes `--skip-github` and `--check`), and
// the platform's commands are built-ins this app cannot add flags to. So the
// argument vector is translated BEFORE it reaches the platform's parser, by one
// pure function, and every legacy flag lands in exactly one of four outcomes:
//
//   IGNORE   the platform does the equivalent by itself; the flag is dropped and
//            a one-line note says why.
//   ALIAS    the platform has the same thing under another name; rewritten.
//   PORT     kept as app behaviour: `update --check`, the typed `--confirm
//            <name>` of `uninstall` with the environment-file backup, and the
//            `certs renew|status` subcommands (a cron entry an older CLI wrote
//            calls them).
//   REFUSE   the platform has no equivalent and ignoring the flag would change
//            what the command does (or hide that it cannot). The command stops
//            with a usage error that says what to do instead. Nothing is ever
//            silently accepted and then not honoured.
//
// The complete table is in apps/cli/README.md ("Flags and commands that changed
// in 1.10"); it is the same list as RULES below.
//
// PLATFORM-ADOPTION-SHIM(#482): this whole layer exists because the platform's
// built-in `deploy` commands accept no extra flags and no extra subcommands. It
// goes away flag by flag as the platform gains them, and wholesale when the
// pre-platform spellings stop being supported (see
// docs/platform-adoption/local-exceptions.md).
// =============================================================================

/** Flags of the `deploy` commands that take a value (the next token, or `=value`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--root',
  '--apps-root',
  '--name',
  '--domain',
  '--proxy-root',
  '--proxy-container',
  '--proxy-mode',
  '--port',
  '--repo',
  '--ref',
  '--email',
  '--group',
  '--answer',
  '--answers-file',
  '--app-db-user',
  '--admin-user',
  '--app-version',
  '--confirm',
  '--confirm-database',
  '--confirm-bucket',
  '--server',
  '--public-ip',
]);

const DEPLOY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'doctor',
  'install',
  'uninstall',
  'update',
  'status',
  'about',
  'list',
  'certs',
]);

type Rule =
  | { readonly kind: 'ignore'; readonly note: string }
  | { readonly kind: 'alias'; readonly to: readonly string[]; readonly note: string }
  | { readonly kind: 'refuse'; readonly message: string };

const SKIP_GITHUB: Rule = {
  kind: 'ignore',
  note:
    '--skip-github is ignored: the GitHub CLI checks now skip themselves when git can already read ' +
    'the repository or the remote is not an HTTPS GitHub URL.',
};

const RENEWAL_IS_AUTOMATIC: Rule = {
  kind: 'ignore',
  note:
    '--install-cron is ignored: certificate renewal is scheduled by install and update themselves ' +
    '(unless something else already renews the certificates); use --skip-renewal to opt out.',
};

/** Rules by subcommand, then by flag. Every entry is one row of the README table. */
const RULES: Readonly<Record<string, Readonly<Record<string, Rule>>>> = {
  doctor: {
    '--skip-github': SKIP_GITHUB,
    '--skip-proxy': {
      kind: 'refuse',
      message:
        'deploy doctor --skip-proxy no longer exists: the platform doctor always checks the proxy, ' +
        'certificates, ports and DNS. Read the individual results, or pass --skip-doctor to install.',
    },
    '--public-ip': {
      kind: 'refuse',
      message:
        'deploy doctor --public-ip no longer exists, and the public-address override is not read ' +
        'from the environment any more: the DNS check compares against the address the server reports. ' +
        'Behind NAT, treat the DNS result as advisory.',
    },
  },
  install: {
    '--skip-github': SKIP_GITHUB,
    '--install-cron': RENEWAL_IS_AUTOMATIC,
    '--no-install-cron': {
      kind: 'alias',
      to: ['--skip-renewal'],
      note: '--no-install-cron is now --skip-renewal.',
    },
    '--fresh': {
      kind: 'refuse',
      message:
        'deploy install --fresh no longer exists. To start over on this server, run deploy uninstall ' +
        '(it keeps the shared proxy and the certificate and backs up the environment file), then deploy install; ' +
        'to install over an existing deployment as it is, use --reinstall.',
    },
    '--no-ipv6': {
      kind: 'refuse',
      message:
        'deploy install --no-ipv6 no longer exists: the platform renders the vhost with [::] listeners ' +
        'and offers no switch, so nginx would refuse to start on a host with IPv6 disabled. ' +
        'Enable IPv6 on the host, or edit the rendered vhost by hand after the install.',
    },
  },
  update: {
    '--skip-github': SKIP_GITHUB,
  },
  uninstall: {
    '--non-interactive': {
      kind: 'ignore',
      note: '--non-interactive is ignored: uninstall never prompts; every confirmation is a flag.',
    },
    '--skip-proxy': {
      kind: 'refuse',
      message:
        'deploy uninstall --skip-proxy no longer exists: the platform removes this deployment\'s vhost ' +
        'whenever it knows the domain. Use --dry-run to see exactly what would be touched.',
    },
    '--certs': {
      kind: 'refuse',
      message:
        'deploy uninstall --certs no longer exists: the TLS certificate is never removed (Let\'s Encrypt allows ' +
        '5 duplicate certificates per week). Delete it by hand with certbot if you really mean to.',
    },
    '--keep-env': {
      kind: 'refuse',
      message:
        'deploy uninstall --keep-env no longer exists: the environment file is always removed, after a ' +
        'copy to <apps-root>/<name>.env.<timestamp>.bak (mode 0600). Restore it from that copy if you need it.',
    },
  },
  about: {
    '--check': {
      kind: 'ignore',
      note: 'deploy about --check is ignored: about reads the deployment record off disk and has no Update line.',
    },
    '--server': {
      kind: 'ignore',
      note: 'deploy about --server is ignored: about no longer asks the API; the web Console\'s About page shows that.',
    },
  },
};

/** The result of translating an argument vector. */
export type LegacyPlan =
  | {
      kind: 'run';
      /** What to hand the platform CLI. */
      argv: string[];
      /** One line each, for stderr, before the command runs. */
      notes: string[];
      /** Work to do first (the environment backup); each returns a line to print. */
      before: Array<() => string | undefined>;
    }
  | { kind: 'refuse'; message: string }
  | {
      kind: 'update-check';
      notes: string[];
      selector: { root?: string | undefined; name?: string | undefined; appsRoot?: string | undefined };
      ref?: string | undefined;
      json: boolean;
    };

/** What {@link translateLegacyArgs} needs from the process. */
export interface LegacyContext {
  /** The executable's name, for messages. */
  cli: string;
  cwd: string;
  now?: (() => Date) | undefined;
}

interface Item {
  /** The raw tokens this item came from (a flag and its value, or one positional). */
  tokens: string[];
  flag?: string | undefined;
  value?: string | undefined;
}

function scan(tokens: readonly string[]): Item[] {
  const items: Item[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--') {
      items.push({ tokens: tokens.slice(index) });
      break;
    }
    if (!token.startsWith('--')) {
      items.push({ tokens: [token] });
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (equals !== -1) {
      items.push({ tokens: [token], flag, value: token.slice(equals + 1) });
    } else if (VALUE_FLAGS.has(flag) && index + 1 < tokens.length) {
      items.push({ tokens: [token, tokens[index + 1] as string], flag, value: tokens[index + 1] as string });
      index += 1;
    } else {
      items.push({ tokens: [token], flag });
    }
  }
  return items;
}

function valueOf(items: readonly Item[], flag: string): string | undefined {
  return items.find((item) => item.flag === flag)?.value;
}

function has(items: readonly Item[], flag: string): boolean {
  return items.some((item) => item.flag === flag);
}

/**
 * Translates the pre-platform `deploy` surface into the platform's.
 *
 * Pure apart from what it is handed: it reads the filesystem only to resolve
 * the deployment an `uninstall` means (and only for a real, confirmed one), and
 * the environment backup is returned as work for the caller to run, not run
 * here.
 *
 * @param argv - The arguments after the executable name.
 * @param context - The executable's name, the working directory, the clock.
 * @returns what to run, what to refuse, or the `update --check` to answer.
 */
export function translateLegacyArgs(argv: readonly string[], context: LegacyContext): LegacyPlan {
  const passthrough: LegacyPlan = { kind: 'run', argv: [...argv], notes: [], before: [] };

  // Help and version are never translated: they must describe the real surface.
  if (argv.includes('-h') || argv.includes('--help') || argv.includes('-v') || argv.includes('--version')) {
    return passthrough;
  }

  const deployAt = argv.findIndex((token) => !token.startsWith('-'));
  if (deployAt === -1 || argv[deployAt] !== 'deploy') return passthrough;

  const subAt = argv.findIndex((token, index) => index > deployAt && !token.startsWith('-'));
  const sub = subAt === -1 ? undefined : argv[subAt];
  if (sub === undefined || !DEPLOY_SUBCOMMANDS.has(sub)) return passthrough;

  const head = argv.slice(0, subAt + 1);
  const tail = argv.slice(subAt + 1);

  if (sub === 'certs') return translateCerts(head, tail, context);

  const items = scan(tail);
  const notes: string[] = [];
  const kept: Item[] = [];
  const added: string[] = [];

  const table = RULES[sub] ?? {};
  for (const item of items) {
    const rule = item.flag === undefined ? undefined : table[item.flag];
    if (rule === undefined) {
      kept.push(item);
      continue;
    }
    if (rule.kind === 'refuse') return { kind: 'refuse', message: `${context.cli}: ${rule.message}` };
    notes.push(`${context.cli}: note: ${rule.note}`);
    if (rule.kind === 'alias') added.push(...rule.to);
  }

  const before: Array<() => string | undefined> = [];

  if (sub === 'update' && has(items, '--check')) {
    return {
      kind: 'update-check',
      notes,
      selector: {
        root: valueOf(items, '--root'),
        name: valueOf(items, '--name'),
        appsRoot: valueOf(items, '--apps-root'),
      },
      ref: valueOf(items, '--ref'),
      json: has(items, '--json'),
    };
  }

  if (sub === 'uninstall') {
    const confirm = kept.find((item) => item.flag === '--confirm');
    const outcome = guardUninstall(items, confirm?.value, context, before);
    if (outcome !== undefined) return { kind: 'refuse', message: outcome };
    // The platform's uninstall has no `--confirm`; it was consumed here.
    const index = kept.findIndex((item) => item.flag === '--confirm');
    if (index !== -1) kept.splice(index, 1);
  }

  return {
    kind: 'run',
    argv: [...head, ...kept.flatMap((item) => item.tokens), ...added],
    notes,
    before,
  };
}

function guardUninstall(
  items: readonly Item[],
  typed: string | undefined,
  context: LegacyContext,
  before: Array<() => string | undefined>,
): string | undefined {
  // A dry run changes nothing, so it needs no confirmation and takes no backup.
  if (has(items, '--dry-run')) return undefined;

  let deployment: ResolvedDeployment;
  try {
    deployment = resolveDeployment({
      root: valueOf(items, '--root'),
      name: valueOf(items, '--name'),
      appsRoot: valueOf(items, '--apps-root'),
      cwd: context.cwd,
    });
  } catch (error) {
    if (error instanceof DeploymentResolutionError) return `${context.cli}: ${error.message}`;
    throw error;
  }

  const problem = confirmationProblem(context.cli, deployment.name, typed);
  if (problem !== undefined) return problem;

  before.push(() => {
    const backup = backupEnvFile(deployment, context.now?.() ?? new Date());
    return backup === undefined
      ? undefined
      : `${context.cli}: note: copied ${backup.source} to ${backup.path} (mode 0600) before it is removed.`;
  });
  return undefined;
}

/**
 * `deploy certs renew` and `deploy certs status` became `deploy certs [--renew]`.
 *
 * The renew form matters most: cron files an older CLI wrote under
 * `/etc/cron.d` call `<cli> deploy certs renew --all --apps-root <dir> --name
 * <app>`, and they keep running after an upgrade until the platform's own
 * schedule replaces them. Each such entry names its app, so renewing that app's
 * certificate is what it needs; `--all` (every lineage behind the proxy) has no
 * equivalent and is dropped.
 */
function translateCerts(head: readonly string[], tail: readonly string[], context: LegacyContext): LegacyPlan {
  const items = scan(tail);
  const verbAt = items.findIndex((item) => item.flag === undefined);
  const verb = verbAt === -1 ? undefined : items[verbAt]?.tokens[0];
  if (verb !== 'renew' && verb !== 'status') return { kind: 'run', argv: [...head, ...tail], notes: [], before: [] };

  const notes: string[] = [];
  const rest = items.filter((_, index) => index !== verbAt);
  const kept: Item[] = [];
  let dryRun = false;

  for (const item of rest) {
    if (item.flag === '--all') {
      notes.push(
        `${context.cli}: note: certs ${verb} --all is ignored: this deployment's certificate is the one acted on.`,
      );
    } else if (item.flag === '--install-cron') {
      notes.push(
        `${context.cli}: note: certs ${verb} --install-cron is ignored: install and update schedule renewal themselves.`,
      );
    } else if (item.flag === '--dry-run') {
      dryRun = true;
    } else {
      kept.push(item);
    }
  }

  const renew = verb === 'renew' && !dryRun;
  notes.push(
    renew
      ? `${context.cli}: note: certs renew is now \`deploy certs --renew\` (renews only inside the renewal window; --force overrides).`
      : `${context.cli}: note: certs ${verb}${dryRun ? ' --dry-run' : ''} is now \`deploy certs\` without --renew, which reports and changes nothing.`,
  );

  return {
    kind: 'run',
    argv: [...head, ...(renew ? ['--renew'] : []), ...kept.flatMap((item) => item.tokens)],
    notes,
    before: [],
  };
}
