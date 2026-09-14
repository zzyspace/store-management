import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createRepository, normalizeRedeemBatch } from '../server/repository.js';
const currentTime = Date.parse('2026-09-14T12:00+08:00');
const batch = (codes, extra = {}) => normalizeRedeemBatch({ requestId: randomUUID(), codes, operator: '核销操作人', redeemedAt: '2026-09-14T11:00+08:00', ...extra });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeem-batch-'));
  const repository = createRepository({ stateDir: dir, now: () => currentTime });
  t.after(() => { repository.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, repository, issue(code, issuedAt = '2026-09-14T10:00+08:00', store = 'fuzzy') {
    return repository.issue(store, { code, type: code.includes('-100-') ? 'cash_100' : 'free_drink', reason: '赠送原因', operator: '激活操作人', issuedAt: Date.parse(issuedAt) }, 'issuer-account');
  } };
}

test('redemption requires a bounded batch, operator and strict offset-bearing time', () => {
  for (const codes of [null, [], 'FUZZY-ZY-1', Array(51).fill('FUZZY-ZY-1')]) assert.throws(() => batch(codes), e => e.field === 'codes');
  for (const value of [null, '', ' ', 'x'.repeat(201)]) assert.throws(() => batch(['FUZZY-ZY-1'], { operator: value }), e => e.field === 'operator');
  for (const value of [null, '', '2026-09-14T11:00', '2026-02-30T11:00+08:00', 'not-a-time']) assert.throws(() => batch(['FUZZY-ZY-1'], { redeemedAt: value }), e => e.field === 'redeemedAt');
  assert.equal(batch(['FUZZY-ZY-1']).redeemedAt, Date.parse('2026-09-14T03:00:00Z'));
});

test('partial redemption reports every business failure while preserving issue and redemption audit fields', (t) => {
  const { dir, repository, issue } = setup(t);
  const first = issue('FUZZY-ZY-0001'), second = issue('FUZZY-100-0002'), old = issue('FUZZY-ZY-0003'), later = issue('FUZZY-ZY-0004', '2026-09-14T11:30+08:00');
  repository.redeem(old.id, 'fuzzy', 'previous-account', '原核销人');
  const oldState = repository.get(old.id);
  const input = batch([first.code, second.code, old.code, later.code, 'FUZZY-ZY-9999', 'PEANUT-ZY-1', 'bad-code', ' FUZZY-ZY-0001 ']);
  const result = repository.redeemBatch('fuzzy', input, 'redeemer-account');
  assert.equal(result.redeemedCount, 2); assert.equal(result.failedCount, 6);
  for (const [index, pattern] of [[2, /已核销/], [3, /早于/], [4, /未激活/], [5, /门店.*不符/], [6, /格式/], [7, /重复/]]) assert.match(result.results[index].error.message, pattern);
  assert.deepEqual(repository.get(old.id), oldState);
  assert.equal(repository.get(later.id).status, 'unredeemed');
  const value = repository.get(first.id);
  assert.equal(value.operator, '激活操作人'); assert.equal(value.redeemedOperator, '核销操作人');
  assert.equal(value.issuedAt, first.issuedAt); assert.equal(value.redeemedAt, new Date(input.redeemedAt).toISOString());
  const db = new Database(path.join(dir, 'coupons.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM coupons WHERE id=?').get(first.id);
    assert.equal(row.created_by_account_id, 'issuer-account'); assert.equal(row.redeemed_by_account_id, 'redeemer-account');
  } finally { db.close(); }
  assert.deepEqual(repository.redeemBatch('fuzzy', input, 'redeemer-account'), result);
  assert.throws(() => repository.redeemBatch('fuzzy', { ...input, operator: '改名' }, 'redeemer-account'), e => e.status === 409 && e.field === 'requestId');
  const reopened = createRepository({ stateDir: dir, now: () => currentTime });
  try { assert.deepEqual(reopened.redeemBatch('fuzzy', input, 'redeemer-account'), result); } finally { reopened.close(); }
  const allFailed = repository.redeemBatch('fuzzy', batch([first.code, second.code]), 'another-account');
  assert.equal(allFailed.redeemedCount, 0); assert.equal(allFailed.failedCount, 2);
});

test('future time rejects the whole batch; exact issuance and current-time boundaries are accepted', (t) => {
  const { repository, issue } = setup(t);
  const first = issue('FUZZY-ZY-1');
  assert.throws(() => repository.redeemBatch('fuzzy', batch([first.code], { redeemedAt: '2026-09-14T12:00:00.001+08:00' }), 'account'), e => e.status === 400 && e.field === 'redeemedAt');
  assert.equal(repository.get(first.id).status, 'unredeemed');
  assert.equal(repository.redeemBatch('fuzzy', batch([first.code], { redeemedAt: first.issuedAt }), 'account').redeemedCount, 1);
  const second = issue('FUZZY-ZY-2');
  assert.equal(repository.redeemBatch('fuzzy', batch([second.code], { redeemedAt: new Date(currentTime).toISOString() }), 'account').redeemedCount, 1);
  const future = issue('FUZZY-ZY-3', '2026-09-15T10:00+08:00');
  assert.throws(() => repository.redeem(future.id, 'fuzzy', 'account', '姓名'), /早于/);
});

test('a batch of 50 succeeds and a database failure rolls back coupons and replay record together', (t) => {
  const { dir, repository, issue } = setup(t);
  const codes = Array.from({ length: 50 }, (_, i) => issue(`FUZZY-ZY-${i}`).code);
  const db = new Database(path.join(dir, 'coupons.db'));
  try {
    db.exec("CREATE TRIGGER reject_redemption_batch BEFORE INSERT ON coupon_redeem_batches BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    const input = batch(codes);
    assert.throws(() => repository.redeemBatch('fuzzy', input, 'account'), /simulated storage failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM coupons WHERE redeemed_at IS NOT NULL').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM coupon_redeem_batches').get().n, 0);
    db.exec('DROP TRIGGER reject_redemption_batch');
    assert.equal(repository.redeemBatch('fuzzy', input, 'account').redeemedCount, 50);
  } finally { db.close(); }
});

test('additive migration preserves historical records and never invents a redemption operator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redeem-migration-'));
  let repo;
  try {
    repo = createRepository({ stateDir: dir, now: () => currentTime });
    const item = repo.issue('fuzzy', { type: 'free_drink', code: 'LEGACY-ANY-CODE', reason: '历史原因', operator: '历史激活人', issuedAt: currentTime - 60000 }, 'old-account');
    repo.redeem(item.id, 'fuzzy', 'old-redeemer', '待删除模拟字段'); repo.close();
    const db = new Database(path.join(dir, 'coupons.db'));
    db.exec('ALTER TABLE coupons DROP COLUMN redeemed_operator; DROP TABLE coupon_redeem_batches;');
    const before = db.prepare('SELECT * FROM coupons').all(); db.close();
    repo = createRepository({ stateDir: dir });
    assert.equal(repo.get(item.id).redeemedOperator, null); assert.equal(repo.get(item.id).operator, '历史激活人');
    repo.close(); repo = createRepository({ stateDir: dir });
    const migrated = new Database(path.join(dir, 'coupons.db'), { readonly: true });
    try {
      assert.deepEqual(migrated.prepare('SELECT * FROM coupons').all().map(({ redeemed_operator, ...row }) => row), before);
      assert.equal(migrated.pragma('table_info(coupons)').filter(c => c.name === 'redeemed_operator').length, 1);
      assert.equal(migrated.pragma('integrity_check', { simple: true }), 'ok');
    } finally { migrated.close(); }
  } finally { if (repo) { try { repo.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); }
});
