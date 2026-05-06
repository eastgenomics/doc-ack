# doc-ack

Document read acknowledgement system for the CUH Bioinformatics team, built on Atlassian Forge and Jira automation.

---

## Overview

When a document is published or updated, the author transitions a `Document Update` Jira issue to Done. This automatically:

1. Creates a parent issue in the `DOCACK` Jira project
2. Creates one Jira sub-task per required reader (whole team, specified individuals, or no one)
3. Writes a content property to the Confluence page linking it to the DOCACK issue
4. Notifies each assigned reader via Jira

Readers open the Confluence page, read it, and click **"✅ I have read this document"** in the page byline — provided by the Forge app. Clicking stores a timestamped confirmation and automatically closes their Jira sub-task.

---

## Architecture

```
AUTHOR
  └─ Transitions Document Update issue → Done
       └─ Rule B → creates DOCACK parent issue
            └─ Rule A → branches on Acknowledgement Required:
                 ├─ Yes — whole team       → sub-tasks for binfx_team
                 ├─ Yes — specified users  → sub-tasks for named individuals
                 └─ No                     → closes DOCACK issue immediately

READER
  └─ Receives Jira notification
       └─ Opens Confluence page → clicks Forge byline button
            ├─ Stores confirmation in Confluence Content Property
            └─ Transitions their Jira sub-task → Done

ADMIN
  └─ Monitors via:
       ├─ Byline counter on each SOP page ("14 confirmed")
       ├─ Jira Issues macro at bottom of each SOP page
       └─ 📋 Document Acknowledgement Tracker (central Confluence page)
```

---

## Repo Structure

```
doc-ack/
├── README.md
├── docs/
│   ├── build-plan.md
│   └── implementation-plan.md
├── forge/
│   └── read-confirmations/        ← Forge app (deployable)
│       ├── manifest.yml
│       ├── package.json
│       ├── package-lock.json
│       └── src/
│           └── index.tsx
└── jira/
    └── automation-rules/          ← documented config (not executable)
        ├── rule-a-create-subtasks.md
        └── rule-b-create-docack.md
```

---

## Prerequisites

- Atlassian Cloud instance: `cuhbioinformatics.atlassian.net`
- Jira and Confluence (Free plan or above)
- Node.js
- Forge CLI: `npm install -g @forge/cli`
- Service account `srv_bfx` with API token `srv_acc_token_doc_ack`
- Jira group `binfx_team` populated with all team members
- `DOCACK` Jira project configured (see [build plan](docs/build-plan.md))
- `Document Update` issue type and workflow configured in source project (see [build plan](docs/build-plan.md))

---

## Deploying the Forge App

```bash
cd forge/read-confirmations
npm install

# Deploy to sandbox
forge deploy
forge install --site cb-sandbox.atlassian.net

# Deploy to production
forge deploy --environment production
forge install --environment production --site cuhbioinformatics.atlassian.net
```

> Committing to this repo does not deploy the app. Run `forge deploy` explicitly.

---

## Jira Automation Rules

The two automation rules are configured in Jira and cannot be version controlled directly. Their configurations are documented in [`jira/automation-rules/`](jira/automation-rules/) for reference and disaster recovery.

| Rule | Project | Trigger |
|---|---|---|
| Rule B | Source project | `Document Update` issue transitioned to Done |
| Rule A | DOCACK | Issue created with label `needs-acknowledgement` |

---

## Admin Workflow

For each new or updated document requiring acknowledgement:

1. Create a `Document Update` issue in the source project
2. Do the work and publish the Confluence page
3. Transition the issue to Done — the transition screen requires:
   - `Release development and testing` (Confluence page URL)
   - `Document Version` (e.g. `v2.1`)
   - `Acknowledgement Required` (`Yes — whole team` / `Yes — specified individuals` / `No`)
   - `Acknowledgement Recipients` (if specified individuals)
4. Rule B and Rule A fire automatically (~60 seconds)
5. On the SOP page (if acknowledgement required):
   - Page Properties → `Acknowledgement Task`: paste DOCACK issue URL
   - Jira Issues macro: replace `DOCACK-REPLACE` with the real issue key
6. Monitor progress via the byline counter, the Jira Issues macro on the SOP page, or the [central tracker](https://cuhbioinformatics.atlassian.net/wiki/spaces/BFX/pages/TRACKER_PAGE_ID)

---

## Key Jira/Confluence Resources

| Resource | Location |
|---|---|
| DOCACK project | `cuhbioinformatics.atlassian.net/jira/software/projects/DOCACK` |
| Document Acknowledgement Tracker | *(update with page URL after creation)* |
| Forge app (Developer Console) | `developer.atlassian.com/console/myapps` |
| `JIRA_AUTH` secret | Jira Settings → Automation → Secrets |
| `binfx_team` group | Jira Settings → User management → Groups |

---

## Further Reading

- [Build Plan](docs/build-plan.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Atlassian Forge docs](https://developer.atlassian.com/platform/forge/)
- [Confluence Content Properties](https://developer.atlassian.com/cloud/confluence/confluence-entity-properties/)
