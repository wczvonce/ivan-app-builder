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

## External watchdog + continuator (model-free safety net and wake-up engine)

Every in-agent notification path depends on some model being able to answer, and every in-agent
scheduling path depends on tools this host does not reliably expose (the OpenClaw `cron` tool is
stripped for non-owner senders; Claude Code's `CronCreate`/`ScheduleWakeup` are disabled in the
claude-cli harness; OpenClaw kills the CLI process tree at the end of every turn). A script outside
the agent stack closes both gaps.

On this host: `~/.openclaw/scripts/app-builder-watchdog.js`, run by the Windows scheduled task
`OpenClaw-AppBuilder-Watchdog` every 5 minutes and at logon (interactive logon of the user — it
does not run while nobody is logged on). It talks to the Telegram Bot API directly and drives
the OpenClaw Gateway through the real CLI (`~/MojeAI/node_modules/openclaw/dist/index.js` —
NOT the `openclaw` bash alias, which starts an old checkout).

What it does every cycle:

1. **Continuator (D/E).** For every project under `~/.openclaw/workspace/projects`:
   - `.app-builder/continue-request.json` due (`not_before` passed) → creates a one-shot
     OpenClaw cron job `auto-continue: <project>` (`--declaration-key auto-continue:<project>`
     so a retried add updates instead of duplicating, `--agent app-builder --session
     session:main --at +5s --message "continue <dir> …" --announce --channel telegram --to
     <owner chat> --best-effort-deliver --delete-after-run --timeout-seconds 5400`). The turn
     runs in the agent's main session (serialized with every other turn — verified live), its
     final text is delivered to the user by the runner (`NO_REPLY` stays silent), and a
     delivery failure never fails the job. The request is moved to
     `continue-request.pending-<ts>.json` before the CLI call and to
     `.app-builder/history/continue-request.consumed-<ts>.json` after it; a request whose
     `expected_head` no longer matches HEAD is dropped as `stale` without a turn. Works for any
     non-terminal status, so a `WAITING` run can schedule its own wake-up after a provider
     reset.
   - active status (`PLANNING`/`IMPLEMENTING`/`VERIFYING`/`REVIEW`, or a Solution Factory
     `EXECUTING`/`DISCOVERY`… without an open builder file) unchanged for 20 minutes → the
     same cron job, automatically. Attempts back off 0 → 25 → 45 → 90 minutes; the first
     automatic attempt of an episode sends the user a one-line "🔁 auto-pokračovanie" note;
     after 4 attempts without progress it escalates ("🛑 Auto-pokračovanie nepomohlo"), then
     retries every 3 h and reminds every 6 h. Progress = a change of the `Status:` value or
     of the git HEAD (never a bare mtime); it resets the counters. Three fast-path turns in a
     row without progress also escalate and stop the fast path until progress. Active runs are
     tracked for 72 hours (then one "🪦 opustený" message); waiting states keep 12 hours.
   - Guards before any trigger, in this order: no live `auto-continue:` cron job for ANY
     project (`cron list --all --json`; a disabled leftover is read for its `lastError`,
     removed, and the error goes into the next attempt's reason), no fresh
     `.app-builder/lock.json` (`expires_at`, capped at 100 min after `started_at`/mtime; a
     fresh lock without any running app-builder session is an orphan and is moved to
     `history/`), no running app-builder session (SQLite `audit_events`/`task_runs` of the
     Gateway state DB; `sessions.json` entries with `status: "running"` — `killed`/`timeout`/
     `done` are idle), Gateway reachable, no model outage, no `.app-builder/PAUSE` and no global
     `~/.openclaw/scripts/app-builder-continuator.PAUSE`, at most one trigger per cycle, at
     most 8 triggers WITHOUT progress per project per 24 h and 48 in total (then it writes
     `PAUSE` itself and tells the user; the no-progress window resets on every new commit or
     `Status:` change, so a productive build is never paused by the cap). A `continue-request`
     that would be the third fast-path turn in a row without progress is retired to
     `history/…exhausted…` and the stall path takes over. When it cannot trigger because of a
     pause, the Gateway or a model outage, a run that is 45 minutes stale still gets the classic
     "🛑 sa nehýbe" alert with the reason — the build is never silent, and a request file on
     disk never suppresses an alert. One-shot messages (info, escalation, reminder, frozen,
     Factory closed) that Telegram fails to accept are queued in the state file and re-sent in
     the next cycle.
   - **Frozen contract guard (G):** before triggering, the SHA-256 of the files named in
     `.solution-factory/confirmed_handoff.json` (`spec_file`, `ui_spec_file`) must equal the
     recorded hashes (raw or with CRLF→LF). A mismatch writes `PAUSE` and sends "🧊 Zmrazený
     spec sa zmenil".
   - **Solution Factory closing (H):** when the builder file is `DONE`/`ABORTED` and the
     Factory file is still `EXECUTING`/`REVIEW`/`QA`, the watchdog mirrors the terminal status
     into `run-state.json` (phase `closed by watchdog`) and tells the user.
2. **Outbox (F).** `.app-builder/outbox.jsonl` is moved atomically to a `.processing` file,
   unsent entries are sent to the user's Telegram (max 10 per cycle, prefixed with the project
   name, deduplicated by text hash against `outbox.sent.jsonl` for 24 h), acknowledgements go
   to `outbox.sent.jsonl` (`id`, `message_id`, `sent_at`), and anything unsent is appended back
   to `outbox.jsonl`. The agent's file is never rewritten in place.
3. **Alerts (A/B/C).** Unchanged from before: `BLOCKED`/`WAITING` runs after 90 minutes,
   `WAITING_USER`/`AWAITING_APPROVAL`/`READY_FOR_UAT` after 6 hours (one reminder), corrupt
   Solution Factory JSON (fail-loud), exhausted model fallback chain with the real cause,
   Gateway down twice in a row, plus recovery messages.

Useful commands: `--status` (everything it sees as JSON, incl. `sessionBusy`, `frozen` per
run and the continuator state), `--dry-run` (decide but neither send nor trigger; prints
"spustil by som continue <project>"), `--continue-now <projectDir> [--force]` (manual
trigger; refuses while a turn or a live job exists unless forced), `--test` (one real Telegram
message). Env `WATCHDOG_DISABLE_CONTINUE=1` restores the alert-only behaviour. State lives in
`app-builder-watchdog-state.json` (`alerts`, `continues.<project>` with attempts, triggers,
last job result), written atomically after every trigger; the log in
`app-builder-watchdog.log`. `app-builder-watchdog.test.js` (36 sections, 193 checks) runs
against synthetic projects with a stateful fake CLI (jobs really appear in and disappear from
the register), a throwaway SQLite DB and a file-based Telegram sink — it never touches the
Gateway. The test hooks (`WATCHDOG_TELEGRAM_SINK`, `WATCHDOG_SKIP_GATEWAY`, `WATCHDOG_NOW_MS`)
are honoured only with `WATCHDOG_TEST=1`; in production a stray `WATCHDOG_*` variable is logged
and ignored. The model-outage detector keeps its last verdict in the state file and reads the
two newest daily logs, so the midnight log rotation cannot produce a false "✅ recovered". The
scheduled task runs every 5 minutes with a 10-minute execution limit and `IgnoreNew` (it still
uses the interactive logon principal, so it does not run while nobody is logged on — switch
it to S4U if unattended reboots matter).

Known host facts the continuator works around: the agent's `cron` tool is stripped for
non-owner senders and `CronCreate` is disabled in the claude-cli harness; OpenClaw kills the
CLI process tree at every turn end; a model fallback inside one turn restarts the turn with a
fresh context (2026-09-02: the fallback saw its own `lock.json` as foreign); the agent's
fallback list currently lets the orchestrator drop from claude-opus-4-8 to gpt-6-astra,
then gpt-5.6-sol
silently — a config decision for the owner (`agents.entries.app-builder.model.fallbacks`).

This is why the `Status:` line and the companion files in run-state matter: the continuator
cannot tell a dead run from a working one without them.

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
