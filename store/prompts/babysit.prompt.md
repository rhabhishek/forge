---
name: babysit
agent: forge
description: "Shepherd an open PR to mergeable: watch CI + review threads, fix via the Forge loop, keep the branch rebased - never merges."
profiles: [engineer]
---

Use the top-level `forge` agent on the current request. Follow its **task intent** check before tools or setup. The Forge agent owns the implement -> review -> refine workflow, verification, and model inheritance; this prompt only scopes a PR-shepherding run and its permissions.

Build this task packet from the request and available context:

- **Intent:** delivery.
- **Goal:** the PR is mergeable - required checks green, no unresolved actionable review threads, head branch up to date with base.
- **Anchor:** the PR URL or number from the request; otherwise the open PR for the current branch. If none or more than one match, ask which PR.
- **Constraints / non-goals:** change only what failing checks and review comments require; no unrelated refactors or scope growth. `/babysit` never merges.
- **Acceptance evidence:** check-run results, thread replies citing the fixing commit and test, and the head branch's position relative to base.
- **Allowed effects:** pre-authorized for this run on the anchored PR only:
  - Push fixes to the PR's head branch by rebasing onto the base branch, keeping history as a single commit, and pushing with `--force-with-lease` pinned to the recorded head SHA only (see Cycle). Forge performs the rebase/push itself after the fix is `APPROVED`; specialists do not push. Never plain `--force`, never a merge commit, never the GitHub "update branch" / `update_pull_request_branch` merge.
  - Reply to and resolve review threads.
  - Toggle the repo's CI-trigger label (remove, then re-add) to re-run CI.
  - Update the PR title/description with gate evidence.
  - **Not authorized:** merging the PR, pushing to the base or any protected branch, deleting branches, dismissing reviews, changing repo settings. Anything else requires asking the user.

## Cycle

1. Read PR state and record the PR head SHA for this cycle: check runs, unresolved review threads, and whether the branch is behind base or conflicting.
2. Triage each failing check as caused by this PR or flaky/infra. Re-trigger infra failures with the label toggle, not code changes.
3. Actionable review comments and PR-caused failures become the acceptance contract for one Forge fix pass. After the fix is `APPROVED`, Forge rebases onto base, keeps a single commit, and pushes with `--force-with-lease=<branch>:<recorded-sha>` (the rebase's fetch would defeat a bare `--force-with-lease`). If the rebase has conflicts, re-run the green gate and review on the resolved result before pushing. If the push is rejected, someone else pushed: stop and re-read PR state rather than retrying with force.
4. Reply on each addressed thread with the evidence (commit, test) and resolve it. For questions or disagreements, reply with reasoning and leave the thread open for the human.

## Stop when

- All required checks are green, no actionable threads remain unresolved, and the branch is up to date with base: report the PR as mergeable and do not merge it.
- 3 fix cycles are reached, or a cycle does not reduce the open issue count (anti-oscillation).
- A blocker needs a human: ambiguous or contradicting reviewer requests, required approvals, secrets/permissions, infra outage.
- Checks are still pending: never sleep or busy-wait. Report current status and what remains, then end the turn; the user re-invokes `/babysit` to resume.

End with a short status: PR, checks summary, threads addressed/open, commits pushed, remaining blockers.
