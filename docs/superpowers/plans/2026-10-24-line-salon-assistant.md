# LINE Salon Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a testable, deployable LINE salon assistant with owner notifications, durable tasks and human handoff.

**Architecture:** A Node HTTP service verifies raw LINE webhooks and durably queues individual direct-message events in PostgreSQL before acknowledging them. One in-process worker processes events in per-customer order and maintains a separate notification outbox; AI and LINE clients are injectable for deterministic tests. Render runs the same service with managed PostgreSQL; a local demo uses embedded PostgreSQL and fake external services.

**Tech Stack:** Node 24 LTS, TypeScript, Fastify, pg, OpenAI SDK, Zod, node:test through tsx, PGlite for local SQL tests/demo.

**Spec:** `docs/superpowers/specs/2026-10-24-line-salon-assistant-design.md` (approved in conversation).

## Global Constraints

- Verify raw-body LINE signatures before accepting events; persist before HTTP 200, deduplicate by webhookEventId.
- Default to allowlisted test users; direct one-to-one messages only. Never process owner messages as customer messages.
- No invented prices, schedules, or completed bookings; booking request, customer self-report and owner confirmation are distinct.
- Preserve human handoff across restarts; customer text cannot invoke owner commands or become trusted instructions.
- Send notifications only to configured owner ID. Keep delivery success/failed/unknown distinct and do not blindly retry customer sends.
- Use Asia/Taipei for human-facing timestamps; store UTC. No credentials or raw customer conversations in Git/logs.
- Conversation text/feedback/outbox payload: 30-day cleanup; closed task metadata/dedupe: 90 days. Backups managed separately.
- Keep existing checkout; this cloud task is already isolated, branch `work`; no additional worktree.

## Review Focus

- Several events for one customer: keep order and handoff authoritative even if state changes during AI generation (task 2/3).
- Crash around a successful send: persist send intent; recovered jobs mark unknown and do not duplicate replies (task 2/3).
- Owner commands, group messages and unsolicited media: no privilege escalation or accidental disclosure (task 1/3).
- Missing knowledge and model-supplied booking success/unsafe schema: conservative fallback/handoff, never silently confirm (task 3/4).
- Restart and retention across jobs/feedback: pending work retained and sensitive text removed (task 2/5).

## File map

- `src/config.ts`, `src/types.ts`: validated settings and shared interfaces.
- `src/db.ts`, `src/store.ts`, `migrations/001_initial.sql`: transactions, events, sessions, tasks, feedback, leases/outbox, cleanup.
- `src/app.ts`, `src/signature.ts`: HTTP endpoints and authenticated webhook intake.
- `src/worker.ts`, `src/commands.ts`, `src/policy.ts`, `src/notifications.ts`: customer/admin workflows and rules.
- `src/clients/line.ts`, `src/clients/ai.ts`: outbound adapters with deadlines and safe error classes.
- `src/main.ts`, `src/demo.ts`, `src/migrate.ts`: production startup, local demo, idempotent migrations.
- `knowledge/salon.md`, `.env.example`, `render.yaml`, `README.md`, `docs/SETUP.md`, `.github/workflows/ci.yml`: editable knowledge, deployment and walkthrough.
- `test/*.test.ts`, `test/helpers.ts`: integration and fault tests with real embedded PostgreSQL and fake outbound providers.

### Task 1: Safe webhook intake

**Files:** package/TS config, shared types/config, signature, app; `test/webhook.test.ts`.

**Interfaces:** `createApp({config,store}) -> FastifyInstance`; `Store.ingest(events: LineEvent[]): Promise<void>`; `Config` contains mode, owner/test IDs, API settings.

- [ ] Write failing tests for invalid/missing signatures, signed malformed JSON, empty events, group filtering, owner acceptance, test allowlist and persistence failure.
- [ ] Run `npx tsx --test test/webhook.test.ts`; confirm named tests fail before implementation.
- [ ] Implement strict config, body limits, signature verification and safe direct-event filtering. `/healthz` is liveness; `/readyz` checks storage.
- [ ] Run task tests and TypeScript check, then commit.

### Task 2: Durable SQL storage and recoverable jobs

**Files:** DB/store/migration and `test/store.test.ts`, shared test helper.

**Interfaces:** Store provides `ingest`, `claimEvent`, `finishEvent`, `markSending`, `getSession`, `setHandoff`, `history`, `claimNotification`, `finishNotification`, `listTasks`, `completeTask`, `confirmTask`, `addFeedback`, `cleanup`, `ping`; typed in `src/types.ts`. `Database.query/transaction/close` abstracts pg and PGlite.

- [ ] Write failing SQL tests: duplicate ingest; FIFO per customer; lease recovery; send intent becomes unknown; atomic task/outbox creation; restart; handoff persistence; feedback; retention.
- [ ] Run `npx tsx --test test/store.test.ts` and observe failure.
- [ ] Implement SQL migration with unique IDs, bounded leases/retries, persistence, transaction boundaries and text cleanup. Serialize work per customer using DB state; pg uses transaction-scoped advisory locks to coordinate handoff/send intent.
- [ ] Run storage tests, then commit.

### Task 3: Customer processing, admin control and notifications

**Files:** worker, commands, policy, notifications; `test/worker.test.ts`.

**Interfaces:** `AiClient.generate({text,history,knowledge,receivedAt}) -> Promise<AiResult>`; `LineClient.reply(token,text)` and `push(ownerId,text,retryKey)`; `Worker.tick() -> Promise<boolean>`, `Worker.stop()`. `AiResult` carries reply, summary, service, requestedTime, bookingStatus (`none|requested|self_reported`), needsHuman and nextAction.

- [ ] Write failing workflow tests for reply + notification; owner-only commands; human request/media/AI failure; handoff during generation; stale token; expired recovered send; customer cannot impersonate owner; distinct booking states; notification failure does not resend customer reply.
- [ ] Run worker tests and observe failure.
- [ ] Implement safe workflow, owner commands `/help`, `/pending`, `/take C…`, `/resume C…`, `/done T…`, `/confirm T…`, `/feedback T… text`. Unknown admin commands only show help. Each outbound call has timeout; all customer replies first persist send intent, notifications use retry keys.
- [ ] Run all tests so far and commit.

### Task 4: Real API adapters and startup

**Files:** clients, main, demo, migrate, knowledge, `test/clients.test.ts` and config tests.

**Interfaces:** Real adapters implement task 3 types; `loadConfig(env)` validates production keys and test gate; `migrate(db)` is idempotent and serialized. Entrypoints listen on `0.0.0.0:$PORT` and handle graceful shutdown.

- [ ] Write failing tests for LINE payload/timeout/status classification, OpenAI strict schema/refusal/malformed output, config fail-closed defaults, and migration repeatability.
- [ ] Observe RED, implement SDK/HTTPS clients, honest unknown-data knowledge file and bounded processing; run tests GREEN.
- [ ] Run local demo, POST signed test events, verify actual stored reply + notification and restart state; compile and commit.

### Task 5: Deployment instructions, verification and review

**Files:** README, SETUP, Render blueprint, environment template, CI, setup config draft as needed.

**Interfaces:** `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run migrate`, `npm start`, `npm run demo` are supported entrypoints.

- [ ] Document secure Render configuration, LINE webhook verification, owner/test ID setup, manual handoff, feedback, backup/retention, rollback and costs. Document that booking platform integration and real credentials remain external prerequisites.
- [ ] Validate clean install/build/test, demo end-to-end/restart, blueprint/env consistency and secret-free Git changes.
- [ ] Have a fresh reviewer review whole branch against design and tests; fix important findings with failing regression tests followed by a green suite.
- [ ] Commit finished code; persist only tested reusable install/start instructions. Report actual local checks separately from real LINE/AI/cloud validation; do not claim production deployed without evidence.

## Execution record

Execution authorized by the user's “照這份設計開始”. Proceed in this session without a second plan-approval gate. Implementer owns shared code; independent documentation and final review can run in parallel without editing shared implementation files.
