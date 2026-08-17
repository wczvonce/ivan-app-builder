# Changelog

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
