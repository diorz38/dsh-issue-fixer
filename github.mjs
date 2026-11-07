// GitHub identity + repository-permission checks for dsh-issue-fixer.
//
// The plugin must never start fixing issues for a repository the machine's
// logged-in GitHub account cannot write to. Every check here is read-only
// against the GitHub API, and the token is never logged or written to disk.
import { execFile } from 'node:child_process';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20000;

function apiHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-issue-fixer',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** GitHub API GET returning { ok, status, body }. Never throws on HTTP status. */
export async function ghGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/** GitHub API POST returning { ok, status, body }. Never throws on HTTP status. */
export async function ghPost(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// `util.promisify(execFile)` silently loses its multi-value contract when the
// host patches `child_process.execFile` (Windows desktop builds do, to hide
// console windows), so wrap the callback form explicitly instead.
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

async function runGh(args, timeout = 15000) {
  // On Windows the CLI is `gh.exe`; CREATE_PROCESS search handles the bare name,
  // but spawning the explicit name is what actually resolves on every shell.
  const candidates = process.platform === 'win32' ? ['gh.exe', 'gh'] : ['gh'];
  let lastError;
  for (const command of candidates) {
    try {
      const { stdout } = await execFileText(command, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, stdout: stdout.trim(), stderr: '' };
    } catch (error) {
      lastError = error;
      if (error?.code === 'ENOENT') continue; // try the next candidate
      return {
        ok: false,
        error: String(error?.shortMessage ?? error?.message ?? error),
        stdout: error?.stdoutText ?? '',
        stderr: error?.stderrText ?? '',
      };
    }
  }
  return { ok: false, error: `GitHub CLI not found (${String(lastError?.message ?? lastError)})`, stdout: '', stderr: '' };
}

/**
 * Resolve the GitHub account this machine is logged in as.
 *
 * Priority: explicit config token, then the `gh` CLI session (keyring). The
 * machine owner's identity is what decides repository permission, so a config
 * token is only an override for machines without `gh`.
 */
export async function resolveIdentity(config = {}) {
  if (config.githubToken) {
    const { ok, status, body } = await ghGet('/user', config.githubToken);
    if (!ok || !body?.login) {
      return {
        ok: false,
        source: 'config-token',
        error: status === 401
          ? 'The configured githubToken is invalid or expired.'
          : `The configured githubToken could not read the GitHub user (HTTP ${status}).`,
      };
    }
    return { ok: true, source: 'config-token', token: config.githubToken, login: body.login, name: body.name ?? null };
  }

  const auth = await runGh(['auth', 'status', '--hostname', 'github.com']);
  if (!auth.ok) {
    const detail = auth.stdout || auth.error || '';
    const loggedOut = /not logged in|no oauth token|not logged into any/i.test(detail);
    return {
      ok: false,
      source: 'gh-cli',
      error: loggedOut
        ? 'GitHub CLI is installed but not logged in. Run `gh auth login`, or set githubToken in the setup form.'
        : `GitHub CLI session could not be read: ${detail.split('\n')[0] || 'unknown error'}`,
    };
  }

  const tokenResult = await runGh(['auth', 'token']);
  if (!tokenResult.ok || !tokenResult.stdout) {
    return {
      ok: false,
      source: 'gh-cli',
      error: 'GitHub CLI is logged in but did not return a token (`gh auth token` failed). Re-run `gh auth login`.',
    };
  }

  const me = await ghGet('/user', tokenResult.stdout);
  if (!me.ok || !me.body?.login) {
    return {
      ok: false,
      source: 'gh-cli',
      error: me.status === 401
        ? 'The GitHub CLI token is rejected by the API (401). Run `gh auth login` again.'
        : `Could not read the GitHub user for the CLI token (HTTP ${me.status}).`,
    };
  }

  return { ok: true, source: 'gh-cli', token: tokenResult.stdout, login: me.body.login, name: me.body.name ?? null };
}

/**
 * Verify the account can actually update the repository (owner, admin, maintain,
 * or push). Read-only access is explicitly not enough: the plugin commits fixes.
 */
export async function checkRepoAccess(token, repo) {
  const { ok, status, body } = await ghGet(`/repos/${repo}`, token);
  if (status === 404) {
    return {
      ok: false,
      repo,
      error: `Repository "${repo}" was not found, or this GitHub account cannot see it. Check the owner/name spelling and the account's access.`,
    };
  }
  if (status === 403) {
    return { ok: false, repo, error: 'GitHub API refused the permission check (403). Rate limit or organization SSO may be blocking the CLI session.' };
  }
  if (!ok || !body) {
    return { ok: false, repo, error: `GitHub API could not read "${repo}" (HTTP ${status}).` };
  }
  const permissions = body.permissions ?? {};
  const canWrite = permissions.admin === true || permissions.maintain === true || permissions.push === true;
  if (!canWrite) {
    return {
      ok: false,
      repo: body.full_name ?? repo,
      permissions,
      error: `This account has read-only access to ${body.full_name ?? repo} (no push/admin/maintain). The plugin only runs on repositories the logged-in account can update.`,
    };
  }
  return {
    ok: true,
    repo: body.full_name ?? repo,
    private: body.private === true,
    defaultBranch: body.default_branch ?? null,
    permissions,
    owner: body.owner?.login ?? null,
  };
}

/**
 * Open a pull request from a pushed fix branch. Write access was already
 * verified by checkRepoAccess, so a failure here is reported, not thrown.
 */
export async function createPullRequest(token, { repo, title, body, head, base }) {
  const { ok, status, body: created } = await ghPost(`/repos/${repo}/pulls`, token, { title, body, head, base });
  if (!ok) {
    const first = Array.isArray(created?.errors) && created.errors[0]?.message ? ` (${created.errors[0].message})` : '';
    return { ok: false, error: `PR create failed: ${created?.message ?? `HTTP ${status}`}${first}` };
  }
  return { ok: true, url: created.html_url ?? null, number: created.number ?? null };
}
