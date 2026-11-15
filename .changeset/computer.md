---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

A pod Agent on an Agent Substrate cluster can be a computer (ADR-149, ADR-150): with `NYLORUN_SANDBOX_GATEWAY_URL` and `NYLORUN_COMPUTER_TICKET_KEY_FILE` set (the Runtime's Helm chart sets both), its sessions' runs go to the harness container, and their sandbox tools, file reads and writes, skill folders and disk versions reach the Agent's actor through the sandbox gateway and `atenet-router`, with a ticket core signs (Ed25519). The engine's `--service computer` runs no loop: it serves commands (a start and attaches, each under 50 s) and files on port 8080, checks each ticket against the key its template carries, and answers the wake-up probe on `/ready`. A harness opens a computer with `computer.open`; core wakes it, waits until it is ready, writes a seed onto a new disk, runs the disk's setup through it and passes a version's start check. The tools, `runtime.json` and every other backend are unchanged.

- `@nylorun/core`: Harness API 5.6 (`harness-api/v5.6.json`): `routing.sandbox.computer` and the request `computer.open`.
- `@nylorun/runtime`: `--service computer`; the `computer` sandbox backend; `NYLORUN_SANDBOX_GATEWAY_URL` and `NYLORUN_COMPUTER_TICKET_KEY_FILE`.
