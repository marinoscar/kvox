# Working with Claude Code and OpenCode

> **Audience:** engineers using AI assistants on this repository · **Rules:** [AGENTS.md](../AGENTS.md) · **Guard:** `apps/api/test/ai-assistant-config.spec.ts`

Two assistants work on this repository: Claude Code (Anthropic models) and OpenCode (a local open-weight model on llama.cpp). Both read one shared rule set, `AGENTS.md`. This page says which tool to pick, where each file lives, how to run the local model and how to keep the two in step.

Items marked **verify** depend on the tool version you run. Check them against the tool's own docs before relying on them.

## 1. Overview and decision

| Task | Tool |
|---|---|
| Large or cross-cutting change (API + web + database) | Claude Code |
| Schema migrations or security-sensitive work (auth, RBAC, secrets) | Claude Code |
| Reading large docs, architecture questions, review | Claude Code |
| A scoped task in one area (one endpoint, one component, one test file) | OpenCode, local model |
| Mechanical work (typecheck, rebuilds, small doc fixes) | OpenCode, local model |
| Offline or no-data-egress work | OpenCode, local model |

Rule: **`AGENTS.md` is the single shared rule set.** Edit rules there. Never copy a rule into `CLAUDE.md`, an agent file or `opencode.json`.

## 2. File map

| File | Read by | Purpose | Size budget |
|---|---|---|---|
| `AGENTS.md` | OpenCode (preferred rules file); Claude Code via `CLAUDE.md` | Shared rules: structure, every MANDATORY section, commands | 24 KB |
| `CLAUDE.md` | Claude Code | Starts with `@AGENTS.md` (an import), then Claude-only content: the full docs table, delegation rules, cloud-session exception. Each nested `apps/*/CLAUDE.md` contains only `@AGENTS.md` | none |
| `apps/api/AGENTS.md`, `apps/web/AGENTS.md`, `apps/cli/AGENTS.md` | OpenCode, when working in that folder | Area rules | 6 KB each |
| `.claude/agents/*.md` | Claude Code | Subagents: frontmatter `name`, `description`, optional `model` | none enforced |
| `.opencode/agents/*.md` | OpenCode | Subagents: frontmatter `description`, `mode`, `temperature`, `steps`, `permission` | 6 KB each |
| `.claude/skills/<name>/SKILL.md` | Claude Code; OpenCode also reads `.claude/skills` | On-demand recipes (`add-job-type`, `add-settings-page`, `new-project`, `rename-app`) | none |
| `.claude/settings.json` | Claude Code | `permissions.allow` list (read-only git, test and typecheck commands) | none |
| `opencode.json` | OpenCode | Model, provider, compaction, watcher, permissions | none |

Load order:

1. **Claude Code**: `CLAUDE.md` loads, `@AGENTS.md` inlines the shared rules, agents and skills load on demand.
2. **OpenCode**: `AGENTS.md` loads, nested `AGENTS.md` files are read when you work in their folder (lazy loading, **verify** for your version), agents and skills load on demand.

Notes:

- OpenCode falls back to `CLAUDE.md` only when no `AGENTS.md` exists. Here `AGENTS.md` exists, so `CLAUDE.md` is ignored by OpenCode.
- Keep `instructions` out of `opencode.json`. It would load extra files into every session.
- OpenCode's Claude Code compatibility can be switched off with environment variables: `OPENCODE_DISABLE_CLAUDE_CODE` (everything), `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` (`CLAUDE.md`), `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` (`.claude/skills`). **Verify** the names in your version.

## 3. Claude Code vs OpenCode

| Aspect | Claude Code | OpenCode |
|---|---|---|
| Rules file | `CLAUDE.md` (imports `@AGENTS.md`) | `AGENTS.md` |
| Agent location | `.claude/agents/` | `.opencode/agents/` |
| Agent frontmatter | `name`, `description`, `model` alias (`sonnet`, `haiku`), `tools` | `description`, `mode: subagent`, `temperature`, `steps`, `permission` (name comes from the file name) |
| Skills | `.claude/skills/<name>/SKILL.md`, name = directory | Same folder is read; skill loads on demand through the skill tool |
| Commands | Slash commands, built in or from skills | Slash commands; custom ones in `.opencode/commands/` (none here) |
| Hooks and plugins | Hooks in `settings.json` (none here) | JS/TS plugins with events such as `tool.execute.before` (none here) |
| Permissions | `permissions.allow` in `.claude/settings.json` (allow-list of tool patterns) | `permission` in `opencode.json` and in agent frontmatter |
| Permission order | Deny, then ask, then allow | Patterns are matched in order and the **last matching rule wins**, so `"*": ask` goes first. **Verify** in your version |
| Context | Large (model dependent) | 98,304 tokens here (`limit.context`), output 16,384 |
| Concurrency | Several subagents, limited by your plan | Up to 4 agents, bounded by llama-server slots and memory |
| Models | Anthropic only | `local/local-coder` for `model` and `small_model` |

Existing settings in this repository:

- `.claude/settings.json` allows `git status*`, `git diff*`, `git log*`, `npm run typecheck*`, `npm test*`, `npm run test:run*`, `npm run check:*`.
- `opencode.json` asks before `git push*`, `git commit*`, `rm -rf*` and `webfetch`.
- `.opencode/agents/*` allow read-only git and test commands, deny state-changing git (commit, push, checkout, merge, worktree and similar) and ask for other bash commands. `ops-dev` also sets `edit: deny`.

## 4. Local model setup (AMD Strix Halo)

### 4.1 Start llama-server

```bash
llama-server \
  -m /models/Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf \
  --alias local-coder \
  --jinja \
  -fa on \
  --parallel 2 \
  -c 196608 \
  --port 8080 \
  --host 127.0.0.1
```

| Flag | Why |
|---|---|
| `--alias local-coder` | Required. `opencode.json` selects the model `local/local-coder`; the alias must match the key under `provider.local.models`. |
| `--jinja` | Uses the model's chat template, which tool calling needs. |
| `-fa on` | Flash attention. Older builds take `-fa` with no value. |
| `--parallel N` | Number of slots (concurrent requests). |
| `-c` | **Total** context, shared by all slots. Per-slot context is `-c / N`. |
| `--port 8080` | Matches the base URL below. |

Context rule: `-c` = 98304 x slots.

| Slots | `-c` |
|---|---|
| 1 | 98304 |
| 2 | 196608 |
| 4 | 393216 |

If `-c` is too small for the slot count, each slot gets less than the 98,304 that `opencode.json` assumes and requests fail or truncate.

The model file name above is an example. Use the Qwen3-Coder or Qwen3.x MoE **Instruct** build you have. Flag spellings change between llama.cpp builds (**verify** with `llama-server --help`).

### 4.2 Point OpenCode at it

`opencode.json` reads the base URL from the environment:

```bash
export OPENCODE_LOCAL_BASE_URL=http://127.0.0.1:8080/v1
```

For machine specifics, put the override in `~/.config/opencode/opencode.json` instead of the repository file:

```json
{
  "provider": {
    "local": {
      "options": { "baseURL": "http://192.168.1.50:8080/v1" }
    }
  }
}
```

Never put a host name or address into the repository `opencode.json`.

### 4.3 Check tool support

```bash
curl -s http://127.0.0.1:8080/props | head -c 2000
curl -s http://127.0.0.1:8080/v1/models
```

- `/props` shows the loaded chat template. It should be a Qwen template that mentions tools.
- `/v1/models` should list `local-coder`.

### 4.4 Model and template

- Use an **Instruct** build (Qwen3-Coder, or a Qwen3.x MoE Instruct). Avoid thinking-mode builds for agent work.
- Use the official chat template shipped in the GGUF with `--jinja`. A custom template is the usual cause of tool-call failures.
- Keep `temperature` low. The agent files use 0.1.

### 4.5 Known tool-call failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Tool call printed as text, never executed | Missing `--jinja`, wrong template, or old llama.cpp | Add `--jinja`, use the official template, update llama.cpp |
| JSON parse error on a file write | Large argument, model truncated or mis-escaped the JSON | Ask for smaller edits; prefer Edit over Write for big files; raise `limit.output` only if the output is cut |
| Long stall, no output | Thinking mode generating a long reasoning block | Use the Instruct build; do not enable thinking |
| Repeating the same tool call | Context near full | `/compact` or start a new session |
| 400 error about context | `-c` smaller than slots x 98304 | Fix the `-c` formula in 4.1 |

### 4.6 Memory math

Memory = weights + KV cache. The KV cache grows with total context (`-c`), which is slots x per-slot context.

- Weights are fixed by the quantization you choose.
- Each added slot adds 98,304 tokens of KV cache.
- Four slots at 96K is a 393K-token cache. Check it fits in the 128 GB unified memory beside the weights and the OS.
- If it does not fit: reduce slots, quantize the KV cache (`--cache-type-k` / `--cache-type-v`, **verify**), or use a smaller quant.

I have not measured the figures for your model. Watch memory while loading and under load.

### 4.7 Moving to ROCm and vLLM

The path is: same OpenAI-compatible endpoint, different server.

- Keep the provider block. Change only `OPENCODE_LOCAL_BASE_URL` and the served model name.
- vLLM tool calling needs `--enable-auto-tool-choice --tool-call-parser qwen3_coder`. **Verify** the parser name for your vLLM version and model.
- vLLM names the model with `--served-model-name`; set it to `local-coder` so `opencode.json` needs no change.
- Re-tune after the move: context (`--max-model-len`), concurrency (`--max-num-seqs`), memory fraction (`--gpu-memory-utilization`), quantization, and the tool-call parser. Re-run the failure checks in 4.5.

## 5. Working within 96K tokens

| Practice | How |
|---|---|
| One agent at a time by default | The main agent plans; one subagent works. Use 2 or 3 in parallel at most, 4 is the ceiling |
| One worktree per agent | `git worktree add worktrees/<short-name> -b <type>/<short-name>`; never two agents in one tree |
| Read docs by section | `grep -n '^#' docs/<file>.md`, then Read with `offset` and `limit` |
| Never read whole | `docs/ARCHITECTURE.md`, `docs/SECURITY-ARCHITECTURE.md`, a spec |
| Hand over a pointer | Give the subagent the doc path and section, not the text |
| Compaction | `opencode.json` sets `compaction.auto`, `prune` and `reserved: 8000`. Run `/compact` by hand when a session gets long |
| Skills | Load on demand; only the name and description sit in context |
| Area rules | Nested `AGENTS.md` files hold area rules, so root `AGENTS.md` stays small |

OpenCode differs between versions (for example in how nested `AGENTS.md` files and compaction settings are handled). **Verify** with the version you run: check that a nested `AGENTS.md` loads when you open a file in its folder, and that the settings in `opencode.json` are accepted without a warning.

## 6. Maintenance

| Change | Do this |
|---|---|
| Change a rule | Edit `AGENTS.md` (or the nested one for an area). Keep `AGENTS.md` at 24 KB or less and nested files at 6 KB or less |
| Claude-only content | Edit `CLAUDE.md` below the `@AGENTS.md` line |
| Add or change an agent | Edit **both** `.claude/agents/<name>.md` and `.opencode/agents/<name>.md`; keep `.opencode/agents` files at 6 KB or less. The parity tripwire fails when the sets differ |
| Add a skill | Create `.claude/skills/<name>/SKILL.md`; `name` in the frontmatter equals the directory name |
| Add a doc | Link it from [docs/README.md](README.md) |
| `opencode.json` | Keep it free of `instructions` |

Guards:

- `apps/api/test/ai-assistant-config.spec.ts` enforces the budgets and agent parity. It may be absent in a checkout that predates it.
- `apps/api/test/docs-links.spec.ts` checks relative links in the docs, and also in `AGENTS.md` files, `.opencode/agents/*.md` and `.claude/skills`. It ignores anchors, so check `AGENTS.md#...` slugs by hand.

```bash
cd apps/api && npm test -- test/ai-assistant-config test/docs-links
wc -c AGENTS.md CLAUDE.md apps/*/AGENTS.md .opencode/agents/*.md .claude/skills/*/SKILL.md
diff <(ls .claude/agents) <(ls .opencode/agents) && echo parity-ok
```

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| OpenCode: "model not found" | `--alias` does not match `local-coder` | Restart llama-server with `--alias local-coder` |
| OpenCode: connection refused or empty URL | `OPENCODE_LOCAL_BASE_URL` unset or wrong | Export it (4.2) and check `curl $OPENCODE_LOCAL_BASE_URL/models` |
| Tool calls appear as text | No `--jinja` or wrong template | See 4.5 |
| Slow or stalled replies | Thinking mode, or memory swapping | Use Instruct build; check memory (4.6) |
| Context errors on long sessions | `-c` below slots x 98304, or session too long | Fix `-c`; `/compact`; new session |
| OpenCode ignores a rule | Rule is only in `CLAUDE.md` | Move it to `AGENTS.md` |
| Claude Code ignores a rule | Import broken | `CLAUDE.md` must start with `@AGENTS.md` |
| A prompt appears for a command you expected to be allowed | Pattern order or agent `permission` | Check the agent file; **verify** last-match-wins (section 3) |
| Agent exists for one tool only | Parity broken | Add the other file (section 6) |
| Budget test fails | A file grew past its budget | Trim it; move detail into `docs/` and link it |
| Link test fails | Broken relative link | Fix the path; links resolve from the containing file |
