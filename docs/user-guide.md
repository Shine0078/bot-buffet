# User guide

Serve the Office UI from the control plane: run `npm run dev` and open http://127.0.0.1:8787. Opening `ui/index.html` as a file cannot talk to the API. Then select a project, inspect a desk, and open the list/table views for keyboard-friendly operations. Run controls are pause, resume, stop, fork, and rollback. High/critical tools appear in Approvals; reject or approve with a reason. The global stop button cancels all active runs. The timeline and Audit log show redacted evidence, cost, model, and state transitions.

## Run modes

Every agent profile carries a mode, and every run inherits it. The mode is a
constraint the harness applies **in addition to** the agent's policy, never
instead of it — so a mode can only narrow what policy already permits, and
choosing one can never be an escalation.

| Mode             | Tools                    | Risk ceiling | Approval needed above | What it is for                          |
| ---------------- | ------------------------ | ------------ | --------------------- | --------------------------------------- |
| `plan`           | Read-only                | safe         | safe                  | Producing a plan you will review        |
| `review`         | Read-only                | safe         | safe                  | Inspecting work that already exists     |
| `chat`           | None                     | —            | —                     | Conversation with nothing else moving   |
| `execute`        | Any permitted            | critical     | medium                | Ordinary work                           |
| `supervised`     | Any permitted            | critical     | safe                  | Someone is watching and confirming      |
| `autonomous`     | Any permitted            | high         | medium                | Unattended work                         |
| `maintenance`    | Any permitted            | low          | low                   | Routine, reversible upkeep              |
| `emergency-stop` | None; run will not start | —            | —                     | Stopping an agent outright              |
| `custom`         | Any permitted            | high         | medium                | Your own mode, with the ceilings intact |

A few of these are deliberate and worth knowing:

- **`plan` and `review` refuse a mutating tool rather than asking to approve
  it.** The mode is saying this kind of work is not what the run is for, and an
  approval prompt would quietly turn that into "ask and proceed".
- **`autonomous` cannot reach a critical action.** Nobody is present to approve
  an irreversible one, so the mode must not be able to get there. If a task
  genuinely needs a critical action, run it `supervised`.
- **`custom` carries no implicit relaxation.** Otherwise defining a custom mode
  would be a route around the built-in ceilings.
- **An unrecognised mode is treated as `emergency-stop`.** A mode added to the
  type but not to the table fails closed rather than being waved through.

Every mode refusal is written to the audit log with the mode, the tool, the
refusal code, and the reason, so a run that did less than expected can be
explained afterwards.
