# Deployment

## Prerequisites

* A Google Workspace account with permission to create Apps Script projects.
* A Google Sheet to act as the backend database (a new, empty one).
* Read access to the operational workbook that holds `Overall Shipments`,
  `Seller Onboarding` and `MTD Pulse Summary`.
* Node.js 18+ and `clasp` if you want to push from the command line
  (`npm install -g @google/clasp`).

---

## 1. Create the project

### Option A — bound to the backend spreadsheet (recommended)

1. Create a new Google Sheet named e.g. **OMP Operations Tracker — DB**.
2. **Extensions → Apps Script**. The project is created bound to that sheet.
3. Copy the files in as described in step 2.

Binding means `SpreadsheetApp.getActiveSpreadsheet()` resolves automatically and
the administration menu appears inside the sheet.

### Option B — standalone

1. Create a standalone script at <https://script.google.com>.
2. Create the backend spreadsheet separately.
3. After deploying, set the script property `OMP_DB_SPREADSHEET_ID` to its ID
   (**Project Settings → Script Properties**).

---

## 2. Copy the source

### With `clasp`

```bash
cp .clasp.json.example .clasp.json      # then fill in your scriptId
clasp login
clasp push
```

`.clasp.json` points `rootDir` at `src/`. `clasp` flattens the tree, so
`src/server/06_Engine.gs` and `src/client/Index.html` both land at the project
root — which is what Apps Script expects.

### By hand

In the Apps Script editor, create one file per source file:

* **Script files** — every `src/server/*.gs`, keeping the numeric prefixes. They
  set the load order and the code depends on it.
* **HTML files** — every `src/client/*.html`, keeping the exact names
  (`Index`, `Styles`, `ClientCore`, `ClientComponents`, `ClientBoot`,
  `ViewSetup`, `ViewDashboard`, `ViewMyDay`, `ViewPlanning`, `ViewActivity`,
  `ViewAccounts`, `ViewReports`, `ViewReview`, `ViewAdmin`).
  `Index.html` includes the others by name.
* **Manifest** — enable **Show "appsscript.json" manifest file** under Project
  Settings, then paste `src/appsscript.json` over it.

---

## 3. First run

1. In the editor, select `setupFirstRun` and **Run**.
2. Authorise the scopes when prompted (Sheets, Drive file, external requests,
   script app, user email).
3. The log shows the created tables and names you as the first administrator.

`setupFirstRun` creates all 23 backend tables, seeds configuration defaults and
regions, and installs the KRA/KPI library transcribed from the source workbook.
It is safe to run again — the migration is forward-only and never drops a column.

---

## 4. Deploy the web app

**Deploy → New deployment → Web app**

| Setting | Value |
|---------|-------|
| Execute as | **User accessing the web app** |
| Who has access | **Anyone within your organisation** |

Executing as the accessing user is deliberate: it means the audit trail records
the real person, and Google's own access controls apply to the backend sheet.

Open the deployment URL. The first sign-in lands on the setup wizard if the
schema is missing, otherwise on the dashboard.

> Re-deploy after every code change: **Deploy → Manage deployments → Edit → New
> version**. The `/dev` URL always runs the latest code and is useful while
> iterating. Section 13 covers doing this step automatically from GitHub.

---

## 5. Install the scheduled jobs

From the spreadsheet menu **⚙️ OMP Ops Tracker → Install scheduled jobs**, or run
`Bootstrap.installTriggers()` in the editor.

| Job | Time (IST) | Purpose |
|-----|-----------|---------|
| `jobNightlySync` | 02:00 | Import shipments, onboarding and field visits. |
| `jobDailySnapshot` | 06:00 | Freeze metric values for trend history. |
| `jobDailyAlerts` | 08:00 | Email each owner their attention list. |

---

## 6. Configure the organisation

### 6.1 Regions

**Administration → Users & Regions → Regions.** North and South exist from the
seed; set the Regional Head on each and add the states it covers.

### 6.2 Users

**Administration → Users & Regions → Users → ＋ User.**

| Field | Notes |
|-------|-------|
| Full name | **Must match the name used in the source spreadsheets.** This is how the sync links a transaction to a person. |
| Work email | Their Google account. Without it they cannot sign in. |
| Role | `POC`, `RH`, `TEAM_LEAD`, `LEADERSHIP`, `VIEWER`, `ADMIN`. |
| Category | `Plastic`, `Metal`, or `ALL`. |
| Region | Required for `POC` and `RH`. |
| Name aliases | Pipe-separated alternative spellings, e.g. `Joy Deep\|Joydeep D`. |

If the sync meets a name it does not recognise it creates a **provisional** user
rather than orphaning the transaction. Those appear flagged in the user list;
either complete the profile or use **Merge** to fold it into an existing account —
which moves every account, activity, shipment, onboarding record, visit and
assignment across, and keeps the old name as an alias.

---

## 7. Connect the source workbook

**Administration → Data Sync.**

1. Paste the source spreadsheet ID (the segment between `/d/` and `/edit`), or
   leave it blank to use the configured default — see `SOURCE_SPREADSHEET_ID`
   under **Settings → Data source** — or, if that is also unset, the source
   tabs in this same spreadsheet.
2. **Check access** confirms the connection and lists the tabs it found.
3. **Sync everything.**

Whichever account the Apps Script project runs as needs at least view access
to the source spreadsheet.

The sync reads:

| Source sheet | Becomes |
|--------------|---------|
| `🚚 Overall Shipments` | `DB_Shipments` + seller/buyer accounts |
| `🏢 Seller Onboarding` | `DB_Onboarding` + seller accounts |
| `📍 MTD Pulse Summary` | `DB_Pulse` (normalised to one row per person per day) |

It is idempotent — rows upsert on their natural key, so re-running corrects rather
than duplicates. Warnings appear in the result panel and in the sync history.

---

## 8. Create the first cycle

**Monthly Plan → ＋ New cycle.** Pick the category, month and working days.
Choosing *Start from the KRA library* clones the KRA/KPI structure taken from the
source workbook; choosing an existing cycle carries its structure **and** its
account plan forward.

Then work through the tabs:

| Tab | What to do |
|-----|-----------|
| **KRAs & KPIs** | Review the cloned structure. Each stream must total 100% weightage. |
| **Assignments** | Select the POCs and the KPI set they own. One action assigns the whole set. |
| **Account Plan** | Enter tonnage and rate per account — GMV is derived. **Import from spreadsheet** reads the existing `OMP-Sellers` target columns so a month already planned need not be retyped. |
| **Annual Onboarding Plan** | The yearly acquisition number per POC. The monthly target is `(annual − achieved so far) + achieved this month`, so shortfalls carry forward. |
| **Readiness** | Every blocking issue and warning in one list. |

**Publish** when Readiness is clean. Publishing makes the plan visible to POCs and
opens the cycle for activity capture.

---

## 9. Verify

| Check | Where |
|-------|-------|
| Schema healthy | **Settings** — table row counts |
| Source data present | **Data Sync** — history shows rows read and inserted |
| Numbers reconcile | **Daily Review** — compare against the current WhatsApp summary |
| Traceability works | Click any achieved figure — the drawer lists the underlying records |
| Data quality | **Needs Attention** — unmapped accounts, stale sync, plan gaps |
| Permissions | Sign in as a POC; confirm they see only their own book |

---

## 10. Running the tests

```bash
node tests/engine.test.js
```

121 assertions run the real server code against the raw workbook data in an
in-memory Apps Script environment. Run this before any deployment that touches
the engine, the window algebra or the sync.

To refresh the fixtures from a newer workbook, re-export
`Overall Shipments`, `Seller Onboarding` and `OMP-Sellers` to
`tests/fixtures/*.json` and update the expected values with the cell references
they came from.

---

## 11. Operations

### Settings that change reported numbers

**Settings → Value basis.** Two exist because the source workbook was internally
inconsistent (see `docs/WORKBOOK-ANALYSIS.md` §8):

| Key | Default | Legacy value |
|-----|---------|--------------|
| `GMV_BASIS` | `TAXABLE` — ex-GST, comparable across all windows | `TOTAL` reproduces the legacy FYTD figure |
| `RATE_GST_DIVISOR` | `1` | `1.18` reproduces the legacy realised rate |

Every affected dashboard states which basis is active in its footnote.

### Month-end

1. **Lock** the cycle — no further activity, scores freeze.
2. **Monthly Review** — the pack assembles the leaderboard, regional performance,
   alerts, data quality and open actions.
3. Open each POC's review, record strengths and gaps, share, sign off.
4. **Close** the cycle.
5. Create next month's cycle by copying this one.

### Backups

Google Sheets keeps full version history. For a point-in-time copy:
**File → Make a copy** of the backend spreadsheet before any schema migration.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| *"Your account has not been granted access"* | No `DB_Users` row for that email | Add the user under Administration |
| *"No backend spreadsheet is configured"* | Standalone script, no `OMP_DB_SPREADSHEET_ID` yet, and `DEFAULT_DB_SPREADSHEET_ID` in `00_Config.gs` could not be opened | Reload — the Setup wizard should now appear instead; if it still fails, set the script property manually or fix the default constant |
| Setup wizard appears repeatedly | `Bootstrap.setup()` failing partway | Run `Bootstrap.health()` in the editor and read `missingSheets` |
| Numbers differ from the spreadsheet | A filter is applied to the source sheet, or GMV basis differs | Check the dashboard footnote; see analysis §8 defects 1 and 13 |
| Sync creates provisional users | A name in the source has no matching user | Merge them under Administration → Users |
| *"Another update is in progress"* | Two writes collided on the document lock | Retry; it clears in seconds |
| Dashboard reports yesterday | By design — `REPORTING_LAG_DAYS = 1`, matching the source import lag | Set to `0` if your sync becomes same-day |
| Execution timeout during sync | More than ~20,000 source rows | Raise `MAX_ROWS_PER_READ`, or sync each source separately |

---

## 13. Continuous deployment (optional)

`.github/workflows/deploy.yml` pushes `src/` to your Apps Script project with
`clasp` on every commit — tests run first, and a failing suite blocks the
push. It needs the project to already exist (step 1) and, for a stable
production URL, an initial deployment to already exist (step 4). CI then
only pushes new *versions* into that same project and deployment; it never
creates the project or changes who the deployment executes as.

### One-time setup

1. **Create the project and deploy it once, by hand** — steps 1–4 above.
   Note the **script ID** (Project Settings, or the `.clasp.json` you get
   from `clasp clone`) and the **deployment ID** (Deploy → Manage
   deployments — the ID under the deployment you want CI to keep updating).

2. **Get clasp credentials for CI.** From any machine with Node:

   ```bash
   npm install -g @google/clasp
   clasp login
   cat ~/.clasprc.json
   ```

   `clasp login` opens a browser sign-in once; `~/.clasprc.json` is the
   resulting token. Copy its full contents — this is a credential, so treat
   it like a password and only ever paste it into the GitHub secret below,
   never into a file that gets committed.

3. **Add three repository secrets** — GitHub repo → **Settings → Secrets and
   variables → Actions → New repository secret**:

   | Secret | Value |
   |--------|-------|
   | `CLASP_CREDENTIALS` | The full contents of `~/.clasprc.json` from step 2 |
   | `CLASP_SCRIPT_ID` | The script ID from step 1 |
   | `CLASP_DEPLOYMENT_ID` | The deployment ID from step 1 (optional — see below) |

4. Push a commit. **Actions** tab shows the run: tests, syntax check, `clasp
   push`, then `clasp deploy -i` against your deployment ID.

### If `CLASP_DEPLOYMENT_ID` is left out

The workflow still runs and still pushes code, but only to the project's
*head* version — visible at the `/dev` URL to people with editor access, not
at the production web app URL. This is a reasonable choice while iterating
alone; add the secret once you want every push to go live automatically.

### Rotating or revoking access

`clasp login` credentials are a standing grant. Rotate them the same way as
any leaked secret: run `clasp logout` on the machine you generated them
from (or revoke the app under your Google Account's **Third-party access**
settings), generate a fresh `~/.clasprc.json`, and update the
`CLASP_CREDENTIALS` secret.
