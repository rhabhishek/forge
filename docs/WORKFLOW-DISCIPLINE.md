# Workflow discipline

These behaviors follow the user's task, permissions, and evidence. External coaching tools are optional recommendation sources, not dependencies, acceptance gates, or tool/message quotas. Aggregated usage cannot establish that a long request failed, a short prompt was simple, or a cache field was complete. No session data is shipped with Forge.

## Contract

The Forge agent is the canonical delivery workflow. `/ship` supplies a compact packet: Intent, Goal, Anchor, Constraints / non-goals, Acceptance evidence, and Allowed effects. Shared engineering context defines permissions, progress checkpoints, recovery, and resume. Super mode is an optional reference, loaded only for a selected milestone build-out.

Answer/advice is read-only by default, including memory, audits, and graphs. A request to save one plan permits that destination only. Delivery still requires the applicable green gate and independent review; prohibiting audit persistence moves its evidence to the conversation, not out of the acceptance contract. Model defaults and specialist inheritance are unchanged.

Repeated unchanged failures trigger a progress checkpoint and a materially different check, not another identical attempt. An uncertain mutation must be reconciled before retry. Healthy long tasks continue. At a genuine task boundary, interruption, or context-capacity problem, a resume packet carries artifacts, verification, unknowns, next action, and current permissions; it is persisted only when allowed.

## Parallel execution

Forge maximizes safe parallelism across discovery, planning, implementation, validation, and review. Independent file reads and evidence checks run together; independent test, lint, build, and artifact checks run together; reviewer lenses run together after integration. A single implementer may edit multiple independent files directly within its own task, without a separate worktree. Separate isolated worktrees or branches are for **multiple concurrent implementer agents**, since uncoordinated concurrent writers could otherwise clobber the same tree - file-disjoint ownership alone does not make one shared worktree safe for more than one writer. Shared contracts and dependent consumers remain ordered. There is no arbitrary agent, tool, file, or message cap; dependency, shared-resource contention, host capacity, context quality, or explicit user constraints determine when work stays serial.

## Validation

`node --test test/render.test.mjs` checks emitted guidance, task fields, resolved optional references, and existing model/review contracts across Copilot, Cursor, and OpenCode. The full suite covers installation and memory behavior. These are deterministic instruction-contract tests, not proof that a model obeys prose or that a host enforces permissions.

Use a disposable workspace and host tool policies to evaluate these scenarios before relying on runtime enforcement:

| Request or situation | Expected behavior |
| --- | --- |
| A bounded question answerable from supplied evidence | Direct answer; no bootstrap, unnecessary tools, or delivery loop |
| Analysis only, no writes or commands | Scoped permitted reads; no graph, audit, code, test, or build writes |
| Diagnose a problem with one explicitly authorized test command | Only that diagnostic and its permitted effects; no automatic delivery loop or source edits |
| Save the plan to one named destination | Only that artifact is written; no implied implementation or publication |
| Fix a bug, but do not persist audit state | Contract/evidence in the conversation; applicable tests/build and independent review still required |
| A short continuation of complex work | Keep the active task, permissions, and selected model; do not demand a padded prompt |
| Repeated failing query, or a mutation timeout | Correct a material cause or report partial progress; reconcile uncertain effects before retrying |
| A long but productive implementation/test/doc/review task | Continue the same outcome; no tool/message cutoff or automatic chat reset |
| Resume after a changed permission or artifact | Revalidate current state; do not replay completed work or assume old approval applies |

Record actual host/tool outcomes and mark unavailable evidence unknown. Optional efficiency comparisons should use comparable task intent and complexity, include failures/retries/specialist work, and preserve authorization, required gates, and accepted-result quality. Do not optimize a coaching score or claim token/cache savings from source-file size alone.