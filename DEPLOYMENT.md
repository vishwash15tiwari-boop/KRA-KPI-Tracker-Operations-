# Deployment

Everything goes to **dev first**. Production changes only when someone promotes it by hand.

| Stage | When it happens | What changes |
|---|---|---|
| **Dev** | Automatically, on every push to `claude/operations-kra-kpi-tracker-4c02x4` that changes `Code.gs`, `Index.html` or `appsscript.json` (workflow *Deploy to dev*) | The Apps Script project's code. Only the **test deployment** runs it: the `/dev` link, open to editors of the project. |
| **Production** | Only when *Actions → Promote to production → Run workflow* is run with `promote` typed in the confirm box | The live web app (`/exec`) moves to a new version of the code. |

**Dev and production share one database.** Imports, saves or seeding run while testing on the `/dev` link change the real data.

## One-time setup

All of this is done as **vishwash.tiwari@recykal.com**, the owner of the Apps Script project.

1. **Turn on the Apps Script API:** <https://script.google.com/home/usersettings> → *Google Apps Script API* → On.
2. **Create the clasp login.** This needs Node.js 18 or later (<https://nodejs.org>). In a terminal, run:
   ```
   npx @google/clasp@2.4.2 login
   ```
   Sign in as vishwash.tiwari@recykal.com and allow access. This writes `.clasprc.json` in your home folder (`C:\Users\<you>\.clasprc.json`). **It is a credential: never commit it or paste it anywhere except the GitHub secret below.** Use this exact version (2.4.2): the workflows use it too, and other versions write the file differently.
3. **Add the GitHub secrets:** in the repository, go to *Settings → Secrets and variables → Actions → New repository secret*.
   - `CLASP_CREDENTIALS`: the whole contents of that `.clasprc.json`.
   - `CLASP_DEPLOYMENT_ID`: the production deployment's ID. In the Apps Script editor, open *Deploy → Manage deployments* and copy the web app's *Deployment ID*. The handover recorded `AKfycby_i1JVIRNUeEX3C0LsGA6CccU9nNSN52AC5k-9CqOQNL0S0olhUGm5YW-Jsx-u7Pv4`; make sure it is still the deployment people use.
   - `CLASP_SCRIPT_ID`: only needed if the app ever moves to another project. The workflows default to `1BYfLvwrBaKQUnFw3tXd4RMeZxkwM4urwORHIw4kWxaOrDoyD-kaVjeiO`.
4. **First dev deploy:** *Actions → Deploy to dev → Run workflow*. It pushes the branch's current code to dev.

If the login in step 2 says the app is blocked by your organisation, a Google Workspace admin at recykal.com has to allow clasp.

## Rules

- **Change code in GitHub, not in the Apps Script editor.** Each dev deploy replaces the project's files with this branch's; `clasp push` also deletes any file that exists only in the editor.
- **Promote only after checking the change on the `/dev` link.** Promotion deploys the branch's latest commit, which is the code dev is already running.
