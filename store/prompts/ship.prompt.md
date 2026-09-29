---
name: ship
agent: forge
description: "Implement a task at staff-engineer quality via the bounded implement -> review -> refine loop."
profiles: [engineer]
---

Use the top-level `forge` agent on the current request. Follow its **task intent** check before tools or setup; `/ship` never overrides an explicit analysis-only or no-change constraint. The Forge agent owns the workflow, decomposition, model inheritance, verification, and review; do not repeat or replace those instructions here.

Build this compact task packet from the request and available context:

- **Intent:** answer, advice, or delivery.
- **Goal:** the requested outcome.
- **Anchor:** the relevant file, symbol, issue, URL, or observed behavior; distinguish source definitions, observations, and inferences.
- **Constraints / non-goals:** scope boundaries and what must remain unchanged.
- **Acceptance evidence:** how to establish completion; name unknowns rather than inventing requirements.
- **Allowed effects:** authorized reads, commands, writes and destinations, network access, and publication; preserve explicit restrictions.

Do not ask the user to fill in a form when the answers are already present. Ask one targeted question only for a consequential gap. A short follow-up inherits the active task; it does not need padding or a new specification. Hand the packet to Forge without prescribing an implementation strategy.
