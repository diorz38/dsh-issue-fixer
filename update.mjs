// Self-update for dsh-issue-fixer.
//
// Installed copies (pnpm node_modules or a file:/// checkout) pull newer
// releases of themselves, so nobody has to run `pnpm add` by hand. Applied
// files only take effect after the host restarts; the running module cache is
// never touched, and the state file lives outside the plugin directory, so an
// interrupted update cannot lose settings.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ghGet } from './github.mjs';
import { git } from './repo.mjs';

export const UPDATE_REPO = 'diorz38/dsh-issue-fixer';

function run(command, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error: error ? String(error?.shortMessage ?? error?.message ?? error) : '',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

/** Parse "v1.2.3" / "1.2.3" into [major, minor, patch]; null when unparseable. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Newest published release: { tag, version, tarballUrl } or null. */
export async function fetchLatestRelease(token) {
  const { ok, body } = await ghGet(`/repos/${UPDATE_REPO}/releases/latest`, token ?? null);
  const version = parseVersion(body?.tag_name) ? body.tag_name.replace(/^v/, '') : null;
  if (!ok || !version) return null;
  return { tag: body.tag_name, version, tarballUrl: body.tarball_url };
}

/**
 * Bring the copy at `pluginDir` up to the newest GitHub release.
 * - checkout (`.git` present): `git pull --ff-only`, tree stays clean.
 * - pnpm install: download the release tarball and copy the published files
 *   over the package. The lockfile keeps the old commit hash — cosmetic only;
 *   `pnpm add` re-syncs it.
 */
export async function selfUpdate({ pluginDir, token }) {
  const own = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  const latest = await fetchLatestRelease(token);
  if (!latest || !isNewer(latest.version, own.version)) {
    return { current: own.version, latest: latest?.version ?? null, applied: false };
  }

  if (await stat(join(pluginDir, '.git')).then(() => true).catch(() => false)) {
    const pulled = await git(pluginDir, ['pull', '--ff-only']);
    if (!pulled.ok) {
      return { current: own.version, latest: latest.version, applied: false, error: `git pull failed: ${pulled.error}` };
    }
    return { current: own.version, latest: latest.version, applied: true, mode: 'git' };
  }

  // ponytail: tar overwrite of the package files; upgrade path is spawning the
  // profile's package manager once DSH exposes one portably.
  const stage = await mkdtemp(join(tmpdir(), 'issue-fixer-update-'));
  const result = { current: own.version, latest: latest.version, applied: false };
  try {
    const tarball = join(stage, 'release.tgz');
    const res = await fetch(latest.tarballUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      result.error = `download failed (HTTP ${res.status})`;
      return result;
    }
    await writeFile(tarball, Buffer.from(await res.arrayBuffer()));
    const extracted = await run('tar', ['-xzf', tarball, '-C', stage]);
    if (!extracted.ok) {
      result.error = `tar extract failed: ${extracted.error} (tar ships with Windows 10 1803+/macOS/Linux)`;
      return result;
    }
    const [root] = (await readdir(stage)).filter((name) => name !== 'release.tgz');
    if (!root) {
      result.error = 'tarball has no root folder';
      return result;
    }
    const stagedPkg = JSON.parse(await readFile(join(stage, root, 'package.json'), 'utf8'));
    if (!isNewer(stagedPkg.version, own.version)) {
      result.error = `release tarball is not newer (${stagedPkg.version})`;
      return result;
    }
    for (const file of [...(stagedPkg.files ?? []), 'package.json']) {
      await copyFile(join(stage, root, file), join(pluginDir, file));
    }
    result.applied = true;
    result.mode = 'files';
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
