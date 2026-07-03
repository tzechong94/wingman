# TODOS

Deferred work with full context. Source of truth for "later." Items here were
consciously deferred during plan reviews — each has enough context to resume cold.

---

## P1 — Onboarding wizard ("Add your business")

**What:** Dashboard page: business name + rate card PDF upload + house rules form → parses the rate card, ingests into Engram, agent goes live for that business.
**Why:** It's the sales funnel. Today onboarding is a CLI seeding script (persona-as-data invariant); the wizard is the difference between "we could onboard an SME" and watching it happen in 60 seconds during a sales call.
**Pros:** Converts the demo into a self-serve product; strongest production-readiness proof; the ingestion path is also the thing that keeps agent knowledge fresh (the #1 documented chatbot killer).
**Cons:** Messy-PDF parsing is genuinely hard — real rate cards are photos of laminated sheets. Risk of a half-working wizard eroding trust vs. a reliable script.
**Context:** Deferred from the 2026-07-03 CEO review (Qwen hackathon week). The seeding script (`scripts/` — built during hackathon week) is the fallback and defines the data contract: rate card entries + house rules + customer histories into Engram + `container.json` config. Wizard is a UI face over the same path. Start from the script's ingest functions.
**Effort:** L (human) → M (CC+gstack). **Priority:** P1. **Depends on:** hackathon build's seeding script + host HTTP layer.

## P1 — Real login mapped to user_roles (replace demo-token shim)

**What:** Replace the demo-token → `web:demo-owner` synthetic identity with real authentication (magic link or OAuth) mapped to `user_roles` in the central DB.
**Why:** The hackathon dashboard authorizes approvals via a shared token — fine for judging, unacceptable for a paying customer whose discount approvals are the product's core privileged action.
**Pros:** Unlocks selling to business #1; multi-user (owner + staff) falls out of `user_roles` scoping which already exists in-tree (`src/modules/permissions/access.ts`).
**Cons:** Session management + login UI; choose a provider.
**Context:** The approval resolution path is already privilege-gated (`isAuthorizedApprovalClick`, `src/modules/approvals/response-handler.ts`) — auth only needs to mint identities that map into the existing model. Deferred from CEO review 2026-07-03.
**Effort:** M (human) → S-M (CC). **Priority:** P1. **Depends on:** nothing; additive.

## P2 — WhatsApp channel wiring

**What:** Install the in-tree `/add-whatsapp` skill (native Baileys adapter, QR pairing) and wire a customer-facing WhatsApp number to the agent group.
**Why:** WhatsApp is where SEA SME customers actually are; Telegram + web were the hackathon surfaces. Pitch-slide during the hackathon, wire it for customer #1.
**Pros:** The single biggest "this works for MY business" unlock in sales conversations; adapter code already exists on the `channels` branch.
**Cons:** Baileys is unofficial — pairing flakiness and ban risk on the business number; needs operational babysitting.
**Context:** Deferred from CEO review 2026-07-03 to keep judging-week risk down. The channel-adapter interface work done for the web channel is the template.
**Effort:** S-M (human) → S (CC). **Priority:** P2. **Depends on:** none.

## P2 — Voice-note inquiries (DashScope ASR)

**What:** Customer sends a voice note; ASR (DashScope paraformer / Qwen-audio) transcribes; agent proceeds through the normal scoping/quote flow.
**Why:** Real customers send voice notes ("it's making a rattling noise"); handling them extends the ambiguous-input surface.
**Pros:** On-theme with the Qwen stack; big perceived-magic moment.
**Cons:** Mic/upload plumbing per channel; transcription of ambient/dialect audio is the least groundable input; overlapped with photo→quote's multimodal beat in the demo, which is why it lost.
**Context:** Deferred from CEO review 2026-07-03. Photo→quote (shipped) established the media-upload path through the web channel — reuse it.
**Effort:** M (human) → S-M (CC). **Priority:** P2. **Depends on:** media upload path (built for photo→quote).

## P3 — "Edit amount" on approval cards

**What:** Third approval action beyond Approve/Reject: owner edits the quote amount inline and approves the edited version.
**Why:** Real owners counter-offer; today the flow is Reject → agent re-drafts at the house-rule limit.
**Pros:** One less round-trip for the owner; matches how bosses actually behave.
**Cons:** The in-tree approvals primitive supports exactly two options (`APPROVAL_OPTIONS`, `src/modules/approvals/primitive.ts`); Edit needs payload mutation + handler changes + parity on the Telegram surface (which only has buttons — needs a reply-to-edit convention).
**Context:** Cut during design-doc review 2026-07-03 (surface asymmetry with Telegram). Extend the primitive, don't special-case the dashboard.
**Effort:** M (human) → S-M (CC). **Priority:** P3. **Depends on:** approvals primitive extension.
