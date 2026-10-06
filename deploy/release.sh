# Release hooks for comeover/scripts/deploy-release.sh (sourced as root on the server).
# Code rolls back by switching current; coupon data only through the backup taken here,
# because startup may migrate the schema (including a table rebuild).
SERVICES=(store-management.service)
UNIT_FILES=(deploy/store-management.service)
HEALTH_URL=http://127.0.0.1:8791/health/store
REQUIRED_PATHS=(/etc/store-management.env /var/lib/store-management/coupons.db)

release_prepare() {
  id store-management >/dev/null
  install_node_modules
  npm ls --omit=dev --depth=0 >/dev/null
  [[ -r node_modules/jsqr/dist/jsQR.js ]]
  # The top bar comes from admin-auth-gateway; deploy the gateway first.
  for asset in admin-shell.css admin-shell.js admin-theme.js; do
    expect_status "https://comeover.cn/auth/accounts/$asset" 200
  done
}

release_test() {
  run_isolated node --test tests/*.test.js
  runuser -u store-management -- test -r node_modules/jsqr/dist/jsQR.js
}

release_backup() {
  backup_sqlite /var/lib/store-management/coupons.db
  # Run this release's schema upgrade on a private copy of the backup first.
  BACKUP_FILE="$1/coupons.db" node --input-type=module <<'NODE'
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
}

release_verify() {
  # Public HTTPS resources must match this exact release, and writes stay protected.
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
  [[ "$(sqlite3 /var/lib/store-management/coupons.db 'PRAGMA integrity_check;')" = ok ]]
}
