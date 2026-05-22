# doc-ack

Document read acknowledgement system for the CUH Bioinformatics team (25 members), built on Atlassian Forge and Jira Automation.

---

## Overview

When a document is ready for team acknowledgement, the author transitions a `Document` Jira issue in DIAS to **Acknowledge**. This automatically creates one Jira sub-task per required reader, assigned to them and containing a link to the Confluence page.

Readers open the Confluence page, read it, and click **"✅ I have read this document"** in the page byline — provided by the Forge app. Clicking stores a timestamped confirmation in the Forge KVS.

Admins monitor progress via:
- The byline counter on each SOP page (`X / 25 confirmed`)
- The [Document Acknowledgement Tracker](https://cuhbioinformatics.atlassian.net/wiki/plugins/servlet/ac/doc-ack-register/docack-tracker) — a global Confluence page showing all tracked documents

---

## Architecture

```
AUTHOR
  └─ Creates Document issue in DIAS (DI project)
       └─ Does the work, updates the Confluence SOP page
            └─ Transitions to Signoff → Acknowledge
                 └─ Jira Automation fires:
                      └─ For each Acknowledger (customfield_10651)
                           └─ Creates sub-task under DI issue
                                summary:     "Acknowledge: {name} — {doc title}"
                                assignee:    the acknowledger
                                description: instructions + Confluence URL

READER
  └─ Receives Jira sub-task notification
       └─ Opens Confluence page (URL in sub-task description)
            └─ Reads document
                 └─ Clicks ✅ I have read this document in the page byline
                      └─ Forge stores {accountId, timestamp} in KVS
                           └─ Transitions their sub-task → Done

ADMIN
  └─ Monitors via:
       ├─ Byline counter on each SOP page ("X / 25 confirmed")
       └─ 📋 Document Acknowledgement Tracker (global Confluence page)
```

---

## Repo Structure

```
doc-ack/
├── README.md
├── forge/
│   └── read-confirmations/        ← Forge app
│       ├── manifest.yml
│       ├── package.json
│       └── src/
│           ├── index.js
│           ├── constants/
│           │   └── binfxTeam.js   ← 25 hardcoded team members
│           ├── frontend/
│           │   ├── index.jsx      ← byline button
│           │   └── global.jsx     ← admin tracker page
│           ├── resolvers/
│           │   └── index.js       ← KVS read/write
│           └── webtrigger.js      ← page metadata + (legacy) sub-task creation
```

---

## Forge App

**App ID:** `ari:cloud:ecosystem::app/8ed791e8-4229-4af1-b261-c396cc92aae7`

**Modules:**

| Module | Type | Purpose |
|---|---|---|
| `read-confirm-byline` | `confluence:contentBylineItem` | Byline button on every Confluence page |
| `docack-global-page` | `confluence:globalPage` (route: `docack-tracker`) | Admin tracker dashboard |
| `docack-webtrigger` | `webtrigger` (Confluence) | Receives page metadata from Jira Automation |

**KVS keys:**

| Key | Written by | Contains |
|---|---|---|
| `read-confirmations-{pageId}` | Byline (addConfirmation) | `{ readers: [{accountId, timestamp}] }` |
| `page-meta-{pageId}` | Confluence webtrigger | `{ title, url, issueKey, updatedAt }` |

**Environment variables (encrypted):**

| Variable | Purpose |
|---|---|
| `JIRA_BASIC_AUTH` | Base64 `email:token` for direct Jira REST API calls |

### Deploying

```bash
cd forge/read-confirmations
npm install

# Development
forge deploy --no-verify
forge install --upgrade --site cuhbioinformatics.atlassian.net --product Confluence --environment development --non-interactive

# Production
forge lint --fix
forge deploy --environment production
forge install --site cuhbioinformatics.atlassian.net --product Confluence --environment production --non-interactive
```

> `forge deploy` alone is not enough — always run `forge install --upgrade` after deploying to apply scope changes.

### Webtrigger URL

The Confluence webtrigger URL is required by the Jira Automation rule. Regenerate if needed:

```bash
forge webtrigger create --functionKey docack-webtrigger \
  --site cuhbioinformatics.atlassian.net --product Confluence --environment development
```

**⚠️ Always use the Confluence product URL** — the Jira product URL writes to a different KVS partition invisible to Confluence modules.

### Updating the team list

Team members are hardcoded in `src/constants/binfxTeam.js`. To add or remove a member:

1. Find their account ID: `curl -s -u EMAIL:TOKEN "https://cuhbioinformatics.atlassian.net/rest/api/3/user/search?query=name"`
2. Edit `binfxTeam.js`
3. Commit, push, redeploy (`forge deploy --no-verify`)

The `binfx_team` Confluence group and this list are **independent** — changes to one do not affect the other.

---

## Jira Setup

**Project:** `DI` (DIAS) — `https://cuhbioinformatics.atlassian.net/jira/software/projects/DI`

**Issue type:** `Document` (ID: `10626`) — standard issue type (not sub-task)

**Workflow:** `Documentation workflow for bioinformatics 260522`

```
BACKLOG → Selected for Dev → Development → Signoff → Acknowledge → Done
                                                ↑ automation fires here
```
With `Ditch` as a terminal escape at any point.

**Custom fields used:**

| Field | ID | Purpose |
|---|---|---|
| Release development and testing | `customfield_10087` | Confluence page URL |
| Acknowledgers | `customfield_10651` | Multi-user picker — who must acknowledge |
| Acknowledgement Required | `customfield_10650` | Dropdown — Yes/No |

**Workflow scheme:** `Bioinformatics dev and release 231227` (ID: `10523`)
Maps `Document` (10626) → `Documentation workflow for bioinformatics 260522`

**Issue type scheme:** `BioX dev issue scheme` (ID: `10270`)

**Screen scheme:** `URA: Kanban Issue Type Screen Scheme` (ID: `10077`)
Fields on the **Release** tab of screen `10138`.

---

## Jira Automation Rules

Rules live in Jira and cannot be version-controlled. Documented here for recovery.

### Rule: Create acknowledgement sub-tasks on Acknowledge transition

**UUID:** `019e5149-8752-76f1-bb78-78d4a70d78d6`

| Setting | Value |
|---|---|
| Trigger | Issue transitioned → **Acknowledge** (matched by ID: `11014`) |
| Condition | Issue type = Document (10626) |
| Scope | DI project (10118) |
| Actor | Automation service account |

**Actions:**
1. Add label `needs-acknowledgement` to the Document issue
2. `jira.condition.container.block`
3. → IF `Acknowledgement Required` = `Yes — whole team` → 25 hardcoded `jira.issue.create` (one per binfxTeam member)
4. → IF `Acknowledgement Required` = `Yes — specified individuals` → `jira.smart.values.branch` over `{{issue.customfield_10651}}` → `jira.issue.create` per member

**Sub-task type:** `Acknowledge` (ID: `10659`) — sub-task issue type with its own workflow

**Sub-task fields:**
- Summary: `Acknowledge: [name] — [parent summary]`
- Description: instructions + `{{issue."Release development and testing"}}`
- Assignee: hardcoded account ID (whole team) or `{{member.accountId}}` (specified)

**Important:** Status ID `11014` is the active Acknowledge status. Status `10272` is "Final Assurance" (old name, unrelated). Use the ID in triggers to avoid ambiguity.

### Rule: Notify Forge webtrigger on DOCACK issue created

**UUID:** `019e4ac9-f67d-7393-a6c4-30c7a2c037b2`

Legacy rule for page metadata storage. Fires on DOCACK Task creation (project 10355), calls the Confluence webtrigger with `{pageUrl, pageTitle, issueKey}`.

---

## Known Issues / Gotchas

- **`toStatus` in triggers must use `type: ID` not `type: NAME`** — two statuses named "Acknowledge" exist (10272 = "Final Assurance" legacy, 11014 = active). NAME match is ambiguous. Always use ID `11014`
- **`jira.smart.values.branch` needs field ID** — use `{{issue.customfield_10651}}` not `{{issue."Acknowledgers"}}` for cross-project compatibility
- **Updating the whole-team hardcoded list** — when team changes, update both `binfxTeam.js` AND rebuild the `Yes - whole team` IF block in automation rule `019e5149` (25 hardcoded create actions)
- **Jira Automation web requests to `*.atlassian-dev.net` fail with 401** — Automation routes through Atlassian's internal network where Forge webtrigger URLs aren't reachable. Use native Automation actions for Jira operations
- **Forge KVS is scoped per product installation** — Jira-context writes are not visible to Confluence resolvers. Always use the Confluence webtrigger URL

---

## Key Resources

| Resource | URL |
|---|---|
| Document Acknowledgement Tracker | https://cuhbioinformatics.atlassian.net/wiki/plugins/servlet/ac/doc-ack-register/docack-tracker |
| System documentation | https://cuhbioinformatics.atlassian.net/wiki/spaces/DV/pages/4698374282 |
| Forge Developer Console | https://developer.atlassian.com/console/myapps |
| GitHub repo | https://github.com/eastgenomics/doc-ack |
