import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const script = path.resolve(import.meta.dirname, '../deploy/deploy-store-management.sh');

test('deployment rejects moving branches, malformed SHAs, destinations and server arguments', () => {
  for (const args of [[], ['main'], ['9fb9b19'], ['a'.repeat(40) + ';echo bad'], ['a'.repeat(40), 'root@host;echo bad'], ['a'.repeat(40), '-oProxyCommand=bad'], ['--on-server', 'a'.repeat(40), 'unexpected']]) {
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, JSON.stringify({ args, stderr: result.stderr }));
  }
  assert.equal(spawnSync('bash', [script, '--help']).status, 0);
});

test('deployment dispatches an exact committed SHA and script only; dirty tracked files prevent dispatch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-deploy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'deploy')); fs.mkdirSync(path.join(dir, 'bin'));
  const copied = path.join(dir, 'deploy/deploy-store-management.sh');
  fs.copyFileSync(script, copied);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', 'deploy/deploy-store-management.sh');
  git('-c', 'user.name=Deployment Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'bin/ssh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DEPLOY_TEST_DIR/ssh-args"\ncat > "$DEPLOY_TEST_DIR/ssh-stdin"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(dir, 'bin') + ':' + process.env.PATH, DEPLOY_TEST_DIR: dir };
  let result = spawnSync('bash', [copied, sha, 'root@deployment.example'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(path.join(dir, 'ssh-args'), 'utf8');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.endsWith(`root@deployment.example\nbash -s -- --on-server ${sha}\n`));
  assert.equal(fs.readFileSync(path.join(dir, 'ssh-stdin'), 'utf8'), fs.readFileSync(script, 'utf8'));
  fs.unlinkSync(path.join(dir, 'ssh-args'));
  fs.appendFileSync(copied, '\n# uncommitted change\n');
  result = spawnSync('bash', [copied, sha, 'root@deployment.example'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Commit tracked changes/);
  assert.equal(fs.existsSync(path.join(dir, 'ssh-args')), false);
});
