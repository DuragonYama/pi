---
description: Scout, plan, implement, and independently verify
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Use the "worker" agent to implement the plan, run the relevant tests/typecheck, and report exact commands and results (use {previous} placeholder)
4. Finally, use the "reviewer" agent to inspect the final repository state against the original request and worker report (use {previous} placeholder). It must report unresolved correctness, security, or verification failures.

Execute this as a chain, passing output between steps via {previous}. Do not call the work complete if the final reviewer finds a blocking issue.
