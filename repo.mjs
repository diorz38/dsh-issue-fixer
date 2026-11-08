// Working-directory checks for dsh-issue-fixer.
//
// The plugin can only fix issues if `cwd` is a git checkout of the same
// repository it watches. A mismatch silently commits fixes to an unrelated
// tree, so mismatch is a hard error rather than a warning.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

// Callback form on purpose: `util.promisify(execFile)` loses the stdout/stderr
// contract when the host patches `child_process.execFile`.
function execFileText(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdoutText = String(stdout ?? '');
        error.stderrText = String(stderr ?? '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export async function git(cwd, args, timeout = 15000) {
  try {
    const { stdout, stderr } = await execFileText('git', ['-C', cwd, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const detail = String(error?.stderrText ?? '').trim();
    return { ok: false, error: detail || String(error?.shortMessage ?? error?.message ?? error), stdout: '' };
  }
}

/** Parse `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://…` into `owner/name`. */
export function parseRepoRef(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\.git$/, '');
  const https = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/** Remote list as [{ name, url, repo }]. */
export async function listRemotes(cwd) {
  const result = await git(cwd, ['remote', '-v']);
  if (!result.ok) return [];
  const seen = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match;
    if (seen.has(name)) continue;
    seen.set(name, { name, url, repo: parseRepoRef(url) });
  }
  return [...seen.values()];
}

/**
 * Validate the working directory against the repository being watched.
 * Returns { ok, checks: [{id, ok, label, detail}], branch, dirty, … }.
 */
export async function checkCheckout({ cwd, repo }) {
  const checks = [];
  const add = (id, ok, label, detail) => checks.push({ id, ok, label, detail });

  if (!cwd) {
    add('cwd', false, 'Working directory', 'No working directory was provided.');
    return { ok: false, checks };
  }

  let isDirectory = false;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    add('cwd', false, 'Working directory', `"${cwd}" does not exist or is not a folder.`);
    return { ok: false, checks };
  }

  const topLevel = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok) {
    add('cwd', false, 'Working directory', `"${cwd}" is not inside a git repository (git said: ${topLevel.error}).`);
    return { ok: false, checks };
  }
  add('cwd', true, 'Working directory', topLevel.stdout);

  const remotes = await listRemotes(cwd);
  const wanted = String(repo ?? '').toLowerCase();
  const match = remotes.find((remote) => remote.repo?.toLowerCase() === wanted);
  if (!match) {
    const known = remotes.filter((r) => r.repo).map((r) => `${r.name} → ${r.repo}`);
    add(
      'remote',
      false,
      'Repository remote',
      known.length
        ? `This checkout points at ${known.join(', ')}, but the plugin watches ${repo}.`
        : 'This checkout has no GitHub remote. Add it with `git remote add origin https://github.com/<owner>/<name>.git`.',
    );
    return { ok: false, checks, topLevel: topLevel.stdout, remotes };
  }
  add('remote', true, 'Repository remote', `${match.name} → ${match.repo}`);

  const branchResult = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const branch = branchResult.ok ? branchResult.stdout : '(detached HEAD)';
  if (!branchResult.ok) {
    add('branch', false, 'Branch', 'The checkout is on a detached HEAD; the plugin needs a branch to commit to.');
  } else {
    add('branch', true, 'Branch', branch);
  }

  const statusResult = await git(cwd, ['status', '--porcelain']);
  const dirtyLines = statusResult.ok && statusResult.stdout ? statusResult.stdout.split('\n').filter(Boolean) : [];
  add(
    'clean',
    dirtyLines.length === 0,
    'Working tree',
    dirtyLines.length === 0
      ? 'clean'
      : `${dirtyLines.length} uncommitted change(s) already present — fixes will be mixed into that work.`,
  );

  const emailResult = await git(cwd, ['config', 'user.email']);
  add(
    'identity',
    emailResult.ok && emailResult.stdout.length > 0,
    'Commit identity',
    emailResult.ok && emailResult.stdout
      ? emailResult.stdout
      : 'git user.email is not set; commits will fail until it is configured.',
  );

  // `clean` and `identity` are advisory: the directory is usable, but we report
  // them so the setup screen can show the concrete risk before the user saves.
  const blocking = checks.filter((check) => check.id !== 'clean' && check.id !== 'identity' && !check.ok);
  return {
    ok: blocking.length === 0,
    checks,
    topLevel: topLevel.stdout,
    branch,
    dirty: dirtyLines.length,
    remotes,
  };
}

/**
 * Switch the checkout onto a fresh fix branch cut from `base` (current HEAD
 * when base is unknown). Returning to `base` first keeps sequential fixes from
 * stacking on each other. An existing branch name gets a short random suffix
 * so a re-run never mixes histories. Never merges, deletes, or pushes.
 */
export async function prepareFixBranch({ cwd, base, name }) {
  if (base && base !== '(detached HEAD)') {
    const back = await git(cwd, ['switch', base]);
    if (!back.ok) return { ok: false, error: `cannot switch to base branch "${base}": ${back.error}` };
  }
  let lastError = '';
  let branch = name;
  // ponytail: unique-suffix retry; upgrade path is a per-issue `git worktree`
  // pool once parallel sessions are needed.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const created = await git(cwd, ['switch', '-c', branch]);
    if (created.ok) return { ok: true, branch };
    lastError = created.error;
    branch = `${name}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return { ok: false, error: `cannot create fix branch "${name}": ${lastError}` };
}

function step(steps, ok, label, detail) {
  steps.push({ ok, label, detail: detail ?? '' });
}

async function currentBranch(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  return r.ok ? r.stdout : null;
}

async function isDirty(cwd) {
  const r = await git(cwd, ['status', '--porcelain']);
  if (!r.ok) return { dirty: true, error: r.error, count: 0 };
  const lines = r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
  return { dirty: lines.length > 0, count: lines.length };
}

async function branchExists(cwd, name) {
  const r = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  return r.ok;
}

async function remoteBranchExists(cwd, remote, name) {
  const r = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${name}`]);
  return r.ok;
}

async function ensureLocalBranch(cwd, name, remote) {
  if (await branchExists(cwd, name)) return { ok: true };
  if (remote && await remoteBranchExists(cwd, remote, name)) {
    const created = await git(cwd, ['branch', '--track', name, `${remote}/${name}`]);
    if (created.ok) return { ok: true, created: true };
    return { ok: false, error: created.error };
  }
  return { ok: false, error: `branch "${name}" does not exist locally or on ${remote || 'any remote'}` };
}

function pickUpstreamRemote(remotes, watchedRepo, preferredName, upstreamRepo) {
  const wantedUpstream = String(upstreamRepo ?? '').toLowerCase();
  const watched = String(watchedRepo ?? '').toLowerCase();
  if (preferredName) {
    const byName = remotes.find((r) => r.name === preferredName);
    if (byName) return byName;
  }
  if (wantedUpstream) {
    const byRepo = remotes.find((r) => r.repo?.toLowerCase() === wantedUpstream);
    if (byRepo) return byRepo;
  }
  // Heuristic: a remote named 'upstream' not pointing at the watched fork.
  const named = remotes.find((r) => r.name === 'upstream' && r.repo?.toLowerCase() !== watched);
  if (named) return named;
  // Fallback: any remote that is not the watched fork and looks different.
  const other = remotes.find((r) => r.repo && r.repo.toLowerCase() !== watched);
  return other ?? null;
}

function pickOriginRemote(remotes, watchedRepo) {
  const watched = String(watchedRepo ?? '').toLowerCase();
  return remotes.find((r) => r.repo?.toLowerCase() === watched)
    ?? remotes.find((r) => r.name === 'origin')
    ?? remotes[0]
    ?? null;
}

/**
 * Sync a fork: upstream -> main, then main -> modification branch (merge).
 * Safe by default: refuses on dirty tree, refuses if main diverged (no ff-only),
 * aborts and restores on merge conflicts, never force-pushes.
 */
export async function syncFork({ cwd, watchedRepo, sync, defaultBranch }) {
  const steps = [];
  const config = sync && typeof sync === 'object' ? sync : {};
  if (config.enabled !== true) {
    return { ok: false, result: 'skipped', message: 'Fork sync is not enabled.', steps };
  }
  const modBranch = String(config.modBranch ?? '').trim();
  if (!modBranch) {
    return { ok: false, result: 'skipped', message: 'Set a modification branch before syncing.', steps };
  }
  const mode = config.mode === 'merge' ? 'merge' : 'merge';
  const push = config.push !== false;

  const dirtyState = await isDirty(cwd);
  if (dirtyState.dirty) {
    const msg = dirtyState.error
      ? `Cannot check working tree: ${dirtyState.error}`
      : `Working tree has ${dirtyState.count} uncommitted change(s). Commit, stash, or discard them before syncing.`;
    step(steps, false, 'Preflight: clean working tree', msg);
    return { ok: false, result: 'skipped', message: msg, steps };
  }
  step(steps, true, 'Preflight: clean working tree', 'clean');

  const remotes = await listRemotes(cwd);
  const origin = pickOriginRemote(remotes, watchedRepo);
  if (!origin) {
    step(steps, false, 'Preflight: origin remote', 'No remote found for the watched repository.');
    return { ok: false, result: 'error', message: 'No remote found for the watched repository.', steps };
  }
  step(steps, true, 'Preflight: origin remote', `${origin.name} → ${origin.repo ?? origin.url}`);

  let upstream = pickUpstreamRemote(remotes, watchedRepo, config.upstreamRemote, config.upstreamRepo);
  if (!upstream && config.upstreamRepo) {
    const name = config.upstreamRemote || 'upstream';
    const url = `https://github.com/${config.upstreamRepo}.git`;
    const added = await git(cwd, ['remote', 'add', name, url]);
    if (added.ok) {
      upstream = { name, url, repo: config.upstreamRepo };
      step(steps, true, 'Add upstream remote', `${name} → ${config.upstreamRepo}`);
    } else if (/already exists/i.test(added.error || '')) {
      upstream = remotes.find((r) => r.name === name) ?? { name, url, repo: config.upstreamRepo };
      step(steps, true, 'Upstream remote', `${name} (already exists)`);
    } else {
      step(steps, false, 'Add upstream remote', added.error);
      return { ok: false, result: 'error', message: `Cannot add upstream remote: ${added.error}`, steps };
    }
  }
  if (!upstream) {
    const msg = 'No upstream remote found. Set the upstream repository (owner/name) or add an "upstream" remote pointing to the original repo.';
    step(steps, false, 'Preflight: upstream remote', msg);
    return { ok: false, result: 'error', message: msg, steps };
  }
  step(steps, true, 'Preflight: upstream remote', `${upstream.name} → ${upstream.repo ?? upstream.url}`);

  const mainBranch = String(config.mainBranch ?? '').trim() || defaultBranch || 'main';
  if (mainBranch === modBranch) {
    const msg = 'The modification branch must be different from the main branch.';
    step(steps, false, 'Preflight: branches', msg);
    return { ok: false, result: 'error', message: msg, steps };
  }
  step(steps, true, 'Preflight: branches', `upstream/${mainBranch} → ${mainBranch} → ${modBranch} (${mode})`);

  const previousBranch = await currentBranch(cwd);
  const restoreBranch = previousBranch && !previousBranch.startsWith('issuefix/') ? previousBranch : null;

  const restore = async () => {
    if (restoreBranch) {
      await git(cwd, ['switch', restoreBranch]);
    }
  };

  try {
    const fetchUpstream = await git(cwd, ['fetch', upstream.name, '--prune'], 60000);
    if (!fetchUpstream.ok) {
      step(steps, false, `Fetch ${upstream.name}`, fetchUpstream.error);
      return { ok: false, result: 'error', message: `Failed to fetch ${upstream.name}: ${fetchUpstream.error}`, steps };
    }
    step(steps, true, `Fetch ${upstream.name}`, 'ok');
    const fetchOrigin = await git(cwd, ['fetch', origin.name, '--prune'], 60000);
    if (!fetchOrigin.ok) {
      step(steps, false, `Fetch ${origin.name}`, fetchOrigin.error);
      return { ok: false, result: 'error', message: `Failed to fetch ${origin.name}: ${fetchOrigin.error}`, steps };
    }
    step(steps, true, `Fetch ${origin.name}`, 'ok');

    // Resolve the upstream ref (some repos use master/main differently).
    let upstreamRef = `${upstream.name}/${mainBranch}`;
    if (!(await remoteBranchExists(cwd, upstream.name, mainBranch))) {
      const alt = mainBranch === 'main' ? 'master' : mainBranch === 'master' ? 'main' : null;
      if (alt && await remoteBranchExists(cwd, upstream.name, alt)) {
        upstreamRef = `${upstream.name}/${alt}`;
        step(steps, true, 'Resolve upstream branch', `using ${upstreamRef} (configured ${mainBranch} not found)`);
      } else {
        step(steps, false, 'Resolve upstream branch', `${upstreamRef} not found on ${upstream.name}.`);
        return { ok: false, result: 'error', message: `Upstream branch ${upstreamRef} not found. Check the main branch name.`, steps };
      }
    }

    // Step A: upstream -> main (ff-only, never force-reset).
    const ensuredMain = await ensureLocalBranch(cwd, mainBranch, origin.name);
    if (!ensuredMain.ok) {
      // Try creating from upstream if origin doesn't have it.
      const fromUp = await git(cwd, ['branch', mainBranch, upstreamRef]);
      if (!fromUp.ok) {
        step(steps, false, `Prepare ${mainBranch}`, ensuredMain.error);
        return { ok: false, result: 'error', message: `Cannot prepare ${mainBranch}: ${ensuredMain.error}`, steps };
      }
      step(steps, true, `Prepare ${mainBranch}`, `created from ${upstreamRef}`);
    }
    const swMain = await git(cwd, ['switch', mainBranch]);
    if (!swMain.ok) {
      step(steps, false, `Switch to ${mainBranch}`, swMain.error);
      return { ok: false, result: 'error', message: `Cannot switch to ${mainBranch}: ${swMain.error}`, steps };
    }

    const minCommitsBehindRaw = Number(config.minCommitsBehind);
    const minCommitsBehind = Number.isFinite(minCommitsBehindRaw) && minCommitsBehindRaw > 0
      ? Math.floor(minCommitsBehindRaw)
      : 0;
    if (minCommitsBehind > 0) {
      const behind = await git(cwd, ['rev-list', '--count', `${mainBranch}..${upstreamRef}`]);
      if (!behind.ok) {
        step(steps, false, `Check commits behind ${upstreamRef}`, behind.error);
        await restore();
        return { ok: false, result: 'error', message: `Cannot check how far ${mainBranch} is behind ${upstreamRef}: ${behind.error}`, steps };
      }
      const behindCount = Number(behind.stdout);
      if (!Number.isFinite(behindCount) || behindCount < 0) {
        step(steps, false, `Check commits behind ${upstreamRef}`, `Unexpected count: ${behind.stdout || '(empty)'}`);
        await restore();
        return { ok: false, result: 'error', message: `Cannot determine how far ${mainBranch} is behind ${upstreamRef}.`, steps };
      }
      if (behindCount < minCommitsBehind) {
        const msg = behindCount === 0
          ? `${mainBranch} is up to date with ${upstreamRef}.`
          : `${mainBranch} is ${behindCount} commit(s) behind ${upstreamRef}; minimum is ${minCommitsBehind}, so upstream sync was skipped to avoid frequent operations.`;
        step(steps, true, `Check commits behind ${upstreamRef}`, `${behindCount} (minimum ${minCommitsBehind})`);
        step(steps, true, 'Skip upstream sync', msg);
        await restore();
        return {
          ok: true,
          result: 'skipped',
          message: msg,
          steps,
          plan: { upstreamRemote: upstream.name, upstreamRef, originRemote: origin.name, mainBranch, modBranch, push, minCommitsBehind, behindCount, restored: restoreBranch },
        };
      }
      step(steps, true, `Check commits behind ${upstreamRef}`, `${behindCount} (minimum ${minCommitsBehind})`);
    }

    const ff = await git(cwd, ['merge', '--ff-only', upstreamRef]);
    if (!ff.ok) {
      step(steps, false, `Sync ${mainBranch} with ${upstreamRef}`, `${ff.error} Local ${mainBranch} has diverged from upstream; refusing to reset or force. Resolve manually (keep your local commits or reset intentionally), then retry.`);
      await restore();
      return { ok: false, result: 'error', message: `Cannot fast-forward ${mainBranch} to ${upstreamRef} (diverged). No changes forced.`, steps };
    }
    step(steps, true, `Sync ${mainBranch} with ${upstreamRef}`, ff.stdout || 'up to date');
    if (push) {
      const pushedMain = await git(cwd, ['push', origin.name, mainBranch], 60000);
      if (!pushedMain.ok) {
        step(steps, false, `Push ${mainBranch} to ${origin.name}`, pushedMain.error);
        await restore();
        return { ok: false, result: 'error', message: `Synced ${mainBranch} locally but failed to push to ${origin.name}: ${pushedMain.error}`, steps };
      }
      step(steps, true, `Push ${mainBranch} to ${origin.name}`, pushedMain.stdout || 'ok');
    } else {
      step(steps, true, `Push ${mainBranch}`, 'skipped (push disabled)');
    }

    // Step B: main -> modBranch (merge).
    const ensuredMod = await ensureLocalBranch(cwd, modBranch, origin.name);
    if (!ensuredMod.ok) {
      step(steps, false, `Prepare ${modBranch}`, ensuredMod.error);
      await restore();
      return { ok: false, result: 'error', message: `Cannot prepare ${modBranch}: ${ensuredMod.error}`, steps };
    }
    const swMod = await git(cwd, ['switch', modBranch]);
    if (!swMod.ok) {
      step(steps, false, `Switch to ${modBranch}`, swMod.error);
      await restore();
      return { ok: false, result: 'error', message: `Cannot switch to ${modBranch}: ${swMod.error}`, steps };
    }
    const merged = await git(cwd, ['merge', '--no-edit', mainBranch]);
    if (!merged.ok) {
      const conflicts = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
      const conflictedFiles = conflicts.ok && conflicts.stdout ? conflicts.stdout.split('\n').filter(Boolean) : [];
      const files = conflictedFiles.join(', ');
      if (config.conflictResolution === 'agent') {
        // Opt-in: leave the merge in progress on modBranch and hand off to an agent session.
        // Do NOT abort or restore here — the agent must resolve conflicts in place, then the
        // caller verifies and completes (push/restore) or aborts+restores on failure.
        const detail = files ? `Conflicts in: ${files}. Merge left in progress for agent resolution.` : `Merge conflict; left in progress for agent resolution. ${merged.error}`;
        step(steps, false, `Merge ${mainBranch} into ${modBranch}`, detail);
        return {
          ok: false,
          result: 'conflict_needs_agent',
          message: `Merge conflict while updating ${modBranch}.${files ? ` Conflicted files: ${files}.` : ''} Agent resolution requested.`,
          steps,
          handoff: {
            cwd,
            modBranch,
            mainBranch,
            upstreamRef,
            originRemote: origin.name,
            conflictedFiles,
            push,
            restoreBranch,
            previousBranch,
          },
        };
      }
      await git(cwd, ['merge', '--abort']);
      await restore();
      const detail = files ? `Conflicts in: ${files}. Merge aborted and checkout restored.` : `Merge aborted and checkout restored. ${merged.error}`;
      step(steps, false, `Merge ${mainBranch} into ${modBranch}`, detail);
      return { ok: false, result: 'conflict', message: `Merge conflict while updating ${modBranch}. ${files ? `Conflicted files: ${files}.` : ''} Resolve conflicts manually on ${modBranch} (merge ${mainBranch}) and push when ready.`, steps };
    }
    step(steps, true, `Merge ${mainBranch} into ${modBranch}`, merged.stdout || 'up to date');
    if (push) {
      const pushedMod = await git(cwd, ['push', origin.name, modBranch], 60000);
      if (!pushedMod.ok) {
        step(steps, false, `Push ${modBranch} to ${origin.name}`, pushedMod.error);
        await restore();
        return { ok: false, result: 'error', message: `Merged ${modBranch} locally but failed to push to ${origin.name}: ${pushedMod.error}`, steps };
      }
      step(steps, true, `Push ${modBranch} to ${origin.name}`, pushedMod.stdout || 'ok');
    } else {
      step(steps, true, `Push ${modBranch}`, 'skipped (push disabled)');
    }

    await restore();
    step(steps, true, 'Restore branch', restoreBranch ?? previousBranch ?? 'ok');
    return {
      ok: true,
      result: 'ok',
      message: `Synced ${upstreamRef} → ${mainBranch} → ${modBranch}${push ? ` and pushed to ${origin.name}` : ' (local only)'}.`,
      steps,
      plan: { upstreamRemote: upstream.name, upstreamRef, originRemote: origin.name, mainBranch, modBranch, push, minCommitsBehind, restored: restoreBranch },
    };
  } catch (error) {
    await restore();
    step(steps, false, 'Sync', String(error));
    return { ok: false, result: 'error', message: String(error), steps };
  }
}
