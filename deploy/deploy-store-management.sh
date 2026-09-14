#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo 'Usage: bash deploy/deploy-store-management.sh <full-40-character-commit-SHA> [root@server]'
  echo 'Fetches the exact commit from GitHub into a new release, verifies it, and switches with rollback.'
}

if [[ "${1:-}" = --help || "${1:-}" = -h ]]; then usage; exit 0; fi
remote_mode=0
if [[ "${1:-}" = --on-server ]]; then remote_mode=1; shift; fi
expected=${1:-}
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then usage >&2; exit 2; fi
if [[ "$remote_mode" = 0 ]]; then
  [[ $# -le 2 ]] || { usage >&2; exit 2; }
  server=${2:-root@139.196.140.215}
  [[ "$server" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]] || { echo 'Invalid SSH destination' >&2; exit 2; }
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  git -C "$script_dir/.." cat-file -e "$expected^{commit}"
  [[ -z "$(git -C "$script_dir/.." status --porcelain --untracked-files=no)" ]] || { echo 'Commit tracked changes before deploying.' >&2; exit 1; }
  # Only this deployment script crosses SSH; the server obtains all release code from GitHub.
  exec ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$server" \
    "bash -s -- --on-server $expected" < "$script_dir/deploy-store-management.sh"
fi
[[ $# = 1 && "$EUID" = 0 ]] || { echo 'Server mode requires root and one commit SHA.' >&2; exit 2; }
for command in git npm node sqlite3 curl flock systemctl runuser; do command -v "$command" >/dev/null; done

app_root=/opt/store-management
state_dir=/var/lib/store-management
service=store-management.service
repository=git@github.com:zzyspace/store-management.git
key=/root/.ssh/id_ed25519_github_store_management
[[ -r "$key" ]] || { echo "Missing repository deploy key: $key" >&2; exit 1; }
export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10"
export GIT_TERMINAL_PROMPT=0
exec 9>"$app_root/.deploy.lock"
flock -n 9 || { echo 'Another store deployment is running.' >&2; exit 1; }
previous=$(readlink -f "$app_root/current")
[[ -d "$previous/.git" && -f "$state_dir/coupons.db" ]]
systemctl is-active --quiet "$service"
printf 'PREVIOUS_SHA=%s\n' "$(git -C "$previous" rev-parse HEAD)"
# Read access must work before creating any candidate or touching the current release.
git ls-remote "$repository" refs/heads/main >/dev/null
release="$app_root/releases/$expected"
if [[ -e "$release" ]]; then
  [[ "$(git -C "$release" rev-parse HEAD)" = "$expected" ]]
  [[ -z "$(git -C "$release" status --porcelain)" ]]
else
  umask 022
  candidate=$(mktemp -d "$app_root/releases/.prepare-$expected-XXXXXX")
  git init --quiet "$candidate"
  git -C "$candidate" remote add origin "$repository"
  git -C "$candidate" fetch --no-tags --depth=1 origin "$expected"
  [[ "$(git -C "$candidate" rev-parse FETCH_HEAD)" = "$expected" ]]
  git -C "$candidate" checkout --quiet --detach "$expected"
  cd "$candidate"
  if cmp -s "$previous/package-lock.json" package-lock.json && [[ -d "$previous/node_modules" ]]; then
    cp -a "$previous/node_modules" node_modules
  else
    npm ci --omit=dev --no-audit --no-fund
  fi
  npm ls --omit=dev --depth=0
  npm test
  chmod -R a+rX "$candidate"
  runuser -u store-management -- test -r "$candidate/node_modules/jsqr/dist/jsQR.js"
  mv "$candidate" "$release"
fi
cd "$release"
[[ "$(git rev-parse HEAD)" = "$expected" && -z "$(git status --porcelain)" ]]
[[ -r node_modules/jsqr/dist/jsQR.js ]]
backup_dir="/var/backups/store-management/$(date -u +%Y%m%dT%H%M%SZ)-${expected:0:7}"
install -d -m 700 "$backup_dir"
sqlite3 "$state_dir/coupons.db" ".backup '$backup_dir/coupons.db'"
chmod 600 "$backup_dir/coupons.db"
[[ "$(sqlite3 "$backup_dir/coupons.db" 'PRAGMA integrity_check;')" = ok ]]
printf 'BACKUP=%s\n' "$backup_dir/coupons.db"
# Check the schema upgrade on a private backup copy, preserving live data.
BACKUP_FILE="$backup_dir/coupons.db" node --input-type=module <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createRepository } from './server/repository.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'store-upgrade-'));
try {
  fs.copyFileSync(process.env.BACKUP_FILE,path.join(dir,'coupons.db'));
  const db=new Database(path.join(dir,'coupons.db'));
  const count=db.prepare('SELECT count(*) AS n FROM coupons').get().n;
  createRepository({stateDir:dir}).close();
  assert.equal(db.prepare('SELECT count(*) AS n FROM coupons').get().n,count);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  db.close();
  console.log('Backup schema upgrade verified');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
NODE
wait_for_health() {
  local attempt
  for ((attempt=1;attempt<=20;attempt++)); do
    if curl --max-time 2 -fsS http://127.0.0.1:8791/health/store >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
switched=0
rollback() {
  local code=$?
  trap - ERR
  if [[ "$switched" = 1 ]]; then
    echo "Release verification failed; restoring $previous" >&2
    ln -s "$previous" "$app_root/.rollback-$$"
    mv -Tf "$app_root/.rollback-$$" "$app_root/current"
    systemctl restart "$service"
    wait_for_health && systemctl is-active "$service"
  fi
  exit "$code"
}
trap rollback ERR
ln -s "$release" "$app_root/.current-$$"
mv -Tf "$app_root/.current-$$" "$app_root/current"
switched=1
systemctl restart "$service"
wait_for_health
systemctl is-active --quiet "$service"
# Verify public HTTPS resources against the exact release, and preserve access protection.
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
for(const base of ['http://127.0.0.1:8791','https://comeover.cn']) {
  const get=(path,options={})=>fetch(base+path,{...options,signal:AbortSignal.timeout(15000)});
  assert.deepEqual(await (await get('/health/store')).json(),{success:true,service:'store-management'});
  for(const [asset,file] of [['app.js','public/assets/app.js'],['coupon-code.js','public/assets/coupon-code.js'],['coupon-scanner.js','public/assets/coupon-scanner.js'],['style.css','public/assets/style.css'],['vendor/jsQR.js','node_modules/jsqr/dist/jsQR.js']]) {
    const response=await get('/store/assets/'+asset);
    assert.equal(response.status,200);
    assert.equal(await response.text(),fs.readFileSync(file,'utf8'));
  }
  for(const path of ['/store/api/coupons/batch','/store/api/coupons/redeem-batch']) {
    const denied=await get(path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});
    assert.equal(denied.status,401);
  }
}
console.log('Local and HTTPS health, served resources and access protection verified');
NODE
[[ "$(git -C "$app_root/current" rev-parse HEAD)" = "$expected" ]]
[[ "$(sqlite3 "$state_dir/coupons.db" 'PRAGMA integrity_check;')" = ok ]]
printf 'DEPLOYED_SHA=%s\nROLLBACK_RELEASE=%s\nBACKUP=%s\n' "$expected" "$previous" "$backup_dir/coupons.db"
systemctl show "$service" -p ActiveState -p SubState -p MainPID
