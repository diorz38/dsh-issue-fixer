# dsh-issue-fixer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that watches the
open issues of **one** GitHub repository and lets a DSH agent work on them — but only for repositories
the machine's logged-in GitHub account can actually write to.

The plugin never touches GitHub for you: it reads issues through the GitHub API, then asks a DSH agent
to fix, test and **commit locally**. It does not push, open pull requests, or comment on issues.

## What it guarantees before it starts

Nothing runs until *all* of the following hold, and the setup screen shows every check:

| Gate | Meaning |
| --- | --- |
| Repository | `owner/name`, required |
| Working directory | absolute path of a local git checkout, required |
| GitHub identity | the `gh` CLI session on this machine (or a pasted token) must resolve to a real account |
| Write access | the account must be owner/admin/maintain/push on the repository — read-only access is refused |
| Checkout | the directory must be a git repo whose `origin` matches the watched repository, on a branch |

The write-access gate is the point of the plugin: it is useless (and dangerous) to let an agent "fix"
issues in a repository it cannot push to, so a read-only repository is a hard block with an explicit
message such as *"This account has read-only access to cli/cli (no push/admin/maintain)."*

## Requirements

- DSH Desktop (a `web` profile). Tested with the 2026-11 desktop build.
- `gh` (GitHub CLI) installed and logged in — `gh auth login`. Alternatively paste a personal access
  token into the setup screen (the token needs `repo` scope; it is kept in memory and only stored on
  disk if you explicitly paste it).
- `git` available on `PATH`, and a local clone of the repository you want to watch.

## Install

### Option 1 — install straight from this repository (recommended)

```powershell
cd "$env:APPDATA\dsh-desktop\harness\profiles\web"
pnpm add github:diorz38/dsh-issue-fixer
```

Then add the bundle to the profile manifest `profiles\web\package.json`:

```json
{ "dsh": { "profile": { "bundles": ["…existing…", "dsh-issue-fixer"] } } }
```

Restart DSH Desktop. The plugin inserts itself through its own `cordis.patch.yml`.

Pin a release instead of tracking `main` by appending the tag:

```powershell
pnpm add "github:diorz38/dsh-issue-fixer#v0.3.0"
```

### Option 2 — point the profile at a checkout (no pnpm)

Clone the repository anywhere and add an insert to `profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: issue-fixer
      name: "file:///C:/path/to/dsh-issue-fixer/index.mjs"
      config: {}
```

`name` must be a `file:///` URL with forward slashes. The folder contains a `package.json`, which is what
gives the plugin its browser half, so keep the whole folder together.

## First run

Open **Settings → Issue Fixer** and fill in:

1. **Repository** — `owner/name`.
2. **Working directory** — the local checkout the agent commits in.
3. **Poll interval** (minutes, minimum 1) and optional **labels** (an issue must carry every label to be
   picked up).
4. Choose **Use the GitHub CLI login on this machine** or paste a **token**.

Press **Check access** to see the full report without saving, then **Save and start watching**. Saving is
only accepted when every blocking gate passes.

Once saved, the plugin polls `state=open`, newest first, every `intervalMs` (default 5 min). The first poll
only records a baseline (the newest issue number) and processes nothing; later polls pick up issues newer
than the baseline, plus issues that were edited into the label set.

## What the agent is asked to do

For each issue the plugin creates a session (`session-issuefix-<owner>_<name>-<number>`) with the profile's
default model, working in the configured checkout, and asks the agent to:

1. read the issue and reproduce the problem,
2. fix it,
3. run the relevant tests,
4. **commit locally** and report what changed.

Before each session the plugin switches the checkout onto a fresh local branch `issuefix/<number>` cut
from the *base branch* — the branch that was checked out when watching started. Sequential fixes therefore
never stack on each other; a name collision (re-run of the same issue) gets a short random suffix. The
checkout is left on the fix branch for you to review and merge or delete. The plugin never switches back
on its own, never merges, never deletes branches.

It is explicitly told not to push, not to open pull requests and not to comment on the issue. You review
and push.

## State and files

- `<DSH_HOME>\issue-fixer-state.json` — settings, verified identity, per-repository baseline, processed
  map, last poll time/error. Written atomically with mode `0o600`. A GitHub token pasted in the UI is the
  only credential that can end up in this file; a token from `gh auth token` never is.
- The setup API lives on `/api/issue-fixer.{status,check,save,reset}` and rides the harness'
  authenticated `connection` Fetch registry: non-owner peers get `403`, unauthenticated browser requests
  get `401`.
- The browser half is a plain classic-script bundle (`client.js`) registered as a `settings.section`; no
  build step, no bundler, no dependencies.

## Removing it

Delete the insert (Option 2) or remove the bundle entry and run `pnpm remove dsh-issue-fixer` (Option 1),
then restart DSH Desktop. Deleting `<DSH_HOME>\issue-fixer-state.json` clears all remembered settings.

## License

MIT
