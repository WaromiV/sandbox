---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, set up or manage
  routines (recurring scheduled tasks), create issues, or call any Paperclip API
  endpoint. Active when PAPERCLIP_API_KEY is present in the environment.
metadata:
  {
    "openclaw":
      {
        "emoji": "📎",
        "primaryEnv": "PAPERCLIP_API_KEY"
      }
  }
---

# Paperclip Skill

Interact with the Paperclip orchestration layer from an OpenClaw agent run.

## Identity

Your Paperclip identity is injected via environment variables when the
openclaw-bridge has provisioned your agent:

- `PAPERCLIP_API_KEY` — bearer token identifying you to Paperclip
- `PAPERCLIP_AGENT_ID` — your UUID in Paperclip's DB
- `PAPERCLIP_COMPANY_ID` — the company you belong to
- `PAPERCLIP_API_URL` — base URL of the Paperclip API (never hard-code this)

All requests: `Authorization: Bearer $PAPERCLIP_API_KEY`. All JSON, all under `/api`.

State-modifying calls should include `X-Paperclip-Run-Id: $OPENCLAW_RUN_ID` when
available for audit-trail linkage. OpenClaw does not inject `PAPERCLIP_RUN_ID`;
use `OPENCLAW_RUN_ID` if set, or omit the header.

## Creating Issues

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"...","description":"...","status":"todo","priority":"medium"}'
```

The API records `createdByAgentId` from your token automatically — no need to
set it manually.

## Key Endpoints

| Action | Endpoint |
|--------|----------|
| My identity | `GET /api/agents/me` |
| My inbox | `GET /api/agents/me/inbox-lite` |
| Create issue | `POST /api/companies/:companyId/issues` |
| Update issue | `PATCH /api/issues/:issueId` |
| Add comment | `POST /api/issues/:issueId/comments` |
| Checkout task | `POST /api/issues/:issueId/checkout` |
| List agents | `GET /api/companies/:companyId/agents` |

## Issue Fields

- `title` (required), `description`, `status` (`backlog`/`todo`/`in_progress`/`in_review`/`done`/`blocked`/`cancelled`)
- `priority`: `critical`/`high`/`medium`/`low`
- `assigneeAgentId`, `parentId`, `goalId`, `projectId`, `billingCode`
- `blockedByIssueIds`: array of issue IDs this one is blocked by

## Rules

- Never hard-code PAPERCLIP_API_URL.
- Include agent identity in comments so humans know which OpenClaw agent filed the issue.
- For multiline comments use `jq -n --arg body "$body" '{comment: $body}'` to preserve newlines.
