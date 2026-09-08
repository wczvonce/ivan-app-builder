# Phase 7: host review runner (1.6.0)

The Windows watchdog runs `app-builder-review.js` outside the orchestrator's model harness.
It executes tests and a fresh read-only reviewer. Writing `PASS` or `DONE` in a project file
does not create a host approval. Install both scripts together in `~/.openclaw/scripts/`.

## Orchestrator workflow

1. Implement the current slice in the existing Claude Code worker and working directory.
2. Keep `Current slice: S1`, `Verification mode: STANDARD|DEEP|FAST` and
   `Orchestrator model: <actual runtime model>` in `.app-builder/run-state.md`.
3. Request a review, release `.app-builder/lock.json`, and finish the turn:

   ```powershell
   node "$HOME/.openclaw/scripts/app-builder-review.js" request --project "C:/path/project" --slice S1 --backend "anthropic/claude-opus-4-8"
   ```

   The request registers the exact isolated worktree even outside the default projects folders;
   no recursive scan of unrelated directories is needed. Add `--final` when the entire agreed
   application is ready. The watchdog starts the host
   runner on its next five-minute tick, after any live worker/continuation has finished.
   For a supervised diagnostic run, use `run --project ...` after `request`.
4. The host runs fresh checks, reviews an isolated snapshot of all source files and records
   the outcome. Check it with `status --project ...` or watchdog `--status`.
5. `changes_requested` creates a continuation request carrying the central findings. The
   orchestrator resumes the existing Claude worker and fixes only those defects. After the
   repair it calls `request` again; tests and independent review run again.
6. `approved` permits the next slice or delivery work. After a final approval and all other
   delivery/acceptance conditions, call `complete --project ...`. Only this command produces
   a host completion receipt and writes `DONE`, including the paired Factory closing state.
7. Send the final outbox report with `kind: "completion"`. The watchdog holds that record
   until host completion is valid. Ordinary progress, questions and failure reports continue
   to use ordinary outbox records. Include the actual reviewer; `same-family` is explicitly weaker.

The worker never writes a host receipt or invokes `complete`. `--force` on the continuator
cannot bypass the review or completion gate. Even FAST requires the host gate before DONE;
FAST can reduce the deterministic test contract, not eliminate independent review.

## Routing and limits

- Default: subscription-authenticated `codex exec review`, read-only, fresh ephemeral session.
  It reviews the complete snapshot and the agreed spec, even when Git has no uncommitted diff.
- Known GPT orchestrator fallback: skip nested Codex and start pinned Fable immediately.
  An actual nested-Codex decline also moves directly to Fable. No private-repository policy
  is invented. Codex HTTP 401 gets exactly one retry after 30 seconds.
- Fable: fresh `acpx --model claude-fable-5 --approve-reads
  --non-interactive-permissions deny --no-terminal --allowed-tools Read,Glob,Grep ... claude exec`.
- Only after both routes are unavailable may a fresh read-only Claude CLI session perform
  the weaker adversarial review. A completed HOLD is a finding, never provider unavailability.
- DEEP adds Fable after successful Codex. If that required additional review cannot finish,
  the gate remains pending; a weaker reviewer cannot erase the requirement.
- Tests or HOLD allow at most 3 repair rounds per slice and 8 per run. Counters survive
  source changes and new review requests. A new slice does not reset the run counter.
- Each subprocess has an 8-minute limit; the whole review has a 35-minute limit. Heartbeats,
  an OS-owned SQLite exclusive lock, process-start identity and bounded recovery handle interrupted runners.
- Provider failures remain `needs_attention` and get at most two additional attempts, one
  hour apart. No usable review means no DONE. After fixing a concrete setup/auth problem,
  `request --retry --project ...` allows a deliberate retry without resetting repair counters.
- Existing WAITING_USER/PAUSE and frozen-spec rules are preserved. Review never authorizes
  deployment, scheduler changes or other actions still waiting for user approval.

## Deterministic checks and evidence

The host discovers pytest, npm test/build, or Node test-runner tests. It rejects zero-test
results. Other supported checks must be registered once using `configure --project ...
--checks-file checks.json`. Example:

```json
[{"type":"node-test","paths":["test/app.test.js"]}]
```

Supported types: `pytest`, `node-test`, `node-script` (an existing test entrypoint), and `npm`
(`script` and boolean `test`). There is no arbitrary shell command interface. The contract
is frozen outside the project; replacing it requires an explicit maintainer review. Tests
must emit real result counts. Build success alone cannot approve an application. A framework
the runner cannot verify remains needs-attention until its test adapter is implemented.

Host evidence lives under `~/.openclaw/state/app-builder-review/<project-hash>/`: current
state, immutable run directories with checks and route attempts, parsed review and signed
approval/completion receipts. Source hashes include tracked and untracked non-ignored code;
runtime state and build outputs are excluded. Any source edit invalidates prior approval.
Review snapshots reject credential files and links escaping the project. Model output is
parsed as a strict verdict/findings object (native Codex priority comments become HOLD); hidden thought streams are not published.

Subscription login is verified before model invocation. API keys, provider overrides and
interactive Git credentials are removed from subprocess environments. No API billing is enabled.
The receipt key stays on this machine and must never enter a project, archive or Git commit.

The gate prevents accidental model self-approval through the supported workflow. It is not
an OS security boundary against an administrator or an agent with unrestricted access to the
host signing key. Enforce separate OS permissions if hostile local writers are in scope.
No finite set of tests or reviews guarantees a bug-free application.

## Installation and migration

Use Node 24 with its built-in SQLite support (the tested runtime on this host). Copy the
runner before the watchdog, then update the skill and merge
[`host-workspace-rules.md`](host-workspace-rules.md) into the dedicated agent's
AGENTS.md. The existing five-minute scheduled task remains the entrypoint; no new scheduler
or gateway restart is needed for the scripts. The updated skill/workspace rules apply on the
next agent turn. Historical runs already independently audited may have an explicit local
legacy baseline registered by the maintainer. That baseline matches the exact old source and
run-state hashes, is not a new review, and expires on either change. New DONE claims always
require host evidence. Never automatically import a model's PASS as a baseline.

Run the regression suites before deploying:

```powershell
node --test scripts/app-builder-review.test.js
node scripts/app-builder-watchdog.test.js
```

Tests use temporary projects, fake provider responses and a fake gateway/Telegram sink.
Live provider checks are separate, explicitly identified diagnostic runs.
