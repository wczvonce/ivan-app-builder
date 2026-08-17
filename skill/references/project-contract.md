# Project contract guidance

The contract is a compact source of truth shared by the user, Codex, and Claude Code. For a new application, it may be finalized only after the discovery interview and explicit product confirmation.

## APP_SPEC.md should contain

- Confirmation status, specification version, timestamp/channel, and a short normalized confirmation record
- Product goal and target users
- Roles and permission boundaries
- Core user journeys, including important alternate/error paths
- First-release MVP scope, later ideas, and explicit non-goals
- Main screens/modules and visible behavior
- Data entities, fields, ownership, visibility, lifecycle, and deletion/history rules
- Required integrations, imports, exports, notifications, files, and automation
- Platform/device/offline/language/UX expectations
- Security/privacy, backups, and audit expectations
- Operational and recurring-cost constraints when relevant
- Confirmed reversible assumptions
- Observable acceptance criteria by milestone
- Open product decisions

Do not mark the specification `CONFIRMED` until the parent agent has sent the written understanding and the user has explicitly approved it. Corrections create a new draft version that must be reconfirmed before implementation.

## CLAUDE.md should contain

- Stack and architecture boundaries selected after product confirmation
- Directory map
- Canonical commands for format, lint, typecheck, test, build, dev, and migrations
- Coding and UI conventions
- Test expectations
- Environment-variable policy
- Prohibited actions: production access, secret changes, deploy/merge, destructive migration
- Generated files that must not be edited manually

## TASKS.md should contain

- Milestones and vertical slices derived from the confirmed MVP
- Status: TODO / IN PROGRESS / BLOCKED / REVIEW / DONE
- Acceptance criteria link or summary
- Branch/worktree when active
- Deterministic verification result
- Remaining decision or risk

Keep the contract current, but do not duplicate the codebase. Never silently expand or shrink the confirmed MVP.
