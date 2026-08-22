# Neta Current and Future System Flow

Today, the system reconstructs coordination state from distributed artifacts: workers generate reports and commits, reviewers and debaters add notes, transcripts capture interactions, and the leader synthesizes global state by reading these outputs. The proposed system shifts authority to a Durable Goal Graph and Scheduler Control Loop: the Goal Graph becomes the single source of truth for what needs doing and what evidence matters, while the Scheduler becomes the sole authority for admitting work, leasing workers, validating acceptance, and stopping—eliminating the need to reconstruct state and making contradictions explicit rather than latent.

```mermaid
flowchart LR
    subgraph CURRENT["CURRENT — Implicit Coordination"]
        direction TB

        C1["User / Leader Intent"] --> C2["Free-form Delegation"]
        C2 --> C3["Workers, Reviewers, Debaters"]
        C3 --> C4["Reports, Commits, Tests"]
        C4 --> C5["Notes, Rooms, Transcript"]
        C5 --> C6["Leader Reconstructs Global State"]

        C6 -->|"More research or review"| C2
        C3 --> C7["Writer Queue, Waits, Revivals"]
        C7 --> C6

        C4 -.-> C8["Prose CLEAN may lack proof"]
        C5 -.-> C9["Contradictions remain open"]
        C6 -.-> C10["No authoritative convergence state"]
    end

    C6 ==>|"Shadow migration"| M["Derive goals, evidence and spend<br/>without changing execution"]

    subgraph FUTURE["FUTURE — Explicit Goal-Control System"]
        direction TB

        F1["User / Leader Intent<br/>treated as a hypothesis"]
        F2["A. Durable Goal Graph"]

        F2A["Parent and Dependencies"]
        F2B["Acceptance Contract"]
        F2C["Evidence, Unknowns, Contradictions"]
        F2D["Token, Worker, Fan-out and Retry Envelope"]
        F2E["Explicit Goal State"]

        F1 --> F2
        F2 --- F2A
        F2 --- F2B
        F2 --- F2C
        F2 --- F2D
        F2 --- F2E

        F2 --> F3{"B. Scheduler Control Loop"}

        F3 -->|"Admit bounded wave"| F4["Workers with durable leases"]
        F4 --> F5["Artifacts and typed evidence"]
        F5 --> F6{"Acceptance contract satisfied?"}

        F6 -->|"Yes"| F7["Accept node and unlock dependants"]
        F6 -->|"No"| F8{"Useful budgeted follow-up exists?"}

        F8 -->|"Yes"| F9["Open one targeted child goal"]
        F9 --> F3

        F8 -->|"No"| F10{"Boundary action"}
        F10 --> F11["Synthesize partial result"]
        F10 --> F12["Challenge leader with evidence"]
        F10 --> F13["Ask or escalate"]
        F10 --> F14["Stop safely"]

        F7 --> F3
    end

    M ==> F2

    classDef current fill:#fff1e6,stroke:#c2410c,color:#431407
    classDef risk fill:#fee2e2,stroke:#dc2626,color:#450a0a
    classDef future fill:#ecfdf5,stroke:#059669,color:#022c22
    classDef control fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b

    class C1,C2,C3,C4,C5,C6,C7 current
    class C8,C9,C10 risk
    class F1,F2,F2A,F2B,F2C,F2D,F2E,F4,F5,F7,F9,F11,F12,F13,F14 future
    class F3,F6,F8,F10 control
```

## Core change

Today, the leader infers global state from coordination artifacts. The proposed architecture makes the Goal Graph the durable state authority and the Scheduler the sole authority for admission, leases, acceptance, and stopping.
