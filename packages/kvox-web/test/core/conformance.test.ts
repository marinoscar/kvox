import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createFakeKvoxWebHost,
  describeKvoxWebConformance,
  scanKvoxWebSources,
} from '../../src/core/testing/index.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

// The package's own sources must satisfy the host-neutral rules, and its
// in-memory host must satisfy the host contract: the kit run against itself.
describeKvoxWebConformance({ describe, it, expect }, { srcDir: SRC, createHost: () => createFakeKvoxWebHost() });

describe('scanKvoxWebSources', () => {
  it('finds nothing in the real sources', () => {
    expect(scanKvoxWebSources(SRC)).toEqual([]);
  });
});

describe('scanKvoxWebSources finds a violation', () => {
  function sandbox(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'kvox-web-scan-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }

  it('in a headless file that imports MUI, a router or a ui folder, naming the file', () => {
    const dir = sandbox({
      'core/headless/a.ts': "import Box from '@mui/material/Box';\nexport const A = Box;\n",
      'core/headless/b.ts': "import { useNavigate } from 'react-router-dom';\nexport const B = useNavigate;\n",
      'core/headless/c.ts': "export { X } from '../ui/index.js';\n",
      'core/ui/ok.ts': "import Box from '@mui/material/Box';\nexport const OK = Box;\n",
    });
    try {
      const problems = scanKvoxWebSources(dir);
      expect(problems).toHaveLength(3);
      expect(problems.join('\n')).toMatch(/core\/headless\/a\.ts imports @mui\/material\/Box/);
      expect(problems.join('\n')).toMatch(/core\/headless\/b\.ts imports react-router-dom/);
      expect(problems.join('\n')).toMatch(/core\/headless\/c\.ts imports \.\.\/ui\/index\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the brand slice import the shell headless entry and nothing else of the platform', () => {
    const shell = `@marinoscar/${'platform'}-web/shell/headless`;
    const ui = `@marinoscar/${'platform'}-web/shell/ui`;
    const dir = sandbox({
      'brand/theme.ts': `import { createShellTheme } from '${shell}';\nexport { createShellTheme };\n`,
      'brand/root.ts': `import { ShellRoot } from '${ui}';\nexport { ShellRoot };\n`,
      'core/ui/theme.ts': `import { createShellTheme } from '${shell}';\nexport { createShellTheme };\n`,
    });
    try {
      const problems = scanKvoxWebSources(dir);
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toMatch(/brand\/root\.ts imports .*shell\/ui/);
      expect(problems.join('\n')).toMatch(/core\/ui\/theme\.ts imports .*shell\/headless/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the shell slice import the platform shell and identity entries and nothing else', () => {
    const p = (path: string) => `@marinoscar/${'platform'}-web/${path}`;
    const dir = sandbox({
      'shell/shell.ts': `import { ShellLayout } from '${p('shell/ui')}';\nexport { ShellLayout };\n`,
      'shell/nav.ts': `import type { ShellNavigation } from '${p('shell/headless')}';\nexport type { ShellNavigation };\n`,
      'shell/routes.ts': `import { RequirePermission } from '${p('identity/headless')}';\nexport { RequirePermission };\n`,
      'shell/other.ts': `import { api } from '${p('core')}';\nexport { api };\n`,
      'notes/ui/shell.ts': `import { ShellLayout } from '${p('shell/ui')}';\nexport { ShellLayout };\n`,
    });
    try {
      const problems = scanKvoxWebSources(dir);
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toMatch(/shell\/other\.ts imports .*web\/core/);
      expect(problems.join('\n')).toMatch(/notes\/ui\/shell\.ts imports .*shell\/ui/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the Copilot card to import the platform account sign-in card, and nothing else, there only', () => {
    const card = `@marinoscar/${'platform'}-web/ai/ui`;
    const other = `@marinoscar/${'platform'}-web/settings/ui`;
    const dir = sandbox({
      'copilot/ui/card.ts': `import { A } from '${card}';\nexport { A };\n`,
      'copilot/ui/other.ts': `import { B } from '${other}';\nexport { B };\n`,
      'copilot/headless/h.ts': `import { A } from '${card}';\nexport { A };\n`,
      'search/ui/s.ts': `import { A } from '${card}';\nexport { A };\n`,
    });
    try {
      const problems = scanKvoxWebSources(dir).join('\n');
      expect(problems).not.toMatch(/copilot\/ui\/card\.ts/);
      expect(problems).toMatch(/copilot\/ui\/other\.ts/);
      expect(problems).toMatch(/copilot\/headless\/h\.ts/);
      expect(problems).toMatch(/search\/ui\/s\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in any file that imports a platform package, but not in a comment', () => {
    const platform = `@marinoscar/${'platform'}-web/core`;
    const dir = sandbox({
      'transcription/ui/x.ts': `import { x } from '${platform}';\nexport { x };\n`,
      'transcription/ui/y.ts': `// import { y } from '${platform}';\nexport const y = 1;\n`,
    });
    try {
      const problems = scanKvoxWebSources(dir);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/transcription\/ui\/x\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
