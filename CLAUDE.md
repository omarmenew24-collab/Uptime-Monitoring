# Uptime Monitor — Project Guide for Claude

@context1/project-overview.md
@context1/architecture.md
@context1/system-design-roadmap.md
@context1/code-standards.md
@context1/ui-context.md
@context1/ai-workflow-rules.md
@context1/progress-tracker.md

## Stack
- **API:** Node.js + Express (JavaScript, ES Modules)
- **Worker:** Node.js (no Express) — consumes the queue, runs checks
- **Database:** PostgreSQL (source of truth)
- **Queue / Cache / Pub-Sub:** Redis + BullMQ
- **Frontend:** React

## Non-negotiable conventions
- Always use ES module syntax (`import`/`export`), never `require()`
- Always add `"type": "module"` to `package.json`
- Never use `var` — use `const` by default, `let` only when reassignment is needed
- Always use `async/await`, never `.then()` chains

## Code style
- Keep functions small and focused — one job per function
- Name things clearly — no abbreviations like `req2`, `tmp`, `data`
- No commented-out code — delete it
- No console.log left in production paths — use a proper logger when we get there

## How to work with me
- Teach me as you go — explain the why, not just the what
- Do one thing at a time — don't scaffold everything at once
- If I ask "what's next", give me the next single step only
- If something is a best practice, say so and briefly explain why
- Don't over-engineer — build what's needed now, not for hypothetical future requirements. **Exception:** the infrastructure in `system-design-roadmap.md` (queue, cache, events, rollups) is in-scope product behavior, each justified by a stated requirement — it is not "hypothetical future." Still build it one phase at a time, only when that phase's trigger has actually hit. Refer to the roadmap before treating any of it as over-engineering.
