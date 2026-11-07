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

async function git(cwd, args, timeout = 15000) {
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
