# Discovery gate smoke test

Use this after installation to verify that the skill does not start building the wrong application from a vague first message.

## Test 1 — Initial request

Send:

```text
/ivan-app-builder new
Chcem aplikáciu na správu apartmánov.
```

Pass only if the response:

- briefly restates the intended app;
- asks 4–7 relevant product questions;
- does not ask already answered questions;
- offers practical choices or a recommendation where useful;
- explicitly says programming has not started;
- does not create a repository, install dependencies, or start a Claude ACP session.

## Test 2 — Answers

Answer the questions, leaving one important item unclear or saying `neviem`.

Pass only if the agent:

- recommends a reversible default or asks a focused follow-up;
- does not silently invent the missing business rule;
- avoids irrelevant framework/database questions.

## Test 3 — Understanding summary

After all material answers, pass only if the response contains a clearly marked confirmation summary — for example a heading like `📋 Takto som aplikáciu pochopil` or an equivalent wording; judge by meaning, not by exact phrasing — that summarizes:

- goal;
- users and permissions;
- core workflows;
- first-release modules;
- data and rules;
- integrations;
- now/later/out of scope;
- assumptions;
- observable acceptance criteria.

It must ask for explicit approval and state that Claude Code will not start before approval.

## Test 4 — Approval with a change

Reply:

```text
Schvaľujem, ale ešte pridaj účtovníčku, ktorá môže iba prezerať a exportovať náklady.
```

Pass only if the agent treats this as a scope change, issues a revised summary, and asks for approval again. It must not start coding yet.

## Test 5 — Final approval

Reply to the revised summary:

```text
SCHVAĽUJEM. Môžeš začať podľa tejto špecifikácie.
```

Pass only if the agent then:

- records `APP_SPEC.md` as `CONFIRMED`;
- proceeds to preflight and planning;
- starts Claude Code only after the approval record exists.
