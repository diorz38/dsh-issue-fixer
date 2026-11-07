// One runnable self-check: `node test.mjs`. No framework; exits non-zero on failure.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRepoRef, prepareFixBranch } from './repo.mjs';

function sh(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { windowsHide: true });
}
function at(cwd, ref) {
  return execFileSync('git', ['-C', cwd, 'rev-parse', ref], { encoding: 'utf8' }).trim();
}

const tmp = mkdtempSync(join(tmpdir(), 'issue-fixer-test-'));
try {
  assert.equal(parseRepoRef('https://github.com/o/r.git'), 'o/r');
  assert.equal(parseRepoRef('git@github.com:o/r.git'), 'o/r');
  assert.equal(parseRepoRef('https://gitlab.com/o/r'), null);

  sh(tmp, 'init', '-b', 'main');
  sh(tmp, 'config', 'user.email', 't@example.com');
  sh(tmp, 'config', 'user.name', 't');
  sh(tmp, 'commit', '--allow-empty', '-m', 'init');

  // 1: fresh branch cut from base
  const one = await prepareFixBranch({ cwd: tmp, base: 'main', name: 'issuefix/1' });
  assert(one.ok && one.branch === 'issuefix/1');
  sh(tmp, 'commit', '--allow-empty', '-m', 'fix 1');

  // 2: next fix branches from base, not from the previous fix branch
  const two = await prepareFixBranch({ cwd: tmp, base: 'main', name: 'issuefix/2' });
  assert(two.ok && two.branch === 'issuefix/2');
  assert.equal(at(tmp, 'issuefix/2'), at(tmp, 'main'));
  assert.notEqual(at(tmp, 'issuefix/2'), at(tmp, 'issuefix/1'));

  // 3: existing branch name gets a unique suffix instead of mixing history
  const again = await prepareFixBranch({ cwd: tmp, base: 'main', name: 'issuefix/1' });
  assert(again.ok && again.branch.startsWith('issuefix/1-') && again.branch !== 'issuefix/1');

  console.log('test.mjs: all checks passed');
} finally {
  try {
    if (process.platform === 'win32') {
      // git object files carry the read-only attribute; clear it or rmSync EPERMs.
      try { execFileSync('attrib', ['-r', join(tmp, '*'), '/s', '/d'], { windowsHide: true }); } catch { /* best effort */ }
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.warn(`test.mjs: could not clean ${tmp}: ${String(error)}`);
  }
}
