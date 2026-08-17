# Setup and recovery runbook

Use official OpenClaw components first.

## Required layers

1. Native Codex runtime for the OpenClaw parent/reviewer.
2. Official ACPX runtime for Claude Code workers.
3. Claude Code authenticated on the same Gateway host.
4. A Git repository and a project-specific worktree.

## Setup checks

Run or ask the operator to run these separately, reviewing each result:

```bash
openclaw plugins install @openclaw/codex
openclaw models auth login --provider openai
openclaw config set plugins.entries.codex.enabled true

openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true

claude auth status
openclaw gateway restart
```

From the Telegram/OpenClaw chat:

```text
/status
/codex status
/acp doctor
```

The App Builder parent should resolve to the native Codex runtime. The ACP doctor must show a healthy backend and the Claude harness must be available.

## Recommended App Builder agent

Use `{baseDir}/config/app-builder.example.json5` as a reviewed merge fragment, not as a replacement configuration. Validate it against the target host's live schema and preserve existing agents, auth profiles, plugins, and channel bindings.

The example uses model-scoped `agentRuntime.id: "codex"` so the App Builder fails closed rather than silently falling back to another runtime. It also gives the parent a `coding` tool profile, limits ACP targets to `claude`, and keeps the ACPX permission default read-only.

If creating the agent by CLI first, use a native Codex model currently available to the account:

```bash
openclaw agents add app-builder \
  --workspace ~/.openclaw/workspace-app-builder \
  --model openai/gpt-5.6-sol \
  --non-interactive
```

Then merge the model-scoped runtime, tools, skills, sandbox, ACP allowlist, and plugin settings from the example fragment. Run `openclaw config validate` before restart. Verify available models with `/codex models` or `openclaw models list --provider openai`; use an available `openai/gpt-*` model if the example model is unavailable.

Do not accidentally reroute the user's normal Telegram assistant. Add a dedicated Telegram bot/topic binding only after reviewing the exact peer/account identifiers.

## Permissions

ACPX sessions are non-interactive. Read-only planning works with restrictive permissions, but unattended write/exec work may require ACPX `permissionMode=approve-all`. Treat that setting as elevated access.

Do not enable it automatically on a personal workstation that contains unrelated private files or production credentials. Prefer a dedicated development machine, VM, container, or restricted OS user first. Then, after explicit operator approval:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
openclaw gateway restart
```

Keep the project `cwd` narrow and do not enable ACP plugin-tools or OpenClaw-tools MCP bridges unless required.

## External watchdog (model-free safety net)

Every in-agent notification path depends on some model being able to answer. When the whole
fallback chain hits its limit, or the Gateway itself is down, no agent can report anything — a
finished or stalled build stays silent until the user happens to ask. A watchdog outside the agent
stack closes that gap.

On this host: `~/.openclaw/scripts/app-builder-watchdog.js`, run by the Windows scheduled task
`OpenClaw-AppBuilder-Watchdog` every 10 minutes and at logon. It talks to the Telegram Bot API
directly, so it needs neither a model nor the Gateway. It alerts on three conditions:

- a run whose `.app-builder/run-state.md` is non-terminal and unchanged for 45 minutes (90 when the
  status is `BLOCKED`/`WAITING`), ignoring files older than 12 hours as abandoned rather than stalled;
- an exhausted model fallback chain (last `model_fallback_decision` has no next candidate and
  nothing succeeded after it), reporting the reset time from the provider's error text;
- a Gateway that fails an HTTP probe twice in a row.

Each condition is reported once per state change, with recovery messages when models or the Gateway
come back. Useful commands: `--status` (print what it sees as JSON), `--dry-run` (decide but send
nothing), `--test` (send one real Telegram message). Detection logic is covered by
`app-builder-watchdog.test.js`, which runs against synthetic logs and never sends messages.

This is why the `Status:` line in run-state matters: the watchdog cannot tell a dead run from a
finished one if the status is missing or never updated.

## Common failures

### ACP doctor is unhealthy

- Confirm `@openclaw/acpx` is installed and enabled.
- If `plugins.allow` exists, include `acpx`.
- If `acp.allowedAgents` is set, include `claude`.
- Set `plugins.entries.acpx.config.probeAgent` to `claude` when needed.
- Confirm the Gateway host has Node/npm and can fetch the first-run Claude adapter.
- Restart the Gateway and run `/acp doctor` again.

### Claude authentication fails

Run `claude auth status` (verified against Claude Code CLI 2.1.x; it prints the login state as JSON). If logged out, run `claude auth login` interactively on the Gateway host with the intended Claude.ai subscription account.

### Claude cannot write or run tests

Do not add raw `--dangerously-skip-permissions` flags. Inspect ACPX permission settings. Move to a restricted development environment before granting `approve-all`.

### Codex runtime is not selected

Use `/status` and `/codex status`. Confirm the official plugin is enabled and the agent's selected `openai/*` model has native Codex routing or an explicit model-scoped `agentRuntime.id: "codex"`. Re-authenticate with `openclaw models auth login --provider openai` when needed.

### Interrupted Claude run

- Read `.app-builder/run-state.md`.
- Use the stored ACP `resumeSessionId` with `sessions_spawn`.
- If it no longer exists, start a new Claude run with a compact handoff: acceptance criteria, current diff, command failures, review findings, and next action.

### Repeated repair failure

Stop after three rounds. Preserve the worktree and report exact evidence. Do not hide the failure by weakening checks or deleting tests.
