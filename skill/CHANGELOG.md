# Changelog

## 1.6.2 — 2026-09-08

- Fable discovery now supports the current ACPX package layout (`node_modules/acpx`) as well
  as the older nested layout, so the documented pinned read-only fallback actually starts.

## 1.6.1 — 2026-09-08

- The host Codex reviewer is pinned to GPT-6 Astra with high reasoning. The older desktop-bundled
  CLI cannot run Astra, so Codex 0.153.4 is installed through npm on Windows and in WSL. The
  runner uses an isolated `codex exec` session with the review contract and JSON
  schema. On Windows it runs in the Ubuntu 24.04 WSL2 read-only sandbox, avoiding the native
  Windows restricted-token failure while retaining enforced read-only access. Login remains
  ChatGPT subscription-backed; no API billing is enabled.
- The app-builder's first approved GPT orchestrator fallback is now Astra. GPT-5.6 Sol stays
  behind it as the next fallback. Claude Opus remains primary and Claude Code remains the
  implementer, so the normal cross-vendor Astra review stays independent.
- When Astra is the active orchestrator fallback, Phase 7 starts Fable instead of asking
  Astra/Codex to review its own orchestration.
## 1.6.0 — 2026-09-08

- Added a host-owned Phase 7 runner: fresh deterministic checks, isolated source snapshots,
  subscription-authenticated Codex/Fable review, parsed findings, signed approval and completion.
  Source edits invalidate old approval; model-written PASS/DONE is not sufficient.
- Watchdog now queues and launches real review outside the orchestrator harness, resumes only
  focused repairs after HOLD, and gates continuation, Factory closing and completion outbox records.
- GPT fallback starts pinned Fable; structural decline also routes to Fable. Codex 401 gets
  one delayed retry. A completed HOLD never falls through to a more lenient reviewer.
- Persistent 3/slice and 8/run repair limits, process timeouts, heartbeat/lock recovery and
  bounded provider retries prevent silent hangs and unbounded repair loops.
- Added deterministic runner and watchdog integration tests. Live diagnostics separately
  verified a real Codex approval and a real pinned Fable approval on the small euro-split app.
- Installation now includes both scripts and current agent workspace rules. Existing audited
  historical results can retain exact local baselines; new completions require host evidence.

## 1.5.5 — 2026-09-07

- Watchdog now detects GPT-backend → same-family review without an earlier, recorded pinned
  Fable attempt for the current slice; DEEP same-family bypasses are checked as well. Fable
  evidence records the actual read-only acpx command, outcome, exit code/output (or elapsed
  timeout). Mentions, plans, malformed records and other slices' attempts do not satisfy it.
- Review violations block the watchdog's continuator, manual `--continue-now --force`, and
  Solution Factory closing duty. Status/logs expose the reason and recorded backend. This
  does not launch Fable itself, interrupt workers, or attest to the truth of model-written logs.
- DONE without a review result remains visible after 24 h; mere tool/reviewer keywords or
  failed/pending Codex commands no longer count as completed review. Existing successful
  legacy review summaries remain supported; FAST and aborted/canceled runs remain exempt.
- Phase 7 fixes the contradictory "step 2/3" wording to mandatory step 2 and documents the
  per-slice `Review attempt` evidence contract. Regression tests cover ordering, invalid and
  stale evidence, backend attribution, deduplication and both continuation/closing paths.
- Audit: the five existing builder run-states had no newer review entries. `test-euro-split`
  still claimed DONE with zero review; its state is corrected to BLOCKED / REVIEW-pending /
  needs-attention, preserving the implementation history. No independent app review is claimed.

## 1.5.4

- Watchdog (`app-builder-watchdog.js`): new review-gate check. A build that reaches `DONE` in
  STANDARD or DEEP verification mode with NO trace of an independent review anywhere in
  run-state.md (no "codex review", "adversarial", "reviewer", "0 BLOCKER", "Fable review",
  "review round", …) now raises an alert — the implementer likely self-approved its own work,
  which the review gate exists to prevent. Found live on 2026-09-04 by a deliberate integration
  test (test-euro-split): the agent implemented a tiny app in one turn, ran pytest, and marked
  DONE without ever invoking codex review. FAST mode (no separate review required) and ABORTED
  runs are skipped; verification mode is read from run-state or the confirmed handoff; DONE runs
  older than 24 h are ignored. The gate itself is still instruction-driven — this only detects
  and reports a skip, it does not enforce.

## 1.5.3

- Phase 7 (Codex review): diagnosed why cross-vendor `codex review` "always failed" on
  nehnutelnosti-tracker (S0→S7 all shipped on the weak same-family reviewer). It was never a
  security policy. Two distinct real failures, from the raw logs: (a) a transient HTTP 401
  auth rejection at S1 during a model switch — a retry ~30 s later succeeds (verified); and
  (b) `{"status":"declined"}` with zero run whenever the orchestrator had fallen back to the
  GPT backend (`gpt-5.6-sol`), because Codex's `approval:never` sandbox refuses a nested
  `codex` process (`mirrorOrigin: codex-app-server`). The S1 failure was mis-summarised as
  "blocked by security policy for private-repo transmission" and then copied verbatim into
  S2…S7 without codex ever being retried. Phase 7 now: test codex fresh every slice (never
  carry a stale "blocked" belief), record the actual error, retry once on 401, and when on the
  GPT fallback backend skip straight to the pinned Fable acpx reviewer with the correct reason —
  noting this is a side effect of the approved silent opus→gpt-5.6-sol fallback (review
  independence silently drops to same-family whenever that fallback is active).

## 1.5.2

- Watchdog (`app-builder-watchdog.js`): a model outage is no longer a one-way street. The
  outage flag clears only on positive evidence (a successful turn in the gateway log), but
  while the continuator refused to trigger anything during an outage, no such evidence could
  ever appear — on 2026-09-03 nehnutelnosti-tracker sat idle for 3.5 h after the Claude limit
  had actually reset at 18:20. The continuator now allows one probe turn 30 min after the last
  failure/probe, and not before the reset time the provider names in its error ("resets 6:20pm"),
  then backs off again; `--status` shows `outage.probe.notBefore`.
- Watchdog: `cron add` over a stale *disabled* job (the gateway disables a one-shot job whose
  turn failed) only upserts it and leaves `enabled:false`. The regular cycle cleaned such jobs up
  first, but `--continue-now` did not, and the cycle never reached the cleanup while an outage
  short-circuited it — so a manual restart after the outage failed twice. `triggerContinue` now
  removes the disabled job and retries the add once, on every path.
- Watchdog: `lost-report` check (2026-09-03) — if the newest `message` call went to an
  `agent:app-builder:*` session key (internal-ui, never Telegram) and no real `telegram:direct`
  send or outbox delivery followed within 15 min, the user is told directly, in any run phase.

## 1.5.1

- Hardened the turn-start lock check (Phase "Turn budget and continuation", point 1): an
  orchestrator turn may no longer decide on its own that a foreign fresh lock's owner is "not
  plausibly running" — that guesswork is what let two orchestrator sessions (`fa`/`fb`) both
  drive nehnutelnosti-tracker's S3 concurrently on 2026-09-03, each spawning its own worker into
  the same tree (colliding/duplicate files, caught and archived to `.app-builder/history/` only
  because the second session happened to notice). The rule now requires calling `ListAgents` and
  treats any live peer, or the *inability* to positively rule one out, as reason to stand down.
  Reclaiming a stale lock is exclusively the external watchdog's job (it has real cross-session
  visibility via the gateway's SQLite audit log); an orchestrator turn only ever claims a lock
  with a past `expires_at` or no lock file at all. Also added an explicit mid-turn tripwire: if a
  turn discovers uncommitted changes or a lock it did not write, it stops and escalates to the
  user instead of trying to out-race or merge with the peer.

## 1.5.0

- Replaced the never-executable in-agent "continuation insurance" cron (1.4.1) with a
  host-executable protocol driven by the external model-free continuator
  (`app-builder-watchdog.js`, Windows task every 5 min): the agent writes
  `.app-builder/continue-request.json` at the end of every unfinished turn and holds
  `.app-builder/lock.json` while working; the continuator sends `continue <dir>` as a one-shot
  OpenClaw cron turn (session `agent:app-builder:main`, no delivery, 5400 s budget), also
  automatically after 20 quiet minutes of an active run, with backoff, escalation to the user
  after 4 failed attempts, and a 72 h window instead of 12 h. Motivated by nehnutelnosti-tracker
  2026-09-02: the last turn was killed by the 1800 s timeout, no cron ever existed, the
  watchdog alerted once at 02:53 and stayed silent, and the build sat idle for a day.
- Added the "no background work inside a turn" host fact (OpenClaw kills the claude-cli process
  tree at every turn end) and the ~20-minute turn-sizing rule.
- Added `.app-builder/outbox.jsonl`: user-facing messages the `message` tool cannot deliver are
  written there and sent by the watchdog directly through the Telegram Bot API; `message` must
  always be called with explicit `channel: "telegram"` + `target` (never `chatId`).
- Added the Solution Factory closing duty to State and recovery, extended the `Status:`
  vocabulary with `WAITING_USER`/`WAITING_PROVIDER`/`READY_FOR_UAT`, required the literal
  `Next action:` line and a `delivered_via:` record, and documented `.app-builder/PAUSE`.
- After an adversarial design review and a live run: continuator turns run in `session:main`
  (serialized; `--session-key` alone ran in an isolated cron session), are created with an
  idempotent `--declaration-key`, deliver their final text to the user via the runner
  (`NO_REPLY` convention), and a live `auto-continue:` cron job is the primary mutual
  exclusion. Progress is git HEAD / `Status:` value (not mtime), fast-path loops without
  progress escalate after 3, a daily cap of 8 triggers per project auto-pauses, orphaned
  locks (owner turn ended — e.g. after an in-turn model fallback) are moved to
  `.app-builder/history/`, frozen spec hashes from `confirmed_handoff.json` are enforced
  (mismatch → PAUSE), an open Factory state is closed when the builder is terminal, and the
  outbox is processed without rewriting the agent's file. Skill: commit WIP every ~15 min,
  no destructive git in auto turns, treat every turn as memoryless.
- After the second (code-level) adversarial review, confirmed by simulation: the daily cap
  counts only triggers without progress (plus a hard 48/24 h backstop), an exhausted fast-path
  request is retired so the stall path and its alerts keep working, one-shot Telegram messages
  that fail to send are queued and replayed, orphaned locks are removed only with positive
  SQLite evidence, a disabled job that cannot be removed blocks a new add (declaration-key
  upsert would keep it disabled), CLI output with a prefix line is parsed, Telegram calls time
  out after 15 s, test hooks require `WATCHDOG_TEST=1`, and the model-outage verdict survives
  the midnight log rotation. Verified live 2026-09-02 22:33–23:14 on nehnutelnosti-tracker:
  4 continuator turns in `session:main`, 2 WIP commits, reports 3932/3933 delivered, the run
  correctly parked in `WAITING_USER` with a question for the user.

## 1.4.4

- Added a delivery gate: a send is only "delivered" when the result names a real channel or
  message id; an internal-ui reply is a FAILED delivery. The run may not enter a
  waiting-for-user status on an unverified send, and run-state must record how the message
  was delivered. Motivated by 2026-09-02 (nehnutelnosti-tracker), where four mockups went to
  internal-ui, the user received nothing, and the run waited indefinitely.

## 1.4.3

- Phase 5 now matches this host: the ACP write route ("requester disallows apply_patch" since
  the orchestrator moved to Claude on 2026-08-27) is documented as broken, the implementer
  runs as a native subagent, and the stale "ACP enabled for app-builder" note is marked
  superseded. Added a "verify before you report" rule — a spawn must be confirmed running
  before the parent announces delegated work (a phantom spawn left the 2026-09-01
  nehnutelnosti-tracker visual stage asleep with empty output folders).

## 1.4.2

- Rewrote the Phase 7 reviewer order for the post-2026-08-27 reality (parent agent runs on
  Claude, not Codex): primary reviewer is the detached `codex review` CLI with an exact
  command, DEEP adds the pinned Fable acpx review, a same-family Claude subagent is an
  explicitly-labelled fallback only, and no-review means Status stays at REVIEW. Motivated
  by the 2026-08-30 run that shipped with zero independent review.

## 1.4.1

- Added continuation insurance between slices: after each slice verification the parent
  schedules a one-shot `continue` cron nudge (~10 min) until the run is DONE/ABORTED, with
  strict no-op semantics when the run already advanced. Motivated by a lost subagent
  completion announce (gateway timeout) that left a run asleep between slices on 2026-08-30.

## 1.4.0

- Added Phase 0.0: acceptance of a Solution Factory `confirmed_handoff.json` (artifact +
  SHA-256 of the approved spec + complete approval record) — a valid handoff satisfies
  Phase 0 without repeating discovery; anything less falls back to the full legacy gate.
- Added optional role parameters from the handoff (`implementer`, `reviewer`,
  `deep_reviewer_model`): `implementer: codex` delegates implementation to a fresh Codex
  subagent session and moves independent review to a fresh Claude Code ACP session (with
  optional pinned model, e.g. claude-fable-5, via the read-only acpx route). Without
  parameters the skill behaves exactly as 1.3.2.

## 1.3.2

- Required an explicit `Status:` line in `.app-builder/run-state.md` with a fixed vocabulary, kept current at every phase change, so an external watchdog can tell a dead run from a finished one.
- Documented the model-free external watchdog in the setup and recovery runbook: what it detects (stalled run, exhausted model fallback chain, dead Gateway), why in-agent notifications cannot cover those cases, and how to inspect it.

## 1.3.1

- Added mobile device verification for native and cross-platform mobile apps: app-type classification (WEB / ANDROID / IOS / CROSS-PLATFORM), mandatory mobile smoke test on Android Emulator / iOS Simulator, feature-specific flow testing, visual checks, evidence requirements, per-mode mobile rules, NOT RUN reporting, physical-device safety rules, and mobile findings counted against the existing repair budget.

## 1.3.0

- Added per-run repair budget and escalation.
- Added FAST / STANDARD / DEEP verification modes.
- Added browser/UI verification requirements for web apps.
- Fixed discovery smoke-test wording.
- Unified confirmation semantics.
- Updated manifest/documentation and Claude CLI auth command.

## 1.2.0

- Added mandatory product-discovery interview for every new app.
- Added 4–7 question adaptive Telegram rounds instead of a generic questionnaire.
- Added explicit written-understanding and confirmation gate before any repository, dependencies, architecture finalization, or Claude Code implementation.
- Added confirmed-spec metadata and state tracking.
- Added rules for reopening confirmation only when a material product decision changes.
- Added installation dry-run that verifies no coding starts before confirmation.
