# Wingman

An autopilot agent for real-world business workflows: ambiguous customer inquiries in,
grounded answers and drafted actions out, with human-in-the-loop approval at every
critical decision point.

> Qwen Cloud Hackathon · Track 4 (Autopilot Agent) · MIT

## What it is

Wingman is a conversational business agent (Telegram + web) with persistent memory.
It answers from your company's product documents, remembers customers across sessions,
drafts quotes and actions, and routes anything consequential to a human for sign-off
before acting.

- **Agent runtime:** built on [NanoClaw](https://nanoclaw.dev) by Gavriel (MIT, see
  `LICENSE` and `NANOCLAW.md`), with the engine swapped to **Qwen Code** and Qwen
  (DashScope) as the reasoning model.
- **Memory:** [Engram](https://github.com/tzechong94/engram), a self-managing memory
  layer (MCP), used here as a dependency for cross-session recall, document RAG, and
  timely forgetting. Wiring: `engram-integration/`.
- **Human-in-the-loop:** approval requests are routed to the owner (Telegram) before
  the agent takes critical actions.

## Status

Under active development for the hackathon. Setup notes: `engram-integration/agent-and-deploy.md`.
