// Settings + durable state for dsh-issue-fixer.
//
// First install has no usable settings: the plugin must stay inert until the
// user fills the required fields in the setup UI. Everything the plugin needs
// lives in one JSON file so the UI and the poller never disagree:
//
//   { version, settings: { repo, cwd, intervalMs, labels, githubToken },
//     identity, repo, baseline: { repo, number }, processed, lastPollAt, lastError }
//
// The file holds no secrets unless the user explicitly pastes a token; the
// machine's `gh` CLI keyring session is preferred and never copied here.
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MIN_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 300_000;
export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
export const SYNC_MODES = ['merge']; // rebase intentionally omitted (unsafe default); merge only for now
export const SYNC_AUTO_MODES = ['manual', 'auto'];
export const SYNC_CONFLICT_MODES = ['manual', 'agent']; // agent = opt-in: resolve mod-branch merge conflicts with an agent session, then verify/push

/** Fields the user MUST fill before the plugin will watch anything. */
export const REQUIRED_FIELDS = [
  {
    key: 'repo',
    label: 'GitHub repository',
    hint: 'owner/name — the account below must be able to push to it',
  },
  {
    key: 'cwd',
    label: 'Working directory',
    hint: 'absolute path of the local git checkout the fixes are committed in',
  },
];

export function emptyState() {
  return {
    version: 3,
    settings: null,
    identity: null,
    repo: null,
    baseline: null,
    processed: {},
    lastPollAt: null,
    lastError: null,
    sync: {
      lastRunAt: null,
      lastResult: null, // 'ok' | 'error' | 'conflict' | 'skipped'
      lastMessage: null,
      lastSteps: [],
    },
  };
}

function normalizeSync(raw = {}) {
  const sync = raw && typeof raw === 'object' ? raw : {};
  const trigger = SYNC_AUTO_MODES.includes(sync.trigger) ? sync.trigger : 'manual';
  const conflictResolution = SYNC_CONFLICT_MODES.includes(sync.conflictResolution) ? sync.conflictResolution : 'manual';
  const minCommitsBehindRaw = Number(sync.minCommitsBehind);
  return {
    enabled: sync.enabled === true,
    upstreamRepo: typeof sync.upstreamRepo === 'string' ? sync.upstreamRepo.trim() : '',
    upstreamRemote: typeof sync.upstreamRemote === 'string' ? sync.upstreamRemote.trim() : '',
    mainBranch: typeof sync.mainBranch === 'string' ? sync.mainBranch.trim() : '',
    modBranch: typeof sync.modBranch === 'string' ? sync.modBranch.trim() : '',
    mode: 'merge', // merge only (user-selected strategy)
    trigger, // 'manual' | 'auto'
    push: sync.push !== false, // default true when enabled; explicit in UI
    minCommitsBehind: Number.isFinite(minCommitsBehindRaw) && minCommitsBehindRaw >= 0
      ? Math.floor(minCommitsBehindRaw)
      : 0, // 0 = always sync when behind; >0 skips upstream sync if behind by fewer commits
    conflictResolution, // 'manual' = abort+report on mod-branch conflicts; 'agent' = agent resolves in place, then verify/push
  };
}

/** Normalize a raw settings object (patch config or a JSON body from the UI). */
export function normalizeSettings(raw = {}) {
  const settings = {
    repo: typeof raw.repo === 'string' ? raw.repo.trim() : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '',
    intervalMs: Number.isFinite(raw.intervalMs) && raw.intervalMs >= MIN_INTERVAL_MS
      ? Math.floor(raw.intervalMs)
      : DEFAULT_INTERVAL_MS,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => String(label).trim()).filter(Boolean)
      : [],
    githubToken: typeof raw.githubToken === 'string' ? raw.githubToken.trim() : '',
    autoPr: raw.autoPr === true,
    autoUpdate: raw.autoUpdate !== false,
    sync: normalizeSync(raw.sync),
  };
  return settings;
}

/** Problems that block activation. Empty array means the required fields are filled. */
export function settingsProblems(settings) {
  const problems = [];
  if (!settings.repo) {
    problems.push({ field: 'repo', label: 'GitHub repository', message: 'Required: the repository the plugin should watch.' });
  } else if (!REPO_PATTERN.test(settings.repo)) {
    problems.push({ field: 'repo', label: 'GitHub repository', message: 'Use the owner/name form, for example octocat/hello-world.' });
  }
  if (!settings.cwd) {
    problems.push({ field: 'cwd', label: 'Working directory', message: 'Required: the local checkout the fixes are committed in.' });
  }
  if (settings.sync?.enabled) {
    if (!settings.sync.modBranch) {
      problems.push({ field: 'sync.modBranch', label: 'Modification branch', message: 'Required when fork sync is enabled: the branch that holds your own modifications.' });
    }
    if (settings.sync.upstreamRepo && !REPO_PATTERN.test(settings.sync.upstreamRepo)) {
      problems.push({ field: 'sync.upstreamRepo', label: 'Upstream repository', message: 'Use the owner/name form for the upstream repository.' });
    }
    if (settings.sync.mainBranch && settings.sync.modBranch && settings.sync.mainBranch === settings.sync.modBranch) {
      problems.push({ field: 'sync.modBranch', label: 'Modification branch', message: 'The modification branch must be different from the main branch.' });
    }
    if (!Number.isInteger(settings.sync.minCommitsBehind) || settings.sync.minCommitsBehind < 0) {
      problems.push({ field: 'sync.minCommitsBehind', label: 'Minimum commits behind', message: 'Minimum commits behind must be an integer 0 or greater.' });
    }
    if (settings.sync.conflictResolution && !SYNC_CONFLICT_MODES.includes(settings.sync.conflictResolution)) {
      problems.push({ field: 'sync.conflictResolution', label: 'Conflict resolution', message: 'Conflict resolution must be manual or agent.' });
    }
  }
  return problems;
}

/** True when every required field is present and well-formed. */
export function isConfigured(settings) {
  return settingsProblems(settings).length === 0;
}

export function settingsFromState(state, defaults) {
  if (state?.settings) return normalizeSettings({ ...defaults, ...state.settings });
  // Legacy v1 files kept the resolved repo/cwd at the top level.
  if (state && (typeof state.repo === 'string' || typeof state.cwd === 'string')) {
    return normalizeSettings({ ...defaults, repo: state.repo ?? '', cwd: state.cwd ?? '' });
  }
  return normalizeSettings(defaults);
}

export async function loadState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const base = emptyState();
    const state = { ...base, ...parsed };
    state.processed = { ...(parsed.processed ?? {}) };
    state.sync = { ...base.sync, ...(parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : {}) };
    if (state.baseline === undefined || state.baseline === null) {
      // v1 recorded the newest issue number in `lastSeen`; keep it as a baseline
      // only when it is a real number, so a fresh install still baselines.
      state.baseline = typeof parsed.lastSeen === 'number' && parsed.lastSeen > 0
        ? { repo: parsed.repo ?? null, number: parsed.lastSeen }
        : null;
    }
    return state;
  } catch {
    return emptyState(); // missing or corrupt state starts from a fresh baseline
  }
}

export async function saveState(file, state) {
  const body = {
    ...state,
    settings: state.settings ? { ...state.settings, githubToken: state.settings.githubToken ?? '' } : null,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600); // best effort: the file may hold a pasted token
  } catch {
    // Windows ACLs do not map onto POSIX modes; ignore.
  }
}
