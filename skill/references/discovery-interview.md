# Discovery interview protocol

Use this protocol before building every new application. The objective is to prevent the team from building the wrong product, not to collect every imaginable preference.

## Core behavior

- Speak in the user's language and match their technical level.
- Treat the first app idea as an initial brief, not a complete specification.
- Extract what is already known before asking anything.
- Never repeat an answered question.
- Ask 4–7 related, high-impact questions per Telegram message. Use follow-up rounds only while material ambiguity remains.
- Use short examples or A/B/C choices when that makes answering easier.
- When the user says “I don't know”, recommend a practical default and explain the visible consequence briefly.
- Do not ask the user to choose a framework, database, cloud provider, or technical pattern unless the choice affects cost, data ownership, compliance, or a capability they care about.
- Do not start implementation until the written understanding is explicitly confirmed.

## Priority question areas

Ask only the unanswered areas that can materially change the application.

### Outcome and users

- What problem should the application solve?
- What should become easier, faster, or automatic?
- Who will use it: only the owner, staff, customers, guests, suppliers, or several roles?
- What may each role view, create, edit, approve, export, or delete?
- What would make the first release genuinely useful?

### Core workflows

Ask the user to describe the main workflow in ordinary language from start to finish. Probe only for important alternate paths, cancellation, edit/delete behavior, approvals, and what happens after completion.

Useful prompts include:

- “What happens from the moment a new request/reservation/task arrives until it is completed?”
- “What do you want to tap first, what information do you enter, and what result should appear?”
- “Which three actions will you use most often?”

### MVP boundary

Separate requirements into:

- **Must have for the first usable version**
- **Useful soon after launch**
- **Later ideas**
- **Explicitly out of scope**

When the user lists many ideas, recommend the smallest coherent first release rather than silently excluding features.

### Data, ownership, and permissions

Clarify the records and files to store, their owner and visibility, edit/delete/history rules, required search/filter/export, sensitivity, and approximate scale when relevant.

### Platform and use context

Clarify responsive web versus native mobile/desktop only when it affects the need; primary phone/computer use; offline requirements; camera, GPS, QR/barcode, printing, signatures, notifications, language, and device constraints.

Do not assume that “mobile app” requires a native app. Explain when a responsive web app or installable PWA is the simpler first release.

### Accounts, security, and privacy

Clarify no login versus one owner account, staff/customer accounts, role permissions, public links, invitations/password reset/2FA, sensitive data, audit history, backups, and approval workflows.

### Integrations and automation

Clarify required connections to email, Telegram, calendar, accounting, payments, booking portals, maps, cloud storage, spreadsheets, APIs, or an existing database; imports/exports; scheduled reports; reminders; and whether manual export is enough for MVP.

### UX, visual expectations, and operations

Clarify internal/simple versus customer-facing polished product; design examples; required branding; dashboard/list/calendar/map views; first-screen priorities; private/local versus internet use; existing domain/server/repository; recurring-cost limits; deployment target; and who will operate the app.

## Conversation sequence

### First response

1. Restate the idea in one sentence.
2. Say you will ask a few focused questions so the correct app is built.
3. Ask the 4–7 highest-impact unanswered questions.

Example:

```text
Rozumiem tomu zatiaľ takto: [one-sentence outcome].

Aby som nevytvoril inú aplikáciu, než potrebujete, doplňte prosím:

1. Kto ju bude používať?
   A) iba vy
   B) aj zamestnanci
   C) aj klienti/hostia

2. Ktoré tri činnosti musia v prvej verzii určite fungovať?

3. Ako dnes vyzerá hlavný postup od začiatku do konca?

4. Má ísť primárne o mobil, počítač alebo oboje?

5. Potrebuje prepojenie s niečím, čo už používate?

6. Ktoré veci môžu počkať na druhú verziu?

Odpovedzte pokojne stručne pod čísla. Pri „neviem“ odporučím najpraktickejšiu možnosť.
```

### Follow-up rounds

Briefly summarize settled facts, then ask only remaining material questions. Point out contradictions neutrally and recommend a default when the user is unsure.

### Final understanding check

```text
📋 Takto som aplikáciu pochopil

Cieľ:
[one sentence]

Používatelia a práva:
- ...

Hlavný postup:
1. ...
2. ...

Prvá verzia musí obsahovať:
- ...

Neskôr:
- ...

Mimo prvej verzie:
- ...

Dáta a prepojenia:
- ...

Platforma a používanie:
- ...

Moje predpoklady:
- ...

Prvý funkčný krok:
- ...

Pochopil som aplikáciu správne? Odpovedzte SCHVAĽUJEM (stačí aj jednoznačné „áno, sedí“ / „môžeš začať“), alebo napíšte opravy. Kým to nepotvrdíte, programovanie nespustím.
```

The canonical approval is **SCHVAĽUJEM**; an unambiguous natural equivalent („áno, sedí“, „môžeš začať“, „súhlasím“, „je to správne“) also passes the gate. An ambiguous or conditional reply („OK“, „asi“, „vyzerá to dobre, ale …“) does not. Corrections reopen the gate until the revised summary is confirmed.

## During implementation

Do not reopen settled decisions for minor implementation details. Choose safe, reversible defaults and report them. Pause and ask again only when new information could materially change a workflow, permission boundary, stored data/lifecycle, integration, cost, security, destructive action, or confirmed MVP scope.
