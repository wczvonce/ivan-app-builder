# Independent Codex review rubric

Review the complete branch diff against the recorded base, the confirmed `APP_SPEC.md`, linked requirement IDs, and the task acceptance criteria. Do not edit files during review. If the specification is not confirmed for a new app, return `HOLD`.

## Review order

1. **Confirmed product contract**
   - Does the implementation match the confirmed users, workflows, permissions, MVP boundary, and non-goals?
   - Is every linked requirement and acceptance criterion addressed with observable evidence?
   - Did the implementation silently add deferred features, omit a confirmed behavior, or substitute an agent assumption for a user decision?

2. **Acceptance and correctness**
   - Does the implemented behavior satisfy each criterion?
   - Are state transitions, errors, retries, concurrency, null/empty states, time zones, and boundary values correct?

3. **Security and authorization**
   - Authentication and ownership checks on every server-side operation
   - Input validation, output encoding, path/file handling, upload limits, SSRF, injection, traversal, unsafe redirects
   - Secret exposure, logging of sensitive data, excessive permissions

4. **Data integrity and migrations**
   - Constraints, transactions, idempotency, indexes, backwards compatibility
   - Safe rollout and rollback; no silent loss or corruption

5. **API and integration behavior**
   - Contract compatibility, status codes, failure handling, rate limits, retries, external side effects

6. **Tests and verification**
   - Meaningful regression tests rather than implementation-detail tests
   - Missing negative paths or false-positive tests
   - Whether the reported commands actually cover the changed behavior

7. **UI and accessibility**
   - Loading, error, empty and success states
   - Mobile behavior, keyboard use, labels, focus, destructive-action confirmation

8. **Maintainability and scope**
   - Unnecessary complexity, duplicated logic, dead code, unrelated changes, brittle coupling

9. **Performance and operations**
   - N+1 work, unbounded loops/queries/uploads, blocking operations, missing observability or cleanup

## Finding format

Return only actionable findings, ordered by severity.

```text
[BLOCKER|IMPORTANT|MINOR] Short title
Location: path/to/file:line or affected component
Evidence: concrete code path, test result, or reproducible scenario
Impact: what can break and for whom
Required correction: precise outcome, not a full rewrite prescription
```

Then provide:

```text
REVIEW SUMMARY
Blockers: N
Important: N
Minor: N
Acceptance criteria: PASS | FAIL | PARTIAL
Independent approval: APPROVE | HOLD
Residual risk: concise statement
```

Do not create style-only findings unless they cause a concrete maintenance or correctness problem. Do not approve based solely on green tests.
