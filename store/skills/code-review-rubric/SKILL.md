---
name: code-review-rubric
description: The objective rubric the Forge reviewer scores a diff against - severity taxonomy, review dimensions, and the default SME lenses.
trigger: /code-review-rubric
---

# Code Review Rubric

The `reviewer` scores a diff against this rubric **plus** the run's acceptance checklist. Output is a structured verdict, not prose. Review the **diff** (and test output), not the whole repo; expand context only via `graphify query`/`path` when a finding requires it.

## Severity taxonomy (controls the loop)

| Severity | Meaning | Gates the loop? |
| -------- | ------- | --------------- |
| `blocker` | Wrong behavior, violated business rule, data loss/corruption, security hole, build/test failure | Yes - must fix |
| `major` | Missing edge case, missing error handling, significant perf regression, broken contract/API | Yes - must fix |
| `minor` | Readability, naming, small duplication, weak test coverage on a non-critical path | No - log it |
| `nit` | Style, formatting, wording, preference | No - log it |

Only `blocker` and `major` cause another refine iteration. `minor`/`nit` are recorded in the work-ticket and surfaced at the end, never looped on. A correctness `blocker` should, where practical, come with a **reproducing failing test**.

## Review dimensions (always)

1. **Correctness** - does it do what the task says? Trace the logic against each acceptance-checklist item.
2. **Business rules** - every rule in the checklist is satisfied and tested.
3. **Edge cases** - nulls/empties, boundaries, large inputs, concurrency, ordering, idempotency, failure paths.
4. **Error handling** - no swallowed errors; failures are surfaced and actionable; no partial-write corruption.
5. **Tests** - new behavior is covered; the existing suite still passes; tests assert behavior, not implementation.
6. **Performance & complexity** - appropriate algorithm/data structure; no accidental N+1, no needless allocations in hot paths; no premature micro-optimization.
7. **Readability & maintainability** - clear names, small functions, matches existing patterns, comments only where intent is non-obvious.
8. **Scope** - minimal diff; no unrelated changes, no gold-plating.
9. **Security basics** - input validation, no injection, no secrets in code/logs, safe defaults.

## Durable correctness checks

- **Serialized contract alignment** - for API-consuming changes, verify that client-side models, types, and field access match the actual serialized API contract, not internal server models or imagined fields. Check field names, nesting, optionality, and enum values against an authoritative schema, response fixture, or observed serialization boundary.
- **Terminal UI states** - for asynchronous UI flows, loading, empty, success, and error must be distinct terminal states. Every success and failure path must settle loading and restore interactive controls; controls cannot stay disabled indefinitely after failures. Cover recovery or retry behavior where the interaction supports it.
- **Framework build evidence** - when a project defines a framework build, require it in the green gate even if narrower unit tests and type checks pass. A framework build can expose framework-level compilation, module resolution, bundling, route generation, and server/client boundary failures that narrower checks miss.

## Default SME lenses (applied inline, no extra agent)

Apply these as part of the single diff pass unless the orchestrator has already escalated to a dedicated SME agent for that domain:

- **Security lens** - authn/authz, injection, unsafe deserialization, secrets, dependency risk.
- **Performance lens** - complexity, allocations, queries/IO in loops, caching, payload size.
- **Business-rule/domain lens** - the checklist's domain invariants actually hold for all paths.
- **Accessibility (a11y) lens** (UI/markup diffs only) - semantic markup, labels/alt text, keyboard nav, focus, contrast, ARIA correctness.

Escalate to the matching `sme-*` agent only when the lens surfaces something deep or the task is flagged high-risk in that domain (e.g. touches auth, a hot path, or user-facing UI).

## Verdict format (what the reviewer returns)

```
VERDICT: APPROVED | CHANGES_REQUIRED
Open findings reduced vs last iteration: <yes/no/n-a>

Findings:
- [blocker] <file:line> <what's wrong> -> <required fix> (repro: <test or steps, if correctness>)
- [major]   <file:line> <what's wrong> -> <required fix>
- [minor]   <file:line> <note>
- [nit]     <file:line> <note>

If APPROVED: one-line confirmation that every acceptance-checklist item is met with evidence.
```

`APPROVED` requires zero open `blocker`/`major` findings and every checklist item satisfied. Be specific and cite `file:line`; never hand back vague "consider improving" notes as gating findings.
