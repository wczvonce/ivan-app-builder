## Povinný host review runner (1.6.2)

Po implementácii a po každej oprave požiadaj host o Phase 7:
`node "$HOME/.openclaw/scripts/app-builder-review.js" request --project <worktree> --slice S1 --backend <skutočný model>`.
Pre finálnu aplikáciu pridaj `--final`. Uvoľni lock a ukonči ťah. Watchdog spustí testy a
review v samostatnom procese. Neštartuj duplicitný reviewer v modelovom harnesse.

Model ani implementátor nesmie vlastným zápisom PASS/DONE nahradiť host review. Aktuálny
stav over cez `app-builder-review.js status --project <worktree>`. Pri `changes_requested`
prečítaj host state/review súbory, resumni pôvodného Claude Code workera cez existujúci
resumeSessionId a rovnaké cwd, oprav iba doložené chyby a znova zavolaj `request`.
Počítadlá 3 opravy/slice a 8/beh spravuje host; nikdy ich neresetuj ani nemeň kontrakt testov.
Ak pôvodná session neexistuje alebo sa nedá obnoviť, zapíš skutočný problém a needs-attention;
nevydávaj rodičovu vlastnú kontrolu za nezávislú review.

Pri `approved` pokračuj ďalším slice alebo dodaním. Až po finálnej review a ostatných
dodacích podmienkach zavolaj `app-builder-review.js complete --project <worktree>`.
Tento príkaz zapisuje DONE a uzatvára Factory stav. Záverečný report do outboxu označ
`kind: "completion"`; watchdog ho zadrží, kým completion neplatí pre aktuálny kód.
Report vždy uvedie skutočného reviewera a slabší same-family fallback výslovne prizná.

GPT fallback orchestrátora je naďalej schválený bez ďalšej otázky. Predvolený reťazec je
Claude Opus → GPT-6 Astra → GPT-5.6 Sol → ďalšie nakonfigurované zálohy. Zapíš skutočný runtime
model do hlavičky run-state. Host pri ľubovoľnom GPT začne Fable; inak GPT-6 Astra cez Codex → Fable → posledný
same-family fallback. HOLD nie je výpadok providera. Žiadna review znamená REVIEW-pending,
nikdy DONE. FAST tiež musí pred DONE prejsť host gate. WAITING_USER, PAUSE, schválenia pre
nasadenie a zmrazené zadanie zostávajú záväzné. Pri provider limite používaj outbox a
continue-request.json; jednorazový cron vytvára watchdog, nie samotný agent.
