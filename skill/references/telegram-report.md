# Telegram conversation and report templates

Always answer in the user's language and make questions easy to answer on a phone.

## Delivery is not "sent" — verify it (hard rule)

Every message that asks the user for a decision must be CONFIRMED DELIVERED before the run
records that it is waiting for him. Read the send result:

- Call the tool with the explicit shape
  `message {action: "send", channel: "telegram", target: "<configured-telegram-chat-id>", message: "<text>"}`
  (attachments via the tool's media field). Never pass `chatId`, never omit `channel`/`target`:
  the app-builder session's own conversation is `webchat`/internal-ui, so a default-target
  send goes nowhere the user can see. This is exactly how the 2026-09-02 mockups were lost.
- *"Sent visible reply to the current source conversation via internal-ui"* = it went to an
  internal conversation, **not to Telegram**. That is a failed delivery, not a sent message.
- Real delivery identifies the channel/chat or returns a Telegram message id.
- On failure (tool error such as "Unable to connect", missing tool, no message id): append the
  full text as one line to `<project>/.app-builder/outbox.jsonl`
  (`{"ts": "<ISO>", "text": "<message>"}`) and record `delivered_via: outbox`. The model-free
  watchdog (`~/.openclaw/scripts/app-builder-watchdog.js`, every 5 min) sends unsent lines to
  the user's Telegram and marks them `"sent": true` with the message id. Attachments cannot go
  through the outbox — describe them and name the file paths instead. Relaying through the main
  agent (`sessions_send` to `agent:main:telegram:direct:<configured-telegram-chat-id>`) is an optional extra only
  when that tool is actually available in the current harness; it is never a substitute for the
  outbox line.
- Never set `Status:`/run-state to a waiting-for-user value on an unverified send, and record
  how it was delivered (`telegram:<msg id>` / `outbox` / `relayed-by-main` / `FAILED`).

Why this is a hard rule: on 2026-09-02 (nehnutelnosti-tracker) four dashboard mockups were
"sent", every send landed in internal-ui, the user got nothing, and the run sat in
`WAITING_USER` waiting for an answer to a message that never existed.

## First discovery response

```text
🏗️ Rozumiem tomu zatiaľ takto:
[one-sentence interpretation]

Aby som nevytvoril inú aplikáciu, než potrebujete, doplňte prosím:

1. [high-impact question, optionally A/B/C]
2. [high-impact question]
3. [high-impact question]
4. [high-impact question]
5. [high-impact question]

Odpovedzte pokojne stručne pod čísla. Keď niečo neviete, napíšte „neviem“ a odporučím najpraktickejšiu možnosť. Programovanie zatiaľ nespúšťam.
```

Ask 4–7 adaptive questions. Never ask something already answered.

## Follow-up discovery round

```text
Zatiaľ máme dohodnuté:
- [settled fact]
- [settled fact]

Potrebujem ešte vyriešiť:

1. [remaining material question]
2. [remaining material question]
3. [remaining material question]
```

## Product confirmation gate

```text
📋 Takto som aplikáciu pochopil

Cieľ:
[one sentence]

Používatelia a práva:
- [role and permissions]

Hlavný postup:
1. [step]
2. [step]
3. [result]

Prvá verzia musí obsahovať:
- [must-have]

Neskôr:
- [later]

Mimo prvej verzie:
- [exclusion]

Dáta a prepojenia:
- [data/integration]

Platforma a používanie:
- [phone/desktop/delivery/offline/language]

Moje predpoklady:
- [assumption or “žiadne”]

Prvý funkčný krok:
- [runnable vertical slice]

Pochopil som aplikáciu správne? Odpovedzte SCHVAĽUJEM (stačí aj jednoznačné „áno, sedí“ / „môžeš začať“), alebo mi napíšte opravy. Kým to nepotvrdíte, programovanie nespustím.
```

## Verification mode announcement

Send once, when implementation work starts. Do not repeat it at every step.

```text
🔧 Režim kontroly: STANDARD
```

or, when the reason is not obvious:

```text
🛡️ Režim kontroly: DEEP
Dôvod: nová aplikácia + autentifikácia
```

## Meaningful progress update

```text
🏗️ [Task name]

[Boundary reached in one sentence.]

Overené:
- [fact with evidence]

Ďalej:
- [next high-level action]
```

## Blocker / decision

```text
⚠️ Potrebujem rozhodnutie: [title]

Čo som overil:
- [evidence]

Problém:
- [why work cannot safely continue]

Možnosť A — [choice]
- Výhoda: ...
- Nevýhoda: ...

Možnosť B — [choice]
- Výhoda: ...
- Nevýhoda: ...

Odporúčanie: [choice and reason]
```

## Repair budget escalation

Send when `MAX_REPAIR_ROUNDS_PER_SLICE` (3) or `MAX_REPAIR_ROUNDS_PER_RUN` (8) is reached. Do not start another automatic repair round; wait for the user. An explicit approval grants a small extension (default +3 rounds), never an unlimited budget.

```text
⚠️ App Builder potrebuje rozhodnutie

Dosiahol som maximálny počet automatických opráv.

Projekt:
[project]

Aktuálna úloha:
[task]

Automatické opravné kolá:
[M] / 8

Čo stále nefunguje:
[failing behavior]

Čo už bolo vyskúšané:
[attempts]

Posledný výsledok testov:
[test output summary]

Posledné zistenia reviewera:
[review findings]

Odporúčanie:
[recommendation]

Chceš, aby som pokračoval ďalším opravným kolom?
```

## Mobile verification section (mobile apps only)

Append to the final report for native or cross-platform mobile applications.

```text
📱 Mobile verification

Platform:
Android

Device:
Pixel [model] / Android [version]

Build:
✅

Install:
✅

Launch:
✅

Tested flow:
- [step]
- [step]
- [step]

UI:
✅

Runtime errors:
None detected

Evidence:
[screenshot/reference]

Overall:
✅ MOBILE VERIFIED
```

Cross-platform app where one target could not be tested:

```text
Android:
✅ VERIFIED

iOS:
⚠️ NOT DEVICE-VERIFIED
Reason: iOS Simulator requires macOS/Xcode.
```

Emulator/SDK unavailable — never fabricate a result:

```text
⚠️ MOBILE DEVICE VERIFICATION NOT RUN

Reason:
Android Emulator / required SDK is not available.

Completed:
✅ build
✅ automated tests
[…]

Not verified:
❌ real Android runtime
❌ mobile UI
❌ device interaction
```

## Final report

```text
✅ [User-facing outcome]

Vytvorené alebo opravené:
- [behavior]

Podľa potvrdenej špecifikácie:
- Verzia: [spec version]
- Potvrdenie: [timestamp/channel]

Overenie:
- Režim kontroly: FAST / STANDARD / DEEP
- [check]: ✅
- Smoke test: ✅ / nebolo možné — [reason]
- Codex review: APPROVE / HOLD
- Opravné kolá Claude Code: [N]/3 (úloha), [M]/8 (celý beh)

UI verification:
- ✅ Passed / ❌ Failed / NOT RUN — [reason]
- Checked: [desktop / mobile / hlavný flow …]
- Evidence: [screenshot / observed behavior]

Git:
- Branch: [branch]
- Worktree: [path]
- Base: [commit]

Zostávajúce drobnosti alebo riziká:
- [none/list]

Nevykonal som bez vášho súhlasu:
- merge / deploy / produkčnú migráciu / inú rizikovú akciu

Potrebné rozhodnutie:
- [approval or “žiadne”]
```
