import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createRepository, normalizeCoupon } from "../server/repository.js";
import { allowedStores, requireStore, validateAuthorization } from "../server/policy.js";

const input = { type: "cash_100", code: " CODE-01 ", reason: "客诉赠送", operator: "可修改姓名", issuedAt: "2026-09-09T10:30:00+08:00" };
test("required fields reject whitespace and invalid type/time; code preserves case", () => {
  for (const field of ["code", "reason", "operator", "issuedAt"]) {
    for (const value of [undefined, "", "   "]) assert.throws(() => normalizeCoupon({ ...input, [field]: value }), (e) => e.status === 400 && e.field === field);
  }
  assert.throws(() => normalizeCoupon({ ...input, type: "other" }));
  assert.throws(() => normalizeCoupon({ ...input, issuedAt: "2026-09-09T10:30" }));
  assert.throws(() => normalizeCoupon({ ...input, issuedAt: "2026-02-30T10:30+08:00" }));
  const value = normalizeCoupon(input);
  assert.equal(value.code, "CODE-01");
  assert.equal(new Date(value.issuedAt).toISOString(), "2026-09-09T02:30:00.000Z");
});

test("coupons persist, are unique per store, ordered, paginated and atomically redeemed", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-repo-"));
  let time = 1000;
  let repository = createRepository({ stateDir, now: () => time });
  t.after(() => { repository.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const value = normalizeCoupon(input);
  const item = repository.issue("fuzzy", value, "actual-account");
  assert.equal(item.status, "unredeemed"); assert.equal(item.redeemedAt, null);
  assert.throws(() => repository.issue("fuzzy", value, "other"), (error) => error.status === 409);
  repository.issue("peanut", value, "other");
  repository.issue("fuzzy", { ...value, code: "code-01" }, "other");
  for (let i = 0; i < 51; i++) repository.issue("fuzzy", { ...value, code: `page-${i}`, issuedAt: value.issuedAt + i + 1 }, "other");
  assert.equal(repository.list("fuzzy", 1).total, 53);
  assert.equal(repository.list("fuzzy", 1).items.length, 50);
  assert.equal(repository.list("fuzzy", 1).items[0].code, "page-50");
  assert.equal(repository.list("fuzzy", 2).items.length, 3);
  assert.equal(repository.list("peanut", 1).total, 1);
  time = 2000; const redeemed = repository.redeem(item.id, "fuzzy", "redeemer");
  time = 3000;
  assert.throws(() => repository.redeem(item.id, "fuzzy", "other"), (error) => error.status === 409);
  assert.equal(repository.get(item.id).redeemedAt, redeemed.redeemedAt);
  repository.close(); repository = createRepository({ stateDir });
  assert.equal(repository.get(item.id).operator, input.operator);
  const db = new Database(path.join(stateDir, "coupons.db"), { readonly: true });
  const audit = db.prepare("SELECT * FROM coupons WHERE id = ?").get(item.id); db.close();
  assert.equal(audit.created_by_account_id, "actual-account");
  assert.equal(audit.created_at, 1000); assert.equal(audit.redeemed_by_account_id, "redeemer"); assert.equal(audit.redeemed_at, 2000);
});

test("scope validation fails closed and operation permissions never derive from role", () => {
  const grant = (role, stores, permissions = ["coupon:view"]) => ({ access: { role, permissions, config: { viewScope: { stores, ownership: "any" } } } });
  for (const role of ["admin", "partner"]) {
    const auth = validateAuthorization(grant(role, "all"));
    assert.equal(allowedStores(auth).length, 3); assert.deepEqual(auth.access.permissions, ["coupon:view"]);
    assert.throws(() => validateAuthorization(grant(role, ["fuzzy"])));
  }
  const manager = validateAuthorization(grant("manager", ["peanut"]));
  assert.deepEqual(allowedStores(manager), ["peanut"]);
  assert.throws(() => requireStore(manager, "fuzzy"), (error) => error.status === 403);
  for (const stores of [[], ["invalid"], null]) assert.throws(() => validateAuthorization(grant("manager", stores)));
  assert.throws(() => validateAuthorization(grant("manager", ["fuzzy"], ["coupon:issue"])));
});
