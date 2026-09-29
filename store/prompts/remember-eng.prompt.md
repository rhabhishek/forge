---
name: remember-eng
agent: forge
description: "Capture a durable engineering lesson (recurring finding, gotcha, perf pattern) into Forge's canonical memory - leak-checked, deduped, never in your repo."
profiles: [engineer]
---

Capture a durable **engineering lesson** - not a transcript - so future runs compound.

1. Distill the lesson to one line: a recurring review finding, a project gotcha, a convention, or a perf/security pattern worth remembering. Pick scope tags (`#convention`, `#gotcha`, `#perf`, `#security`, `#testing`, ...).
2. Decide scope:
   - **Project-specific** -> default (writes to the project namespace).
   - **Cross-project / personal habit** -> add `--global`.
3. Record it via the CLI so it is **leak-checked** (refuses company/PII data), **deduped**, and stamped with provenance + confidence:

```
node {{FORGE_CLI}} remember "<the lesson>" --tag <tag>          # project scope
node {{FORGE_CLI}} remember "<the lesson>" --tag <tag> --global # cross-project
```

4. **Never auto-write.** If this came from a session-end digest, present the candidate lessons and only record the ones the user confirms.
5. **Ratchet:** if the lesson is a recurring finding, also note it should become a `code-review-rubric` lens, and - where mechanizable - a lint rule or regression test, so the bug class cannot silently return.

Lessons are stored in the canonical store at `{{MEMORY_ROOT}}` (outside any repo), capped and pruned (newer supersedes older). `forge` reads them at run start and `reviewer` at review start.
