# Installing TapThat

TapThat has two halves:

- **Part 1 — the service side.** A small program called the **sidecar** runs next to your
  app's dev server. When someone presses *Apply to dev*, it has Claude edit the code, and
  your dev server shows the change right away. A developer sets this up once per dev
  environment.
- **Part 2 — the client side.** The **TapThat browser extension**. Everyone who reviews the
  site installs it: designers, PMs, QA, developers. No command line needed.

> **Only want to copy comments to your clipboard?** Skip Part 1. The extension works on
> its own (that's *TapThat Light*): comment, press **Export**, and paste the result into
> any coding agent. Do only [Part 2, steps 1–2](#part-2--the-client-each-reviewers-browser).

> ⚠️ **Never run the sidecar in production.** It changes code on request. It belongs next to
> a *development* server only.

---

## Part 1 — The service side (once per dev environment)

Pick the one that matches where your dev server runs:

- **[A. On your own computer](#a-on-your-own-computer)**: you run `npm run dev` locally.
- **[B. Docker Compose](#b-docker-compose)**: your dev stack is a `docker-compose` file.
- **[C. Railway](#c-railway-or-another-hosted-platform)** or another hosted platform: the
  dev site has a public URL that reviewers open.
- **[D. A playground environment](docs/playground.md)**: reviewers change several services
  at once (say the app *and* its API) in a separate environment, then send everything to
  your `dev` branch with one **Commit to dev**. On Railway it is one command, run in a
  folder linked to your project:
  ```sh
  npx tapthat-server install
  ```
  It asks three things (platform, dev branch, site), shows everything it will set up,
  and does it after one confirmation. See [the playground guide](docs/playground.md#the-installer).

What you need for all of them:

- The app's code in **git**, and a branch for the agent to commit to, such as `dev`.
  **Never `main`.**
- A **Claude credential**: an API key from console.anthropic.com (`sk-ant-…`), or a
  token from `claude setup-token`. Reviewers can each bring their own instead (Part 2,
  step 4).

### A. On your own computer

You need Node.js 20+ and git.

1. **Install the Claude Code CLI** (the agent the sidecar runs):
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. **Go to your app's repository and switch to the branch the agent should use:**
   ```bash
   cd path/to/your-app
   git switch -c dev
   ```
3. **Add the sidecar** as a development-only dependency:
   ```bash
   npm install --save-dev tapthat-server
   ```
   <details><summary>Not on npm yet? Install it from source instead.</summary>

   ```bash
   git clone https://github.com/ljellevo/tapthat.git ~/tapthat
   (cd ~/tapthat && npm ci && npm run build -w tapthat-server)
   npm install --save-dev ~/tapthat/packages/server
   ```
   Every step below is the same.
   </details>
4. **Set it up.** This writes `tapthat.config.json`, creates a secret access token, and
   prints the values you'll paste into the extension:
   ```bash
   npx tapthat-server init
   ```
   Check the printed dev-server address. If your app doesn't run on it, edit
   `devServerUrl` and `allowedOrigins` in `tapthat.config.json`.
5. **Commit the config** (the secrets file is already gitignored):
   ```bash
   git add tapthat.config.json .gitignore && git commit -m "Add TapThat"
   ```
6. **Start your dev server** as usual, then **start the sidecar** in a second terminal:
   ```bash
   npm run dev
   ```
   ```bash
   TAPTHAT_ENABLE=1 npx tapthat-server
   ```
   It prints a **Sidecar URL** (`http://localhost:7420`) and a **Token**. Keep them for
   Part 2.

Optional: to use one shared Claude key instead of each reviewer's own, start it with
`ANTHROPIC_API_KEY=sk-ant-… TAPTHAT_ENABLE=1 npx tapthat-server`.

### B. Docker Compose

You need Docker, and Node.js on your machine for the one-time `init`.

1. **In your app's repository, on the agent's branch**, create the config and secrets:
   ```bash
   git switch -c dev
   npx tapthat-server init
   ```
   <details><summary>Not on npm or ghcr yet? Build both from source.</summary>

   ```bash
   git clone https://github.com/ljellevo/tapthat.git ~/tapthat
   (cd ~/tapthat && npm ci && npm run build -w tapthat-server)
   node ~/tapthat/packages/server/dist/cli.js init
   docker build -f ~/tapthat/packages/server/Dockerfile -t ghcr.io/ljellevo/tapthat-server:latest ~/tapthat
   ```
   </details>
2. **Copy [`docker-compose.dev.yml`](packages/server/examples/docker-compose.dev.yml)**
   into your repository and adjust the `web` service to how your app runs (build, command,
   port).
3. **Start everything:**
   ```bash
   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f docker-compose.dev.yml up
   ```
4. Your **Sidecar URL** is `http://localhost:7420`. Your **Token** is the
   `TAPTHAT_TOKEN` line in `.tapthat/secrets.env`.

If changes get committed but the page never updates, uncomment the polling line in the
compose file. See [troubleshooting](docs/troubleshooting.md).

### C. Railway (or another hosted platform)

Here the sidecar runs as its own service. It downloads your code, installs it, starts the
dev server, and serves the whole dev site on one public URL. Your app's repository must
be on GitHub (or anywhere git can clone from).

1. **Create a `dev` branch** in your app's repository and push it.
2. **Create a GitHub token** that can read the repository: a fine-grained token with
   *Contents: read*. Skip this if the repository is public.
3. **In Railway, add a new service:**
   - Deploy from the Docker image `ghcr.io/ljellevo/tapthat-server:latest`. If the image
     isn't published yet, deploy from the GitHub repo `ljellevo/tapthat` and set the
     variable `RAILWAY_DOCKERFILE_PATH=packages/server/Dockerfile`.
   - **Add a volume** mounted at `/workspace`.
   - **Settings → Networking → Generate Domain.** This is the URL reviewers will open.
   - **Settings → Deploy → Healthcheck path** `/__tapthat/healthz`, **timeout** `900`.
4. **Add these variables** to the service. Generate the two secrets with
   `openssl rand -base64 32`, or use any long random strings.
   ```ini
   NODE_ENV=development
   TAPTHAT_ENABLE=1
   TAPTHAT_TOKEN=<a long random secret — reviewers will paste this>
   TAPTHAT_ENCRYPTION_KEY=<another long random secret>
   TAPTHAT_REPO_URL=https://github.com/<you>/<your-app>.git
   TAPTHAT_GIT_TOKEN=<the GitHub token from step 2>
   TAPTHAT_BRANCH=dev
   TAPTHAT_PROXY=1
   TAPTHAT_START_DEV_SERVER=1
   TAPTHAT_INSTALL_COMMAND=npm ci
   TAPTHAT_DEV_COMMAND=npm run dev
   TAPTHAT_DEV_SERVER=http://localhost:3000
   TAPTHAT_ALLOWED_ORIGINS=https://${{RAILWAY_PUBLIC_DOMAIN}}
   ```
   - `TAPTHAT_DEV_SERVER`: use the port your dev server listens on (Next.js 3000, Vite
     5173).
   - Add any variables your app itself needs, such as API URLs.
   - Optional: `ANTHROPIC_API_KEY=sk-ant-…` for one shared Claude key.
5. **Deploy.** The first start takes a few minutes while it clones and installs.
6. Your **Sidecar URL** is `https://<your-generated-domain>/__tapthat` (note the
   `/__tapthat` at the end). Your **Token** is `TAPTHAT_TOKEN`.

The sidecar never pushes to GitHub unless you set `TAPTHAT_GIT_PUSH=1`. If you enable it,
make sure this service doesn't redeploy on pushes to `dev`, or every change will restart
it mid-review.

Full details, including a ready-made service for projects defined in code:
[docs/setup.md](docs/setup.md#path-3--railway-and-other-single-container-hosts).

### Check the service side

Open the Sidecar URL with `/healthz` on the end in your browser:

- A: `http://localhost:7420/healthz`
- C: `https://<your-domain>/__tapthat/healthz`

You should see `"status":"ok"`, and `"reachable":true` under `devServer`. If `agent` →
`cliVersion` is `null`, the Claude Code CLI is missing (step A1).

**Send each reviewer three things:** the dev site's address, the Sidecar URL, and the
Token. Treat the token like a password.

---

## Part 2 — The client side (each reviewer's browser)

Works in Chrome, Arc, Edge, Brave and other Chromium browsers.

> **For reviewers:** once the extension is installed, the **?** button in the TapThat panel
> opens a plain-language guide inside the extension. It covers what you need from your
> developer, how to get a Claude key, and what each status means. You can send people
> there instead of here.

1. **Download and unzip the extension.** Get `tapthat.zip` from the
   [latest release](https://github.com/ljellevo/tapthat/releases/latest) and unzip it. You
   get a folder called `tapthat`.
   <details><summary>Latest release has no "Apply to dev"? Build it yourself.</summary>

   ```bash
   git clone https://github.com/ljellevo/tapthat.git && cd tapthat
   npm ci && npm run package
   ```
   Then unzip `packages/client/tapthat.zip`.
   </details>
2. **Load it into the browser:**
   1. Open `chrome://extensions` (in Arc: `arc://extensions`).
   2. Turn on **Developer mode** (top right).
   3. Click **Load unpacked** and choose the `tapthat` folder.
   4. Optional: pin TapThat to the toolbar.

   This is all you need for **TapThat Light**: open any page, press **Alt+Shift+C**,
   click an element, write a comment, and press **Export** to copy everything for a
   coding agent. To have changes applied for you, continue.
3. **Connect to the sidecar.** Right-click the TapThat icon → **Options**. On the
   extensions page it's under *Details → Extension options*. Fill in:
   - **Sidecar URL**: from your developer, e.g. `https://dev.example.com/__tapthat`
   - **Access token**: from your developer
   - **Sites that get Apply to dev**: leave empty. It fills itself in from the sidecar.

   Click **Save & test**. You should see a ✓ with the branch name and the dev server
   status.
4. **Add your Claude credential** (skip this if your developer set up a shared key). In
   the same options page, paste your API key (`sk-ant-…`) under **Claude credential** and
   click **Save credential**. It goes to the sidecar, is stored there encrypted, and is
   never kept in your browser. You only ever see the last four characters. (Skip this too
   and TapThat will ask the first time you press Apply.)
5. **Try it.**
   1. Open the dev site. A round TapThat button appears in the corner.
   2. Click it (or press **Alt+Shift+C**), click something on the page, and write a
      comment, e.g. *"make this heading say Hello"*. Press **⌘↵** / **Ctrl+↵**.
   3. The panel's bottom line shows which branch you'll change, e.g. `dev @ a1b2c3d`.
   4. Press **Apply to dev**. The comment moves through **queued → editing → live →
      committed**, and the page updates by itself, usually within a minute.
   5. Happy with it? Press **Resolve** to clear the comments. Not happy? **Undo** reverts
      the change.

   **On a playground**, the panel first shows **Start session**. It copies the latest
   from the test site and takes a few minutes. Changes then collect in the session until
   someone presses **Commit to dev**. The **?** guide explains it under "Playground
   sessions".

If something goes wrong, the panel shows the reason in plain text, with a **Copy**
button to send to your developer. **Export** always keeps working as a fallback.

To turn Apply off again, click **Back to Light** in the options page.

---

**More:** [setup reference](docs/setup.md) · [troubleshooting](docs/troubleshooting.md) ·
[security](docs/security.md) · [HTTP API](docs/api.md)
