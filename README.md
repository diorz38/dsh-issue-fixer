# dsh-issue-fixer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that watches the
open issues of **one** GitHub repository and lets a DSH agent work on them — but only for repositories
the machine's logged-in GitHub account can actually write to.

The plugin never touches GitHub for you beyond reading issues: it asks a DSH agent
to fix, test and **commit locally**. By default it does not push and does not open
pull requests — you review and push. If you enable **auto pull requests**, it pushes
each fix branch and opens the PR for you. It never comments on issues.

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
4. **Baseline issue number** — only issues numbered above it are picked. `0` reopens every open issue.
   The form shows the current baseline; **Apply** saves a new one and polls immediately, so lowering it
   is how you get the plugin to revisit older issues.
5. Choose **Use the GitHub CLI login on this machine** or paste a **token**.
6. Optionally tick **After each fix: push the branch and open a pull request automatically**.
7. **Fork sync (optional)** — for repos you fork: enable it, set the upstream repository (or let it auto-detect an `upstream` remote), your **main** branch, and your **modification branch** (the branch that keeps your own changes). Choose **Manual** (default, use **Sync now**) or **Auto** (after polls when idle, 10-minute cooldown). Optionally set **Minimum commits behind upstream** (`0` = sync whenever upstream has new commits; higher values skip upstream sync until your main branch is behind by at least that many commits, reducing frequent operations). For **merge conflicts in the modification branch**, choose **Manual** (default: abort the merge, restore the checkout, and report conflicted files) or **Agent resolves conflicts** (opt-in: keep the merge in progress, run an agent session in the same checkout to resolve conflicts and complete the merge while preserving upstream fixes and your local modifications, verify no unmerged paths remain, then push the modification branch if push is enabled; on failure it aborts/restores and does not push). Sync uses **merge** only (no rebase, no force-push): it fetches upstream, fast-forwards your main from upstream, merges main into your modification branch, and can push to origin if enabled. It refuses on a dirty working tree or if main has diverged from upstream (no force).

Press **Check access** to see the full report without saving, then **Save and start watching**. Saving is
only accepted when every blocking gate passes.

Once saved, the plugin polls `state=open`, newest first, every `intervalMs` (default 5 min). The first poll
only records a baseline (the newest issue number) and processes nothing; later polls pick up issues newer
than the baseline, plus issues that were edited into the label set. A failed fix is retried on later polls
until it has three attempts; a successful one is never repeated.

## What the agent is asked to do

For each issue the plugin creates a session (`session-issuefix-<owner>_<name>-<number>`) with the profile's
default model and default agent preset — the preset is what supplies the agent's tools — working in the
configured checkout, and asks the agent to:

1. read the issue and reproduce the problem,
2. fix it,
3. run the relevant tests,
4. **commit locally** and report what changed.

Before each session the plugin switches the checkout onto a fresh local branch `issuefix/<number>` cut
from the *base branch* — the branch that was checked out when watching started. Sequential fixes therefore
never stack on each other; a name collision (re-run of the same issue) gets a short random suffix. The
checkout is left on the fix branch for you to review and merge or delete. The plugin never switches back
on its own, never merges, never deletes branches. The task prompt also forbids the agent from
committing to the main/master/default branch or switching branches — every commit must land on the
fix branch.

The agent itself never pushes and never comments on the issue. A session that leaves no commit on the
fix branch counts as a failed attempt — the plugin does not push it and does not report it as done.
Every poll also repairs earlier runs: a fix branch pushed without a PR gets its PR created, and an empty
pushed branch is deleted remotely and its issue made retryable again.
With auto pull requests **off**
(default) you review the fix branch and push it yourself. With auto pull requests **on**, after
each finished session the plugin pushes the fix branch to the remote that points at the watched
repository and opens a pull request titled `Fix #<number>: <title>` with a `Fixes #<number>`
body, so merging closes the issue. A push or PR failure is reported in the activity feed and the
warning log — the local fix commits are never lost.

The settings page also shows an **Issues** card: the issue being fixed right now (`fixing…`),
queued issues, and every processed issue (newest first, up to 50 rows) with its title, status,
fix branch and links to the GitHub issue and the opened pull request. It also shows **Fork sync**
status (last run, result, and per-step log) when configured.

## State and files

- `<DSH_HOME>\issue-fixer-state.json` — settings, verified identity, per-repository baseline, processed
  map, last poll time/error, and fork-sync status. Written atomically with mode `0o600`. A GitHub token pasted in the UI is the
  only credential that can end up in this file; a token from `gh auth token` never is.
- The setup API lives on `/api/issue-fixer.{status,check,save,baseline,sync,reset}` and rides the harness'
  authenticated `connection` Fetch registry: non-owner peers get `403`, unauthenticated browser requests
  get `401`.
- The browser half is a plain classic-script bundle (`client.js`) registered as a `settings.section`; no
  build step, no bundler, no dependencies.

## Self-update

The plugin checks the [`diorz38/dsh-issue-fixer`](https://github.com/diorz38/dsh-issue-fixer) GitHub
releases at startup and once a day, and updates itself when a newer release exists:

- a `file:///` checkout (Option 2 install) updates with `git pull --ff-only`, so the tree stays clean;
- a pnpm install downloads the release tarball and copies the published files over the package
  (the lockfile keeps the old commit hash — cosmetic only; `pnpm add` re-syncs it).

Applied files take effect at the next DSH Desktop restart — the running code is never swapped
mid-flight, and the state file lives outside the plugin directory, so an interrupted update cannot
lose settings. The outcome is shown under **Activity → Self-update**. Untick
**Keep the plugin itself up to date** in the setup form to disable the checks entirely.

## Removing it

Delete the insert (Option 2) or remove the bundle entry and run `pnpm remove dsh-issue-fixer` (Option 1),
then restart DSH Desktop. Deleting `<DSH_HOME>\issue-fixer-state.json` clears all remembered settings.

## License

MIT
