import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// =============================================================================
// AI-assistant configuration tripwire (#456)
// =============================================================================
//
// Claude Code and OpenCode both read this repository's instructions, and
// OpenCode runs on local small-context models (opencode.json caps the window
// at 131072 tokens). This suite keeps the files both tools load inside a size
// budget, keeps the two agent sets in step, and pins the structure each tool
// parses. Pure filesystem, no database. Frontmatter is read with a small
// purpose-built parser: the api workspace has no YAML dependency, and these
// checks only need top-level scalars and the `permission.bash` keys.
// =============================================================================

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const p = (...parts: string[]) => join(REPO_ROOT, ...parts);

const ROOT_AGENTS_BUDGET = 24_000;
const NESTED_AGENTS_BUDGET = 6_000;
const OPENCODE_AGENT_BUDGET = 6_000;
const SKILL_BUDGET = 10_000;
const MAX_LOCAL_CONTEXT = 131_072;

/** Directories that hold a nested AGENTS.md / CLAUDE.md pair. */
function nestedDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = p(group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const dir = join(groupDir, entry.name);
      if (existsSync(join(dir, 'AGENTS.md')) || existsSync(join(dir, 'CLAUDE.md'))) dirs.push(dir);
    }
  }
  return dirs;
}

const rel = (path: string) => path.slice(REPO_ROOT.length + 1).split('\\').join('/');
const size = (path: string) => statSync(path).size;
const mdIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];

function skillFiles(): string[] {
  const dir = p('.claude', 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => join(dir, e.name, 'SKILL.md'));
}

interface Frontmatter {
  /** Top-level `key: value` pairs, quotes removed. A key with no inline value maps to ''. */
  top: Record<string, string>;
  /** Pattern -> action for the entries under `permission.bash` (null when there is no such block). */
  bash: Record<string, string> | null;
}

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Minimal frontmatter reader; returns null when there is no closed `---` block. */
function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  const top: Record<string, string> = {};
  let bash: Record<string, string> | null = null;
  let section = '';
  let sub = '';

  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      top[m[1]] = unquote(m[2]);
      section = m[1];
      sub = '';
    } else if (section === 'permission') {
      const m = /^\s+("[^"]*"|'[^']*'|[^\s:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (indent <= 2) {
        sub = unquote(m[1]);
        if (sub === 'bash') bash = bash ?? {};
        if (sub === 'bash' && m[2].trim()) bash = { '*': unquote(m[2]) };
      } else if (sub === 'bash' && bash) {
        bash[unquote(m[1])] = unquote(m[2]);
      }
    }
  }
  return { top, bash };
}

const frontmatterOf = (path: string) => parseFrontmatter(readFileSync(path, 'utf8'));

describe('AI-assistant configuration (#456)', () => {
  describe('frontmatter reader can fail', () => {
    it('rejects a missing block and a bash block that does not deny git push', () => {
      expect(parseFrontmatter('# no frontmatter')).toBeNull();
      const fm = parseFrontmatter('---\ndescription: x\nmode: subagent\npermission:\n  bash:\n    "git push*": ask\n---\n');
      expect(fm?.top.mode).toBe('subagent');
      expect(fm?.bash?.['git push*']).toBe('ask');
    });
  });

  describe('size budgets for files the tools load', () => {
    it('root AGENTS.md exists and stays within budget', () => {
      const path = p('AGENTS.md');
      expect(existsSync(path)).toBe(true);
      expect(size(path)).toBeLessThanOrEqual(ROOT_AGENTS_BUDGET); // trim AGENTS.md: move detail into docs/ and link it
    });

    it('every nested AGENTS.md is within budget', () => {
      const limit = NESTED_AGENTS_BUDGET;
      const files = nestedDirs().map((d) => join(d, 'AGENTS.md')).filter(existsSync);
      expect(files.length).toBeGreaterThanOrEqual(3); // apps/api, apps/web, apps/cli
      const over = files.filter((f) => size(f) > limit).map((f) => `${rel(f)} is ${size(f)} bytes (limit ${limit}): move detail into docs/ and link it`);
      expect(over).toEqual([]);
    });

    it('every .opencode/agents/*.md is within budget', () => {
      const dir = p('.opencode', 'agents');
      const names = mdIn(dir);
      expect(names.length).toBeGreaterThanOrEqual(1);
      const over = names
        .map((n) => join(dir, n))
        .filter((f) => size(f) > OPENCODE_AGENT_BUDGET)
        .map((f) => `${rel(f)} is ${size(f)} bytes (limit ${OPENCODE_AGENT_BUDGET}): trim the agent prompt and link the docs`);
      expect(over).toEqual([]);
    });

    it('every .claude/skills/*/SKILL.md is within budget', () => {
      const files = skillFiles();
      expect(files.length).toBeGreaterThanOrEqual(1);
      const over = files
        .filter((f) => size(f) > SKILL_BUDGET)
        .map((f) => `${rel(f)} is ${size(f)} bytes (limit ${SKILL_BUDGET}): move reference material to a sibling file or docs/`);
      expect(over).toEqual([]);
    });
  });

  describe('agent parity', () => {
    it('.claude/agents and .opencode/agents define the same agent names', () => {
      const claude = mdIn(p('.claude', 'agents'));
      const opencode = mdIn(p('.opencode', 'agents'));
      expect(claude.length).toBeGreaterThanOrEqual(1);
      // Names only: add the missing agent file to the side listed on the right.
      expect(opencode).toEqual(claude);
    });
  });

  describe('OpenCode agent definitions', () => {
    const dir = p('.opencode', 'agents');
    const names = mdIn(dir);

    it.each(names)('%s has parseable frontmatter with description and mode: subagent', (name) => {
      const fm = frontmatterOf(join(dir, name));
      expect(fm).not.toBeNull();
      expect((fm?.top.description ?? '').length).toBeGreaterThan(0);
      expect(fm?.top.mode).toBe('subagent');
    });

    it.each(names)('%s denies state-changing git when it declares permission.bash', (name) => {
      const fm = frontmatterOf(join(dir, name));
      if (!fm?.bash) return;
      const notDenied = ['git push*', 'git commit*', 'git merge*', 'git rebase*'].filter((k) => fm.bash?.[k] !== 'deny');
      expect(notDenied).toEqual([]);
    });
  });

  describe('Claude skills', () => {
    const files = skillFiles();

    it('ships at least the template skills (new-project, rename-app)', () => {
      const names = files.map((f) => f.split('/').slice(-2)[0]);
      expect(names).toEqual(expect.arrayContaining(['new-project', 'rename-app']));
    });

    it('ships the add-job-type and add-settings-page skills (#456)', () => {
      const names = files.map((f) => f.split('/').slice(-2)[0]);
      expect(names).toEqual(expect.arrayContaining(['add-job-type', 'add-settings-page']));
    });

    it('ships the platform-migration skill in both assistant trees (#463)', () => {
      const claude = p('.claude', 'skills', 'platform-migration', 'SKILL.md');
      const opencode = p('.opencode', 'skills', 'platform-migration', 'SKILL.md');
      expect(existsSync(claude)).toBe(true);
      expect(existsSync(opencode)).toBe(true); // copy .claude/skills/platform-migration/SKILL.md into .opencode/skills/platform-migration/
      // The twin must stay byte-identical: edit one, copy to the other.
      expect(readFileSync(opencode, 'utf8')).toBe(readFileSync(claude, 'utf8'));
      for (const file of [claude, opencode]) {
        expect(frontmatterOf(file)?.top.name).toBe('platform-migration');
        expect(size(file)).toBeLessThanOrEqual(SKILL_BUDGET);
      }
    });

    it.each(files.map((f) => [rel(f), f]))('%s has valid name and description frontmatter', (_label, file) => {
      const dirName = file.split('/').slice(-2)[0];
      const fm = frontmatterOf(file);
      expect(fm).not.toBeNull();
      const name = fm?.top.name ?? '';
      expect(name).toBe(dirName);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      const description = fm?.top.description ?? '';
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(1024);
    });
  });

  describe('CLAUDE.md imports AGENTS.md', () => {
    it('every nested CLAUDE.md next to an AGENTS.md is exactly "@AGENTS.md"', () => {
      const pairs = nestedDirs().filter((d) => existsSync(join(d, 'AGENTS.md')));
      expect(pairs.length).toBeGreaterThanOrEqual(3);
      const wrong = pairs
        .filter((d) => !existsSync(join(d, 'CLAUDE.md')) || readFileSync(join(d, 'CLAUDE.md'), 'utf8').trim() !== '@AGENTS.md')
        .map((d) => `${rel(join(d, 'CLAUDE.md'))} must contain only "@AGENTS.md" (content belongs in the sibling AGENTS.md)`);
      expect(wrong).toEqual([]);
    });

    it('root CLAUDE.md imports @AGENTS.md as its first non-heading line', () => {
      const lines = readFileSync(p('CLAUDE.md'), 'utf8').split('\n').map((l) => l.trim());
      const first = lines.find((l) => l && !l.startsWith('#'));
      expect(first).toBe('@AGENTS.md');
    });
  });

  describe('opencode.json', () => {
    const config = (): Record<string, any> => JSON.parse(readFileSync(p('opencode.json'), 'utf8'));

    it('parses and does not use `instructions` (AGENTS.md is loaded natively)', () => {
      expect(config()).not.toHaveProperty('instructions');
    });

    it('declares a local-coder context window no larger than the local model supports', () => {
      const context = config().provider?.local?.models?.['local-coder']?.limit?.context;
      expect(typeof context).toBe('number');
      expect(context).toBeLessThanOrEqual(MAX_LOCAL_CONTEXT);
    });
  });

  describe('rule headings stay findable in AGENTS.md', () => {
    it.each([
      'MANDATORY: Issue-Driven Development (Traceability)',
      'MANDATORY: Worktree-Based Feature Development',
      'MANDATORY: Claude Git Rules — Commit, Then Always Open a PR',
      'MANDATORY: CLI Version Bump on Improvement',
      'MANDATORY: Settings UI Pattern',
      'MANDATORY: Every Long-Running Activity Is a Queue Job',
    ])('contains the heading "%s"', (heading) => {
      const headings = readFileSync(p('AGENTS.md'), 'utf8')
        .split('\n')
        .filter((l) => /^#{1,6}\s/.test(l))
        .map((l) => l.replace(/^#+\s*/, '').trim());
      // Other docs and rule references cite these by name; renaming one needs a sweep of those references.
      expect(headings).toContain(heading);
    });
  });
});
