import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// Deployment runs through comeover/scripts/deploy-release.sh; these hooks hold the store-specific steps.
const hooks = fs.readFileSync(path.resolve(import.meta.dirname, '../deploy/release.sh'), 'utf8');

test('release hooks restart only the store service and keep its unit and state paths', () => {
  assert.match(hooks, /^SERVICES=\(store-management\.service\)$/m);
  assert.match(hooks, /^UNIT_FILES=\(deploy\/store-management\.service\)$/m);
  assert.match(hooks, /^HEALTH_URL=http:\/\/127\.0\.0\.1:8791\/health\/store$/m);
  assert.match(hooks, /^REQUIRED_PATHS=\(\/etc\/store-management\.env \/var\/lib\/store-management\/coupons\.db\)$/m);
});

test('coupon data is backed up and the schema upgrade is proven on a copy before the switch', () => {
  const backup = hooks.match(/release_backup\(\) \{([\s\S]*?)\nNODE\n\}/)?.[1];
  assert.ok(backup, 'release_backup is defined');
  assert.match(backup, /backup_sqlite \/var\/lib\/store-management\/coupons\.db/);
  assert.match(backup, /copyFileSync\(process\.env\.BACKUP_FILE/);
  assert.match(backup, /createRepository\(\{stateDir:dir\}\)/);
});

test('verification checks exact public assets, protected writes and live database integrity', () => {
  const verify = hooks.slice(hooks.indexOf('release_verify()'));
  assert.match(verify, /'https:\/\/comeover\.cn'/);
  assert.match(verify, /assert\.equal\(await response\.text\(\),fs\.readFileSync\(file,'utf8'\)\)/);
  assert.match(verify, /assert\.equal\(denied\.status,401\)/);
  assert.match(verify, /PRAGMA integrity_check/);
});

test('tests run unprivileged and the service account can read the QR decoder', () => {
  assert.match(hooks, /run_isolated node --test tests\/\*\.test\.js/);
  assert.match(hooks, /runuser -u store-management -- test -r node_modules\/jsqr\/dist\/jsQR\.js/);
});
