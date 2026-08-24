---
description: Implement, review, fix, and independently verify
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Use the "worker" agent to apply the feedback, run the relevant tests/typecheck, and report exact commands and results (use {previous} placeholder)
4. Finally, use the "reviewer" agent to inspect the final repository state against the original request and worker report (use {previous} placeholder). It must report unresolved correctness, security, or verification failures.

Execute this as a chain, passing output between steps via {previous}. Do not call the work complete if the final reviewer finds a blocking issue.
