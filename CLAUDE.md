# CLAUDE.md — KRA / KPI Performance Management Platform

> Project instructions for Claude Code. Loaded automatically. Treat this repo as
> the **source of truth**. Preserve working business logic and backend-derived
> calculations unless there is a justified, stated reason to change them.

## 1. What this is
A **KRA / KPI Performance Management & Improvement platform** for Recykal —
management, team leads, HR, employees. It is a **Google Apps Script web app**,
shipped as exactly **two deployable files** (there is no build step, no bundler,
no npm):

- **`Code.gs`** — Apps Script backend. `doGet()` serves `Index.html`.
- **`Index.html`** — the entire frontend: one self-contained vanilla-JS SPA
  (inline `<style>` + `<script>`, one Google-Fonts `<link>`, no other external
  assets, no libraries).

Keep it two files. Do not introduce a build toolchain or external dependencies.

## 2. Product north star (do not drift from this)
The **KRA/KPI system is the product** — not an HRMS, not a task manager. Every
important number must be traceable along the chain:

`Business → Vertical → Category → Team → Employee → KRA → KPI → Target → Actual → Achievement → Variance → Gap → Action → Review → Improvement → Next period`

Principles (these are requirements, not taste):
- **Visibility ≠ permission.** Every role *sees* the whole performance picture;
  role gates only what can be *changed*. Never hide information just because a
  user cannot edit it. Only the **Admin** governance surface is role-scoped.
- **No duplicate screens.** Each authoritative detail has exactly **one home**;
  a summary may appear elsewhere. Before adding a screen ask "what is this
  uniquely responsible for?"
- **Premium, structured, minimal** — Groww-*inspired* product philosophy
  (simplicity, hierarchy, progressive disclosure, contextual drawers/tabs,
  drill-down). **Never copy Groww's branding/UI/assets.** Prefer detailed
  structured info (`82 · 82/100 · ▼4 vs Jul`) over big percentage cards.
- Every screen should answer: **what is happening · why · who owns it · what
  changed · what needs attention · what should happen next.**
- Real governance is part of the product: **approvals, audit history, period
  lifecycle, versioning, data quality, exceptions, accountability.**

## 3. Architecture & source-of-truth (dual sheet)
Two Google Sheets. The app reads its base model from the **primary** sheet and
**overlays** individual/team configuration + team assignment from the **config**
sheet. Overlays are defensive — a missing/unshared/empty config sheet leaves the
base model untouched, so the app never breaks.

- **Primary backend** `BACKEND_SHEET_ID` (`Code.gs`): master tabs
  `TEAM_MASTER · EMPLOYEE_MASTER · KRA_MASTER · KPI_MASTER · EMPLOYEE_KPI_MAPPING
  · THRESHOLDS · MONTHLY_TARGETS · ACTUAL_PERFORMANCE · PERFORMANCE · ACTIONS ·
  KPI_COMMENTS · REVIEWS · AUDIT_LOG · MONTH_STATE`. Helpers are `m*_` / `bkSS_()`.
  When empty the app falls back to the **in-code master** (`buildMaster_`), so it
  renders with no setup.
- **Config sheet** `CONFIG_SHEET_ID` (dedicated, dual-sheet by design — primary
  is never rewritten for config): 7 tabs `Employees · KRA_KPI_Master ·
  Individual_KRA_KPI · KRA_KPI_History · Users_Access · Lookup_Master ·
  System_Log`. Helpers are `cfg*_` / `cfgSS_()`, kept **isolated** from the
  primary helpers. Run **`provisionConfigSheet()`** once to create + seed it.
- **`buildModel_(teamId, month)`** returns the whole model in one round trip and
  applies overlays in this **precedence order** (each try/catch-guarded):
  1. `applyTeamAssignments_` — move an employee to a reassigned team.
  2. `applyTeamTemplate_` — a team template (`Individual_KRA_KPI` keyed
     `TEAM:<id>`) for members with no personal override.
  3. `applyIndividualConfig_` — a person's individual config (wins over team).
  4. `applyMonthClosePolicy_` — month lifecycle (a Closed month turns a missing
     actual into a 0% miss unless waived).
  Actuals always come from the **primary** sheet by `kpi_id`; targets are
  month-scoped (`MONTHLY_TARGETS` overrides the config default).

**Model shape the frontend consumes** (leaner than the sheet): `{ ok, month,
months[], teams[], scorecards[]{ employee_id, employee_name, team_id,
designation, reporting_manager, overall_score, kpi_achievement, status,
measured_weightage, kpis[]{ kpi_id, kpi, kra, perspective, weightage, unit,
direction, source, goal, target, actual, achievement, variance, weighted_score,
level, status, config_id?, configured?, target_status? } }, actions[],
comments[], reviews[], audit[], month_states?, generated_at, source, records }`.

## 4. Calculations — preserve, don't reinvent
Scoring is backend-authoritative. Do not re-derive it in the client beyond
presentation. Key backend fns: `achievementPct_` (direction-aware — lower DSO
raises achievement; capped at `ACHIEVEMENT_CAP_PCT` = 105; has a zero-target
path; suppresses sub-one-unit COUNT targets), `weightedScore_`, `statusFor_`
(the **one status contract**: Exceeded ≥100 / On Track ≥90 / At Risk ≥75 / Off
Track / Pending Data→null). Overall score = Σ weighted_score; member achievement
= weighted score restated over measured weightage. Client tone helper: `tone()`.

## 5. Permissions (server is authoritative; client mirrors)
Roles from `resolveSession_`: **Management · HR · Manager · Employee** (+`admin`).
Backend gates (each write: `resolveSession_` → `require*` → validate → write →
`audit_`/`sysLog_`/`histRow_` → `return jsonSafe_({ok, model: buildModel_(...)})`):
- `canWriteFor_` / `requireWrite_` — actuals/actions/comments (self or manager-chain).
- `canEditConfig_` / `requireEditConfig_` — individual KRA/KPI config (Users_Access
  `can_edit_config`, else role/manager fallback).
- `canEditTeam_` / `requireEditTeam_` / `isTeamLead_` — team template (admin/HR/
  Management or the team's root/lead).
Client mirrors (visibility of controls only — never the security boundary):
`canConfig()`, `canConfig`/`canEditTeam` via `effRole()` (respects the "View as"
preview `S.viewRole`), `canWrite(ownerId)`. Nav: `COMMON_NAV` is identical for all
non-admin roles; only Admin is added for HR/Management.

## 6. Frontend conventions (Index.html)
- **Global state `S`**; **`render()`** rebuilds `#view` via `innerHTML` and calls
  `buildRail()`/`buildTopbar()`/`renderDrawer()`. Events are **delegated** on
  `document` (`click`/`change`/`input`/`keydown`) — there are no per-element
  listeners, so new markup "just works".
- **Forms must not trigger a re-render while open.** The config editor and
  drawers edit the DOM directly (add/remove rows, live totals) and read values on
  save — a `render()` mid-edit destroys unsaved input. Follow this pattern for any
  new form.
- **One drawer system**: `S.detail = {kind, …}` + `renderDrawer()` (kinds: kpi,
  score, def, fresh, action, review, assign, autoassign, config). It traps focus
  and locks background scroll (`Lock`). Reuse it; don't build modal #2.
- **Helpers**: `esc()` (ALWAYS escape user/sheet data into HTML), `show`/`n1`/
  `fmt(v,unit)`/`plural`/`monthShort`/`monthLabel`/`deltaText`. Numbers use
  `font-variant-numeric: tabular-nums`.
- **Chart toolkit** (self-contained, CSS-driven, re-render-safe): `BarTrend`
  (column trend, tinted by direction), `Donut` (status mix), `VBars` (comparison),
  `KraBars` (achievement bars), `PerfChart` (profile KPI bars), `RankList`. A
  shared `MiniStat(l, v, sub)` renders the inline metric pattern.
- **Design tokens** live in `:root` (palette incl. brand blue `--accent:#005DFF`,
  spacing `--s1..--s8`, radii, `--font` Inter). Use tokens, not hard-coded values.
  Status colours are restrained; **data-quality (Pending Data) is neutral, not
  red** — keep Performance / Data / Config exceptions visually distinct (`§34`).
- **Reuse over duplicate**: team workspace tabs reuse `KpiTable`, the action rows,
  review rows, `RankList`, `ExceptionsPanel`. New views should do the same.

## 7. Coding standards
- Vanilla ES5-flavoured JS (Apps Script V8; the frontend targets broad browsers).
  No arrow-heavy rewrites of existing code, no TS, no frameworks, no libraries.
- Match the **surrounding style and comment density**. Comments explain *why*.
- **Line endings**: git stores **LF**; the working copy checks out CRLF. Before
  editing with the Edit tool, normalize the file to LF (`sed -i 's/\r$//'`) so
  matches succeed and the diff stays content-only. `Set-Content` in PowerShell can
  corrupt `₹`/UTF-8 — use .NET `File.WriteAllText` with a no-BOM UTF-8 encoder.
- Balance braces/parens after big edits (`awk` count). No build = no compiler to
  catch you.

## 8. Local preview & verification (no live sheet here)
There is no access to the live Sheets from the dev environment. Verify the
**frontend** with a mock harness:
- Build `preview.html` = `Index.html` + `scratchpad/fixture.js` (a base model
  matching `apiMasterModel`'s shape + a `google.script.run` Proxy that mocks the
  write APIs, incl. `apiKpiConfig`/`apiSaveKpiConfig`/`apiSaveTeamKpi`/
  `apiAssignTeam`/`apiAutoAssignTask`), injected before the app `<script>`, then
  **enable demo AFTER the model loads** (poll `if (S.model) { S.demo = true; … }`
  — forcing demo before `load()` throws a benign boot race).
- Assemble via the PowerShell `.NET File I/O` snippet (UTF-8, no BOM). The repo's
  own `_preview_boot.js` / `scripts/` are **STALE** (old model shape) — ignore.
- The Browser pane is **not composited** here → screenshots fail. Verify with
  `read_page` / `get_page_text` / `javascript_tool` (use `getBoundingClientRect`
  for alignment) and `resize_window` to force a viewport. Every change: **0
  console errors, no horizontal overflow, mobile (375) stacks.**

## 9. Deploy (what the user does)
Paste `Code.gs` + `Index.html` into the Apps Script editor → **Deploy → Manage
deployments → edit → New version**. For the config features: **share the config
sheet with the web-app account (Editor)** and run **`provisionConfigSheet()`**
once. First write auto-creates any missing tabs.

### Continuous deployment (optional)
`.github/workflows/deploy.yml` pushes `Code.gs` + `Index.html` to the Apps
Script project with `clasp` on every push to this branch, then (if
`CLASP_DEPLOYMENT_ID` is set) rolls the live web app URL forward. It needs an
Apps Script project that already exists and has been deployed by hand at
least once (§9 above) — CI only pushes new *versions* into that same
project/deployment; it never creates the project or changes who it executes
as. `.claspignore` keeps the push scoped to just those two files + the
manifest — this root also holds the unrelated PerformOS app, which clasp
must never see.

**One-time setup:**
1. **Note the script ID and deployment ID** of your existing deployment —
   Project Settings in the Apps Script editor has the script ID; **Deploy →
   Manage deployments** has the deployment ID under the deployment you want
   CI to keep updating.
2. **Get clasp credentials for CI**, from any machine with Node.js:
   ```bash
   npm install -g @google/clasp
   clasp login
   cat ~/.clasprc.json
   ```
   `clasp login` opens a one-time Google sign-in in your browser (only you
   can complete this — it's your account). `~/.clasprc.json` is the
   resulting token. Copy its full contents; treat it like a password — paste
   it only into the GitHub secret below, never into a committed file.
3. **Add three repository secrets** — this repo → **Settings → Secrets and
   variables → Actions → New repository secret**:

   | Secret | Value |
   |---|---|
   | `CLASP_CREDENTIALS` | full contents of `~/.clasprc.json` from step 2 |
   | `CLASP_SCRIPT_ID` | the script ID from step 1 |
   | `CLASP_DEPLOYMENT_ID` | the deployment ID from step 1 — optional, see below |
4. Push a commit that touches `Code.gs` or `Index.html`. The **Actions** tab
   shows the run.

**Leaving out `CLASP_DEPLOYMENT_ID`:** the workflow still runs and still
pushes code, but only to the project's *head* version (the `/dev` URL, for
editors) — not the production web app URL. Reasonable while only one person
is iterating; add the secret once every push should go live automatically —
that trade-off is yours to make, not a default this file picks for you.

**Rotating or revoking access:** `clasp login` credentials are a standing
grant. Rotate them like any leaked secret — `clasp logout` on the machine
you generated them from (or revoke under your Google Account's *Third-party
access*), generate a fresh `~/.clasprc.json`, update the `CLASP_CREDENTIALS`
secret.

## 10. Git & concurrent-session discipline
Branch: **`claude/operations-kra-kpi-tracker-4c02x4`** (owner `vishwash15tiwari-boop`).
**Multiple Claude sessions push to this branch simultaneously.** Always:
`git fetch` → check `git rev-list --left-right --count HEAD...origin/<branch>` →
if diverged, **rebase onto origin** (never `--force`, never clobber the other
session's commits) → verify → push (fast-forward). Commit messages end with a
`Co-Authored-By:` line. For this app, commit only `Code.gs`/`Index.html` and
the deploy scaffolding (`.github/workflows/deploy.yml`, `.claspignore`,
`.gitignore`, `.clasp.json.example`) — never `preview.html` or scratchpad
files. (This root also holds the unrelated **PerformOS** app — see
`PERFORMOS.md` — which has its own files and is not part of this app's
deploy path; `.claspignore` keeps `clasp push` from ever touching it.)

## 11. How to work here (decision-first)
Before anything significant: **state the problem, assumptions, alternatives,
trade-offs, the proposed solution, and downstream impact** — then implement the
**smallest coherent change** and verify it integrates cleanly. Never blindly add
features. Never create a duplicate screen for a job that already has a home.
Never optimise for visual novelty over usability. Keep changes incremental — do
not rewrite working systems blindly.

## 12. Open decisions / known debt (currently under audit — do NOT act unilaterally)
- **Nav overlap**: standalone `KpiScreen` ("KRA/KPI") and `ReviewsScreen`
  duplicate the team-workspace KRA/KPI & Reviews tabs; "Team" vs "Teams";
  Targets vs KRA/KPI both show target/actual/achievement.
- **`ExceptionsPanel` renders twice** in the team workspace (Overview + People).
- **`ExecutiveOverview` is orphaned** — removed from nav (Phase 1) but still in
  the `render()` switch (`S.view==='overview'`). Candidate for deletion.
- **Team comparison** appears in both Teams (`TeamsTable`) and Analytics (`VBars`).
- **Data-gated (not built, would need data/schema, do not fake)**: Geography /
  India-map + buyer-seller (§31/§32), trajectory/pace (§36, needs intra-period
  actuals), a full Business/Vertical/Category context bar (§6).

## 13. File map
- `Code.gs`: constants → in-code master (`buildMaster_`) → provisioning
  (`provisionMaster`, `provisionConfigSheet`) → sheet helpers (`m*_`, `cfg*_`) →
  `buildModel_` + overlays → session/permissions → write APIs (`apiSave*`,
  `apiAssignTeam`, `apiAutoAssignTask`) → utilities.
- `Index.html`: `:root` tokens + component CSS → data layer (`S`, `Api`, `Demo`,
  `Sel`, `Hist`) → chart toolkit → panels/screens → drawer → render/rail/topbar →
  delegated event listeners → `load()`.
