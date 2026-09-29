# Deployment

The project this repo deploys to is **Performance Tracker — Sandbox (Vishwash)**, script `1A8yLFO8sJm1sj7xBelT6MD4G-MO2AuSVBxP_d5prqZxD0rY9P1_lZEDy`. It is a separate Apps Script project with its own backend (a copy of production's data, made by `setUpSandbox()`), so nothing here touches the production project `1BYfLvwrBaKQUnFw3tXd4RMeZxkwM4urwORHIw4kWxaOrDoyD-kaVjeiO`.

Everything goes to **dev first**. The sandbox's live web app changes only when someone promotes it by hand.

| Stage | When it happens | What changes |
|---|---|---|
| **Dev** | Automatically, on every push to `claude/operations-kra-kpi-tracker-4c02x4` that changes `Code.gs`, `Index.html` or `appsscript.json` (workflow *Deploy to dev*) | The sandbox project's code. Only its **test deployment** runs it: the `/dev` link, open to editors of the project. |
| **Live** | Only when *Actions → Promote to production → Run workflow* is run with `promote` typed in the confirm box | The sandbox's web app (`/exec`) moves to a new version of the code. |

**Dev and live share the sandbox's database.** Imports, saves or seeding run while testing on the `/dev` link change the sandbox's data (never production's).

## One-time setup

All of this is done as **vishwash.tiwari@recykal.com**, who has edit access to the sandbox project.

1. **Turn on the Apps Script API:** <https://script.google.com/home/usersettings> → *Google Apps Script API* → On.
2. **Create the clasp login.** This needs Node.js 18 or later (<https://nodejs.org>). In a terminal, run:
   ```
   npx @google/clasp@2.4.2 login
   ```
   Sign in as vishwash.tiwari@recykal.com and allow access. This writes `.clasprc.json` in your home folder (`C:\Users\<you>\.clasprc.json`). **It is a credential: never commit it or paste it anywhere except the GitHub secret below.** Use this exact version (2.4.2): the workflows use it too, and other versions write the file differently.
3. **Add the GitHub secrets:** in the repository, go to *Settings → Secrets and variables → Actions → New repository secret*.
   - `CLASP_CREDENTIALS`: the whole contents of that `.clasprc.json`.
   - `CLASP_DEPLOYMENT_ID`: the sandbox web app's deployment ID. In the sandbox's Apps Script editor, open *Deploy → Manage deployments* and copy the web app's *Deployment ID*.
   - `CLASP_SCRIPT_ID`: only needed to deploy somewhere else. The workflows default to the sandbox above.
4. **First dev deploy:** *Actions → Deploy to dev → Run workflow*. It pushes the branch's current code to dev.

If the login in step 2 says the app is blocked by your organisation, a Google Workspace admin at recykal.com has to allow clasp.

## Rules

- **Change code in GitHub, not in the Apps Script editor.** Each dev deploy replaces the project's files with this branch's; `clasp push` also deletes any file that exists only in the editor. If someone has edited in the editor, fold those edits into the repo first.
- **Promote only after checking the change on the `/dev` link.** Promotion deploys the branch's latest commit, which is the code dev is already running.
