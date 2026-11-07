// dsh-issue-fixer: watch a GitHub repository and fix its open issues.
//
// First install has nothing configured, so the plugin activates in an inert
// "setup required" phase and serves a small setup/status API that the client
// plugin renders under Settings → Issue Fixer. The plugin refuses to operate
// until all required fields are filled AND the machine's logged-in GitHub
// account can actually push to the repository (owner/admin/maintain/push).
//
// Host half of the dual-face package; the browser half is ./client.js, declared
// through `dsh.client` in package.json and served by dsh-client-modules.
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIdentity, checkRepoAccess, createPullRequest } from './github.mjs';
import { checkCheckout, git, prepareFixBranch } from './repo.mjs';
import { selfUpdate } from './update.mjs';
import {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  REQUIRED_FIELDS,
  isConfigured,
  loadState,
  normalizeSettings,
  saveState,
  settingsFromState,
  settingsProblems,
} from './settings.mjs';

export const name = 'issue-fixer';

// No hard service dependencies: the setup UI must load even on an installation
// where the agent services are missing or still starting. The agent services are
// resolved lazily when a fix session actually starts.
export const inject = [];

const ROUTE_PREFIX = '/api/issue-fixer';
const BODY_LIMIT_BYTES = 32 * 1024;
const PROMPT_BODY_LIMIT = 8000;

function getHarnessHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  // .../harness/profiles/plugins/<plugin> → .../harness
  let dir = pluginDir;
  for (let i = 0; i < 6; i += 1) {
    if (basename(dir) === 'profiles') return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(dirname(pluginDir));
}

function nowIso() {
  return new Date().toISOString();
}

/** Issue predicate: open non-PR issues carrying every configured label. */
function wantedIssue(item, settings) {
  if (item.pull_request !== undefined) return false; // the issues API also lists PRs
  if (item.state !== 'open') return false;
  return settings.labels.every((want) => item.labels?.some((label) => label.name === want));
}

function taskPrompt(settings, issue) {
  const body = (issue.body ?? '').slice(0, PROMPT_BODY_LIMIT);
  return [
    `Fix GitHub issue ${settings.repo}#${issue.number}: ${issue.title}`,
    '',
    'Issue body:',
    body === '' ? '(no body)' : body,
    '',
    `Work in the repository at ${settings.cwd}; follow its AGENTS.md / CLAUDE.md instructions.`,
    'A dedicated fix branch has already been checked out for this issue; commit your work to it.',
    'Never commit to the main/master/default branch and never switch branches: all your commits',
    'belong on the fix branch that is already checked out.',
    'Steps: verify or reproduce the issue, implement the smallest safe fix, add a regression',
    'test if feasible, run the repository quality gates, then commit locally with a descriptive',
    settings.autoPr
      ? 'message. Do not push or open a pull request yourself; the plugin pushes the branch and opens the PR.'
      : 'message. Do not push, open a PR, or comment on the issue.',
  ].join('\n');
}

function summarizeProcessed(processed) {
  const issues = Object.entries(processed)
    .map(([number, record]) => ({ number: Number(number), ...record }))
    .sort((a, b) => b.number - a.number);
  const counts = { done: 0, failed: 0 };
  for (const record of Object.values(processed)) {
    if (record?.status === 'done') counts.done += 1;
    else if (record?.status === 'failed') counts.failed += 1;
  }
  return { counts, issues };
}

export function apply(ctx, rawConfig = {}) {
  const log = ctx.logger ?? console;
  const warn = (message) => (typeof log.warn === 'function' ? log.warn(message) : console.warn(message));
  const info = (message) => (typeof log.info === 'function' ? log.info(message) : console.info(message));

  const home = getHarnessHome();
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const config = rawConfig ?? {};
  const stateFile = typeof config.stateFile === 'string' && config.stateFile !== ''
    ? config.stateFile
    : join(home, 'issue-fixer-state.json');
  const defaults = normalizeSettings(config);

  let state = null;
  let settings = null;
  let token = null; // in-memory only, never returned to the browser
  let tokenFromUi = false; // a pasted token is the only one worth persisting
  let report = null; // last verification report
  let timerStop = null;
  let polling = false;
  // Branch fixes are cut from; captured when watching starts, never a fix branch itself.
  let baseBranch = null;
  // Remote fix branches are pushed to when autoPr is on; the one pointing at the watched repo.
  let pushRemote = 'origin';
  let disposed = false;
  let started = false;
  const queue = [];
  let running = null; // issue currently being fixed, surfaced in the status API
  let agentModules;
  let updateInfo = null; // last self-update outcome, surfaced in the status API
  let updateTimer = null;

  // ---------------------------------------------------------------- state io

  async function persist() {
    if (!state) return;
    try {
      state.settings = settings
        ? { ...settings, githubToken: tokenFromUi ? settings.githubToken : '' }
        : null;
      if (state.settings) state.tokenStored = tokenFromUi;
      await saveState(stateFile, state);
    } catch (error) {
      warn(`issue-fixer: cannot write ${stateFile}: ${String(error)}`);
    }
  }

  const issuefix = { maxAttempts: 3 };

  /** Fresh issue, or a failed one that still has attempts left. */
  function pickable(item) {
    const record = state.processed[item.number];
    if (record === undefined) return item.number > (state.baseline?.number ?? 0);
    if (record.status !== 'failed') return false;
    return (record.attempts ?? 1) < issuefix.maxAttempts;
  }


  function publicSettings(candidate = settings) {
    return {
      repo: candidate?.repo ?? '',
      cwd: candidate?.cwd ?? '',
      intervalMs: candidate?.intervalMs ?? DEFAULT_INTERVAL_MS,
      labels: candidate?.labels ?? [],
      tokenSource: candidate?.githubToken ? 'stored' : 'gh-cli',
      autoPr: candidate?.autoPr === true,
      autoUpdate: candidate?.autoUpdate !== false,
    };
  }

  function missingReport(candidate) {
    return {
      phase: 'setup-required',
      problems: settingsProblems(candidate),
      required: REQUIRED_FIELDS,
      identity: null,
      access: null,
      checkout: null,
      verifiedAt: null,
    };
  }

  /**
   * Run every gate: required fields → logged-in account → repository write
   * access → matching local checkout. The returned report carries an
   * `internal` field with the token; it is stripped before it reaches HTTP.
   */
  async function verify(candidate) {
    if (!isConfigured(candidate)) return missingReport(candidate);

    const identity = await resolveIdentity({ githubToken: candidate.githubToken });
    const result = {
      phase: 'blocked',
      problems: [],
      required: REQUIRED_FIELDS,
      identity: identity.ok
        ? { ok: true, login: identity.login, source: identity.source }
        : { ok: false, error: identity.error },
      access: null,
      checkout: null,
      verifiedAt: null,
    };
    if (!identity.ok) return result;

    const access = await checkRepoAccess(identity.token, candidate.repo);
    result.access = access.ok
      ? {
        ok: true,
        repo: access.repo,
        private: access.private,
        defaultBranch: access.defaultBranch,
        permissions: access.permissions,
        owner: access.owner,
      }
      : { ok: false, error: access.error, repo: candidate.repo };
    if (!access.ok) return result;

    const checkout = await checkCheckout({ cwd: candidate.cwd, repo: access.repo });
    result.checkout = {
      ok: checkout.ok,
      checks: checkout.checks,
      branch: checkout.branch ?? null,
      dirty: checkout.dirty ?? 0,
      topLevel: checkout.topLevel ?? null,
      remotes: checkout.remotes ?? [],
    };
    if (!checkout.ok) {
      const failing = checkout.checks.find((check) => !check.ok && check.id !== 'clean' && check.id !== 'identity');
      result.access.error = undefined;
      result.error = failing?.detail ?? 'The working directory is not usable.';
      return result;
    }

    result.phase = 'ready';
    result.verifiedAt = nowIso();
    result.internal = { token: identity.token, login: identity.login, repo: access.repo };
    return result;
  }

  function publicStatus() {
    return {
      phase: report?.phase ?? 'starting',
      problems: report?.problems ?? [],
      required: REQUIRED_FIELDS,
      settings: publicSettings(),
      identity: report?.identity ?? null,
      access: report?.access ?? null,
      checkout: report?.checkout ?? null,
      verifiedAt: report?.verifiedAt ?? null,
      error: report?.error ?? null,
      limits: { minIntervalMs: MIN_INTERVAL_MS, defaultIntervalMs: DEFAULT_INTERVAL_MS },
      activity: {
        baseline: state?.baseline ?? null,
        lastPollAt: state?.lastPollAt ?? null,
        lastError: state?.lastError ?? null,
        queue: queue.map((issue) => ({ number: issue.number, title: issue.title })),
        running: running ? { number: running.number, title: running.title } : null,
        ...summarizeProcessed(state?.processed ?? {}),
      },
      update: updateInfo,
      stateFile,
    };
  }

  // -------------------------------------------------------------- self-update

  const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  async function checkSelfUpdate(reason) {
    if (disposed || settings?.autoUpdate === false) return;
    try {
      const result = await selfUpdate({ pluginDir, token });
      updateInfo = { ...result, checkedAt: nowIso(), reason };
      if (result.applied) {
        info(`issue-fixer: self-updated ${result.current} → ${result.latest} (${result.mode}); restart DSH Desktop to activate`);
      } else if (result.error) {
        warn(`issue-fixer: self-update failed: ${result.error}`);
      }
    } catch (error) {
      updateInfo = { applied: false, error: String(error), checkedAt: nowIso(), reason };
      warn(`issue-fixer: self-update check failed: ${String(error)}`);
    }
  }

  // ---------------------------------------------------------------- watching

  function makeInterval(callback, intervalMs) {
    // `ctx.interval` needs the `timer` service declared in `inject`; this plugin
    // keeps `inject = []` so the setup screen loads even when agent services are
    // missing, so fall back to a plain timer that `stopWatching` can clear.
    try {
      if (typeof ctx.interval === 'function') return ctx.interval(callback, intervalMs);
    } catch {
      // fall through to the plain timer below
    }
    const id = setInterval(callback, intervalMs);
    if (typeof id?.unref === 'function') id.unref();
    return () => clearInterval(id);
  }

  function stopWatching() {
    if (timerStop) {
      try {
        timerStop();
      } catch {
        // timer already gone
      }
      timerStop = null;
    }
  }

  function startWatching() {
    stopWatching();
    if (disposed || report?.phase !== 'ready') return;
    token = report.internal.token;
    const current = report.checkout?.branch ?? null;
    if (current && !current.startsWith('issuefix/')) baseBranch = current;
    const remote = (report.checkout?.remotes ?? []).find((r) => r.repo?.toLowerCase() === settings.repo.toLowerCase());
    if (remote) pushRemote = remote.name;
    timerStop = makeInterval(() => void poll(), settings.intervalMs);
    void poll();
    info(`issue-fixer: watching ${settings.repo} in ${settings.cwd} every ${Math.round(settings.intervalMs / 60000)} min as ${report.internal.login}`);
  }

  async function fetchOpenIssues() {
    const url = `https://api.github.com/repos/${settings.repo}/issues?state=open&per_page=30&sort=created&direction=desc`;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-issue-fixer',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const items = await res.json();
    if (!Array.isArray(items)) throw new Error('GitHub API returned a non-list body');
    return items;
  }

  async function revalidate() {
    report = await verify(settings);
    if (report.phase !== 'ready') {
      warn(`issue-fixer: stopped — ${report.identity?.error ?? report.access?.error ?? report.error ?? 'setup incomplete'}`);
      stopWatching();
      await persist();
    } else {
      token = report.internal.token;
    }
    return report;
  }

  async function poll() {
    if (polling || disposed) return;
    if (!settings || report?.phase !== 'ready') return;
    polling = true;
    try {
      const items = await fetchOpenIssues();
      const maxNumber = items.reduce((max, item) => Math.max(max, item.number ?? 0), 0);
      const repoKey = settings.repo.toLowerCase();
      if (!state.baseline || String(state.baseline.repo ?? '').toLowerCase() !== repoKey) {
        state.baseline = { repo: settings.repo, number: maxNumber };
        state.lastPollAt = nowIso();
        state.lastError = null;
        await persist();
        info(`issue-fixer: baseline for ${settings.repo}: ignoring issues <= #${maxNumber}`);
        return;
      }
      const fresh = items
        .filter((item) => wantedIssue(item, settings) && pickable(item))
        .sort((a, b) => a.number - b.number);
      for (const issue of fresh) queue.push(issue);
      if (maxNumber > state.baseline.number) state.baseline.number = maxNumber;
      state.lastPollAt = nowIso();
      state.lastError = null;
      await persist();
      if (fresh.length > 0) {
        info(`issue-fixer: queued ${fresh.map((issue) => `#${issue.number}`).join(', ')} from ${settings.repo}`);
      }
      await drain();
      await repairPendingPrs();
    } catch (error) {
      state.lastError = String(error);
      warn(`issue-fixer: poll failed: ${String(error)}`);
      await persist();
      if (/\b401\b|Bad credentials/i.test(String(error))) void revalidate();
    } finally {
      polling = false;
    }
  }

  /**
   * Republish fix branches that were pushed without a PR (an older version
   * pushed an empty branch, or PR creation failed). Runs on poll after the
   * queue drains; a branch with commits and no PR gets one, an empty one is
   * deleted from the remote and its issue becomes retryable.
   */
  async function repairPendingPrs() {
    if (settings.autoPr !== true || !token) return;
    const pending = Object.entries(state.processed)
      .filter(([, record]) => record?.status === 'done' && record.branch && record.prError && !record.prUrl)
      .map(([number, record]) => ({ number: Number(number), ...record }));
    for (const record of pending) {
      try {
        const commits = await commitsAhead(settings.cwd, baseBranch, record.branch);
        if (commits === 0) {
          await git(settings.cwd, ['push', pushRemote || 'origin', '--delete', record.branch]);
          state.processed[record.number] = { ...record, status: 'failed', prError: undefined, attempts: 0, error: 'the fix branch had no commits; pushed branch removed and the issue will be retried' };
          warn(`issue-fixer: ${settings.repo}#${record.number} had an empty fix branch; deleted the remote branch and will retry`);
          await persist();
          continue;
        }
        const local = await git(settings.cwd, ['rev-parse', '--verify', `refs/heads/${record.branch}`]);
        if (!local.ok) {
          // The local fix branch is gone, so there is nothing to publish and the
          // issue stays stuck forever unless it becomes retryable again.
          state.processed[record.number] = { ...record, status: 'failed', prError: undefined, attempts: 0, error: `fix branch ${record.branch} no longer exists; the issue will be retried` };
          await persist();
          warn(`issue-fixer: ${settings.repo}#${record.number} fix branch ${record.branch} is gone; will retry the issue`);
          continue;
        }
        const pushed = await git(settings.cwd, ['push', pushRemote || 'origin', record.branch]);
        if (!pushed.ok) {
          warn(`issue-fixer: cannot republish ${record.branch}: ${pushed.error}`);
          continue;
        }
        const pr = await createPullRequest(token, {
          repo: settings.repo,
          title: `Fix #${record.number}: ${record.title ?? ''}`.trim(),
          body: [`Fixes #${record.number}`, '', `Automated fix by dsh-issue-fixer session \`${record.sessionId ?? '?'}\`.`].join('\n'),
          head: record.branch,
          base: baseBranch ?? undefined,
        });
        state.processed[record.number] = pr.ok
          ? { ...record, prUrl: pr.url, prError: undefined }
          : { ...record, prError: pr.error };
        await persist();
        if (pr.ok) info(`issue-fixer: opened PR for ${settings.repo}#${record.number}: ${pr.url}`);
        else warn(`issue-fixer: PR retry for ${settings.repo}#${record.number} failed: ${pr.error}`);
      } catch (error) {
        warn(`issue-fixer: PR repair for ${settings.repo}#${record.number} failed: ${String(error)}`);
      }
    }
  }

  // ------------------------------------------------------------ fix sessions

  /** Commits added on `branch` relative to `base`; null when git cannot tell. */
  async function commitsAhead(cwd, base, branch) {
    if (!base) return null;
    const range = await git(cwd, ['rev-list', '--count', `${base}..${branch}`]);
    if (!range.ok) return null;
    const count = Number(range.stdout);
    return Number.isFinite(count) ? count : null;
  }

  async function loadAgentModules() {
    if (!agentModules) {
      const [agentPkg, llmPkg] = await Promise.all([
        import('@deepseek-ai/dsh-agent'),
        import('@deepseek-ai/dsh-llm'),
      ]);
      agentModules = { installModelSelection: agentPkg.installModelSelection, createUserMessage: llmPkg.createUserMessage };
    }
    return agentModules;
  }

  // Sequential only: parallel fix sessions in one checkout would fight over the
  // same files and build directory. Queue or a worktree pool if volume needs it.
  /**
   * Push the fix branch and open a PR against the base branch. Failure is a
   * report, not a throw: the agent's fix commits already exist locally.
   */
  async function pushAndOpenPr(branch, issue, sessionId) {
    const remote = pushRemote || 'origin';
    const pushed = await git(settings.cwd, ['push', remote, branch]);
    if (!pushed.ok) return { ok: false, error: `git push ${remote} ${branch} failed: ${pushed.error}` };
    if (!token) return { ok: false, error: 'no GitHub token in memory; cannot open the PR' };
    return createPullRequest(token, {
      repo: settings.repo,
      title: `Fix #${issue.number}: ${issue.title}`,
      body: [`Fixes #${issue.number}`, '', `Automated fix by dsh-issue-fixer session \`${sessionId}\`.`].join('\n'),
      head: branch,
      base: baseBranch ?? undefined,
    });
  }

  async function runFixSession(issue) {
    const agents = ctx.get?.('agents');
    const sessions = ctx.get?.('sessions');
    if (!agents || !sessions) {
      throw new Error('agent services (agents/sessions) are unavailable in this profile; cannot start a fix session');
    }

    // Isolate the fix on its own branch before the agent touches anything.
    const branch = await prepareFixBranch({
      cwd: settings.cwd,
      base: baseBranch,
      name: `issuefix/${issue.number}`,
    });
    if (!branch.ok) throw new Error(branch.error);

    const { installModelSelection, createUserMessage } = await loadAgentModules();
    const selectionService = ctx.get?.('agentDefaultModel');
    const selection = selectionService?.currentSelection?.() ?? {};

    // A preset decides which tools and prompt sections an agent gets. Without
    // one the session has no tools at all ("unknown tool" for every call), so
    // mount the current default preset like the host's own webhook path does.
    const presets = ctx.get?.('agentPresets');
    const presetId = presets?.defaultId;
    if (!presets) {
      throw new Error('agentPresets service is unavailable in this profile, so the fix session would have no tools');
    }
    if (!presetId) {
      throw new Error('agentPresets service has no default preset; cannot mount tools for the fix session');
    }

    const slug = `${settings.repo.replace(/[^\w.-]/g, '-')}-${issue.number}`;
    const baseOptions = {
      agentOptions: { provider: selection.provider, model: selection.model },
      meta: { cwd: settings.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      // The agents service calls `(await setup(...))?.commit()`, so this must
      // return nothing: installModelSelection returns a disposer function,
      // and a truthy value there makes the host call `.commit()` on it.
      setup: async (agentCtx) => {
        if (presets && presetId) await presets.mount(agentCtx, presetId);
        const dispose = installModelSelection(agentCtx, { current: selection, assembled: undefined });
        if (typeof agentCtx?.effect === 'function') {
          agentCtx.effect(() => dispose, 'issue-fixer:model-selection');
        }
      },
    };
    let sessionId = `session-issuefix-${slug}`;
    let handle;
    try {
      handle = await agents.create({ sessionId, ...baseOptions });
    } catch (error) {
      // Only a taken id is retryable; anything else is a real failure that a
      // fresh UUID would hide.
      if (!/exist|taken|duplicate|already/i.test(String(error))) throw error;
      warn(`issue-fixer: session id "${sessionId}" taken (${String(error)}); minting a new one`);
      sessionId = `session-issuefix-${randomUUID()}`;
      handle = await agents.create({ sessionId, ...baseOptions });
    }

    const agent = handle.agent;
    await agent.whenIdle();

    let failure;
    const stopErrors = ctx.on('agent/error', ({ agent: subject, error }) => {
      if (subject === agent) failure = error;
    });
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskPrompt(settings, issue) }],
        source: { kind: 'user' },
      }));
      const subagents = ctx.get?.('subagents');
      for (;;) {
        await agent.whenIdle();
        const idleSeq = agent.session.seq;
        // eslint-disable-next-line no-await-in-loop
        if (!(await subagents?.waitForChildren(agent)) && agent.status === 'idle' && agent.session.seq === idleSeq) break;
      }
      await sessions.flush(agent.session);
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
    } finally {
      stopErrors();
    }
    // Nothing committed means the run changed nothing (tool-less agent, refusal,
    // or a no-op fix); never push and never report it as a success.
    const commits = await commitsAhead(settings.cwd, baseBranch, branch.branch);
    const pr = settings.autoPr === true && commits !== 0
      ? await pushAndOpenPr(branch.branch, issue, sessionId)
      : null;
    return { sessionId, branch: branch.branch, pr, commits };
  }

  async function drain() {
    while (queue.length > 0 && !disposed) {
      const issue = queue.shift();
      running = issue;
      try {
        const { sessionId, branch, pr, commits } = await runFixSession(issue);
        // A session that produced no commit changed nothing; calling that "done"
        // hides a tool-less or no-op run. Treat it as a failed attempt.
        if (commits === 0) {
          throw new Error('the fix session committed nothing — the agent could not change the checkout (missing tools or refusal)');
        }
        state.processed[issue.number] = {
          sessionId,
          branch,
          title: issue.title,
          at: nowIso(),
          status: 'done',
          ...(commits ? { commits } : {}),
          ...(pr ? (pr.ok ? { prUrl: pr.url } : { prError: pr.error }) : {}),
        };
        info(`issue-fixer: ${settings.repo}#${issue.number} fix session ${sessionId} finished`);
        if (pr && !pr.ok) warn(`issue-fixer: ${settings.repo}#${issue.number} PR failed: ${pr.error}`);
      } catch (error) {
        const attempts = (state.processed[issue.number]?.attempts ?? 0) + 1;
        state.processed[issue.number] = {
          title: issue.title,
          at: nowIso(),
          status: 'failed',
          attempts,
          error: String(error),
        };
        warn(`issue-fixer: fix session for ${settings.repo}#${issue.number} failed (attempt ${attempts}/${issuefix.maxAttempts}): ${String(error)}`);
      }
      running = null;
      await persist();
    }
  }

  // -------------------------------------------------------------- HTTP seam

  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  function route(handler) {
    return async (request) => {
      try {
        return await handler(request);
      } catch (error) {
        return jsonResponse(400, { error: String(error?.message ?? error) });
      }
    };
  }

  async function readBody(request) {
    const text = await request.text();
    if (text === '') return {};
    if (text.length > BODY_LIMIT_BYTES) throw new Error('request body is too large');
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new Error('request body is not valid JSON');
    }
  }

  /** Build the settings a request would save, keeping the stored token unless replaced. */
  function candidateFrom(body) {
    const base = settings ?? normalizeSettings({});
    const minutes = Number(body.intervalMinutes);
    const intervalMs = Number.isFinite(minutes) && minutes > 0
      ? Math.max(MIN_INTERVAL_MS, Math.round(minutes * 60000))
      : base.intervalMs;
    let githubToken = base.githubToken;
    if (body.useGhCli === true) githubToken = '';
    else if (typeof body.githubToken === 'string' && body.githubToken.trim() !== '') githubToken = body.githubToken.trim();
    return {
      settings: normalizeSettings({
        repo: typeof body.repo === 'string' ? body.repo : base.repo,
        cwd: typeof body.cwd === 'string' ? body.cwd : base.cwd,
        intervalMs,
        labels: Array.isArray(body.labels) ? body.labels : base.labels,
        githubToken,
        autoPr: typeof body.autoPr === 'boolean' ? body.autoPr : base.autoPr,
        autoUpdate: typeof body.autoUpdate === 'boolean' ? body.autoUpdate : base.autoUpdate,
      }),
      tokenFromUi: body.useGhCli === true ? false : (typeof body.githubToken === 'string' && body.githubToken.trim() !== '') || tokenFromUi,
    };
  }

  async function statusRoute() {
    return jsonResponse(200, publicStatus());
  }

  async function checkRoute(request) {
    const candidate = candidateFrom(await readBody(request));
    const checked = await verify(candidate.settings);
    const { internal, ...visible } = checked;
    return jsonResponse(200, { ...visible, settings: publicSettings(candidate.settings), activity: publicStatus().activity });
  }

  async function saveRoute(request) {
    const candidate = candidateFrom(await readBody(request));
    const checked = await verify(candidate.settings);
    if (checked.phase !== 'ready') {
      const { internal, ...visible } = checked;
      return jsonResponse(409, { ...visible, settings: publicSettings(candidate.settings) });
    }
    if (!state) state = { settings: null, processed: {}, baseline: null };
    settings = candidate.settings;
    tokenFromUi = candidate.tokenFromUi;
    settings.repo = checked.internal.repo; // adopt upstream spelling
    report = checked;
    state.identity = { login: checked.internal.login, source: checked.identity.source, verifiedAt: checked.verifiedAt };
    if (!state.baseline || String(state.baseline.repo ?? '').toLowerCase() !== settings.repo.toLowerCase()) {
      state.baseline = null; // a new repository gets a fresh baseline
    }
    await persist();
    startWatching();
    info(`issue-fixer: setup saved — watching ${settings.repo}`);
    return jsonResponse(200, { saved: true, status: publicStatus() });
  }

  /**
   * Move the baseline. Issues are only picked when their number is above it, so
   * lowering it reopens older issues; 0 makes every open issue eligible.
   */
  async function baselineRoute(request) {
    const body = await readBody(request);
    const number = Number(body.number);
    if (!Number.isInteger(number) || number < 0) {
      return jsonResponse(400, { error: 'baseline must be an integer >= 0' });
    }
    if (!state) state = { settings: null, processed: {}, baseline: null };
    if (!settings?.repo) return jsonResponse(409, { error: 'set up the repository first' });
    state.baseline = { repo: settings.repo, number };
    await persist();
    info(`issue-fixer: baseline for ${settings.repo} set to #${number}`);
    void poll();
    return jsonResponse(200, { baseline: state.baseline, status: publicStatus() });
  }

  async function resetRoute() {    stopWatching();
    settings = normalizeSettings(defaults);
    token = null;
    tokenFromUi = false;
    report = missingReport(settings);
    if (state) {
      state.settings = null;
      state.identity = null;
      state.baseline = null;
      state.lastError = null;
      await persist();
    }
    return jsonResponse(200, { reset: true, status: publicStatus() });
  }

  // `requestBody: 'buffered'` is required even for GET: without it the bridge
  // treats the request as streaming and a bodyless GET fails with 400.
  const ROUTES = [
    { path: `${ROUTE_PREFIX}.status`, methods: ['GET'], requestBody: 'buffered', fetch: route(statusRoute) },
    { path: `${ROUTE_PREFIX}.check`, methods: ['POST'], requestBody: 'buffered', fetch: route(checkRoute) },
    { path: `${ROUTE_PREFIX}.save`, methods: ['POST'], requestBody: 'buffered', fetch: route(saveRoute) },
    { path: `${ROUTE_PREFIX}.baseline`, methods: ['POST'], requestBody: 'buffered', fetch: route(baselineRoute) },
    { path: `${ROUTE_PREFIX}.reset`, methods: ['POST'], requestBody: 'buffered', fetch: route(resetRoute) },
  ];

  // --------------------------------------------------------------- lifecycle

  ctx.effect(() => {
    void (async () => {
      try {
        state = await loadState(stateFile);
        settings = settingsFromState(state, defaults);
        tokenFromUi = state.tokenStored === true;
        report = await verify(settings);
        if (report.phase === 'ready') {
          settings.repo = report.internal.repo;
          state.identity = { login: report.internal.login, source: report.identity.source, verifiedAt: report.verifiedAt };
          await persist();
          startWatching();
        } else {
          const reason = report.problems[0]?.message
            ?? report.identity?.error
            ?? report.access?.error
            ?? report.error
            ?? 'setup is incomplete';
          warn(`issue-fixer: waiting for setup — open Settings → Issue Fixer (${reason})`);
          await persist();
        }
      } catch (error) {
        warn(`issue-fixer: startup failed: ${String(error)}`);
      }
      // Self-update runs regardless of setup phase; a fresh install should be
      // fixable before the user finishes configuring it.
      void checkSelfUpdate('startup');
      updateTimer = setInterval(() => void checkSelfUpdate('daily'), UPDATE_INTERVAL_MS);
      updateTimer.unref?.();
    })();
    return () => {
      disposed = true;
      stopWatching();
      if (updateTimer) clearInterval(updateTimer);
    };
  }, 'issue-fixer');

  // The setup API rides the authenticated `connection` Fetch registry: every
  // request is fenced by the Host/Origin check and must come from the browser
  // owner peer. The raw `webServer` seam has no authentication whatsoever, so it
  // must never be the door to a GitHub token.
  ctx.inject(['connection'], (connCtx) => {
    for (const definition of ROUTES) {
      connCtx.connection.fetch.register(definition);
    }
    info(`issue-fixer: setup API on ${ROUTES.map((item) => item.path).join(', ')}`);
  });
}
