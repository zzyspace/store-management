import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { parseCouponCode } from "../public/assets/coupon-code.js";
import { createRepository, normalizeBatch } from "../server/repository.js";

const batch = (codes, extra = {}) => normalizeBatch({ requestId: randomUUID(), codes, reason: "赠送", operator: "操作人", issuedAt: "2026-09-14T12:30+08:00", ...extra });
function setup(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-batch-"));
  const repository = createRepository({ stateDir });
  t.after(() => { repository.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, repository };
}

test("shared parser recognizes all stores and types, preserving numeric suffix and case", () => {
  for (const [prefix, store] of [["FUZZY", "fuzzy"], ["FUZZYQZ", "fuzzy_qz"], ["PEANUT", "peanut"]]) {
    for (const [typeCode, type] of [["ZY", "free_drink"], ["100", "cash_100"]]) {
      const code = `${prefix}-${typeCode}-0002026101`;
      assert.deepEqual(parseCouponCode(` ${code} `, store), { code, store, type, number: "0002026101" });
    }
  }
  for (const value of [null, {}, 123, "", "fuzzy-ZY-1", "FUZZY-zy-1", "FUZZY-ZY-abc", "FUZZY-ZY-1-2", "FUZZY-ZY-", "FUZZY-ZY-１", "<script>", "https://test/FUZZY-ZY-1", `FUZZY-ZY-${"1".repeat(200)}`]) assert.throws(() => parseCouponCode(value));
  assert.throws(() => parseCouponCode("UNKNOWN-ZY-1"), /门店代码/);
  assert.throws(() => parseCouponCode("FUZZY-200-1"), /券类型/);
  assert.throws(() => parseCouponCode("FUZZYQZ-ZY-2026101", "fuzzy"), /门店.*不符/);
});

test("batch common fields and limits reject invalid input before writes", () => {
  for (const codes of [undefined, [], "FUZZY-ZY-1", Array(51).fill("FUZZY-ZY-1")]) assert.throws(() => batch(codes), (e) => e.field === "codes");
  for (const field of ["reason", "operator", "issuedAt", "requestId"]) {
    for (const value of [undefined, "", "   "]) assert.throws(() => batch(["FUZZY-ZY-1"], { [field]: value }), (e) => e.field === field);
  }
  for (const issuedAt of ["2026-02-30T12:00+08:00", "2026-09-14T12:00"]) assert.throws(() => batch(["FUZZY-ZY-1"], { issuedAt }));
  // Worst-case valid front-end payload stays below both service and proxy limits.
  const body = { store: "fuzzy", requestId: randomUUID(), codes: Array.from({ length: 50 }, (_, i) => `FUZZY-ZY-${String(i).padStart(191, "0")}`), reason: "中".repeat(1000), operator: "中".repeat(200), issuedAt: "2026-09-14T12:00+08:00" };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 16 * 1024);
});

test("partial batches persist valid coupons with audit and replay durably without duplicate writes", (t) => {
  const { stateDir, repository } = setup(t);
  repository.issueBatch("fuzzy", batch(["FUZZY-ZY-001"]), "account");
  const input = batch(["FUZZY-100-002", "FUZZY-ZY-003", "FUZZY-ZY-001", " FUZZY-ZY-003 ", "FUZZYQZ-ZY-1", "FUZZY-X-1", null]);
  const result = repository.issueBatch("fuzzy", input, "account");
  assert.equal(result.issuedCount, 2); assert.equal(result.failedCount, 5);
  assert.deepEqual(result.results.map((r) => r.success), [true, true, false, false, false, false, false]);
  assert.match(result.results[2].error.message, /已存在/);
  assert.match(result.results[3].error.message, /批次中.*重复/);
  assert.equal(repository.list("fuzzy", 1).total, 3);
  const reopened = createRepository({ stateDir });
  try { assert.deepEqual(reopened.issueBatch("fuzzy", input, "account"), result); }
  finally { reopened.close(); }
  assert.throws(() => repository.issueBatch("fuzzy", { ...input, reason: "不同原因" }, "account"), (e) => e.status === 409 && e.field === "requestId");
  assert.throws(() => repository.issueBatch("peanut", input, "account"), (e) => e.status === 409);
  const anotherAccount = repository.issueBatch("fuzzy", input, "another-account");
  assert.equal(anotherAccount.issuedCount, 0);
  const db = new Database(path.join(stateDir, "coupons.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM coupons WHERE code = 'FUZZY-100-002'").get();
    assert.equal(row.created_by_account_id, "account"); assert.equal(row.operator, "操作人");
    assert.equal(row.issued_at, Date.parse("2026-09-14T12:30+08:00"));
    assert.equal(row.redeemed_at, null);
  } finally { db.close(); }
});

test("unexpected database failures roll back every coupon and batch record", (t) => {
  const { stateDir, repository } = setup(t);
  const db = new Database(path.join(stateDir, "coupons.db"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON coupon_issue_batches BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
  const input = batch(["FUZZY-100-1", "FUZZY-ZY-2"]);
  assert.throws(() => repository.issueBatch("fuzzy", input, "account"), /simulated disk failure/);
  assert.equal(repository.list("fuzzy", 1).total, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM coupon_issue_batches").get().n, 0);
  db.exec("DROP TRIGGER fail_batch");
  assert.equal(repository.issueBatch("fuzzy", input, "account").issuedCount, 2);
});
