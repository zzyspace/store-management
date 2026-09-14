import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./integration-fixture.js";
import { createApp } from "../server/app.js";

test("real gateway enforces store identity, permissions, origin, scopes, versions and coupon lifecycle", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const data = { store: "fuzzy", type: "cash_100", code: "INT-01", reason: "赠送原因", operator: "手工填写", issuedAt: "2026-09-09T11:00+08:00", createdByAccountId: "forged" };
  const post = (route, cookie, body, headers) => f.request(route, cookie, { method: "POST", body: JSON.stringify(body), headers });
  assert.equal((await f.request("/store/api/session")).status, 401);
  assert.equal((await f.request("/store/api/session", "", { headers: { "X-Admin-Account-Id": "admin", "X-Admin-Role": "admin" } })).status, 401);
  for (const role of ["admin", "partner"]) assert.equal((await (await f.request("/store/api/session", f.cookies[role])).json()).stores.length, 3);
  assert.equal((await (await f.request("/store/api/session", f.cookies.manager)).json()).account.displayName, "测试manager");
  assert.equal((await f.request("/store/api/coupons?store=peanut", f.cookies.manager)).status, 403);
  assert.equal((await post("/store/api/coupons", f.cookies.manager, { ...data, store: "peanut" })).status, 403);
  assert.equal((await post("/store/api/coupons", f.cookies.partner, data)).status, 403);
  for (const reason of [undefined, "", "  "]) assert.equal((await post("/store/api/coupons", f.cookies.admin, { ...data, reason })).status, 400);
  assert.equal((await post("/store/api/coupons", f.cookies.admin, data, { Origin: "https://evil.test", "X-Original-Method": "GET" })).status, 403);
  const results = await Promise.all([post("/store/api/coupons", f.cookies.manager, data), post("/store/api/coupons", f.cookies.manager, data)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const item = (await results.find((r) => r.status === 201).json()).item;
  assert.equal(item.operator, "手工填写"); assert.equal(item.status, "unredeemed");
  assert.equal((await post("/store/api/coupons", f.cookies.admin, { ...data, store: "peanut" })).status, 201);
  assert.equal((await (await f.request("/store/api/coupons?store=fuzzy", f.cookies.issuer)).json()).items.length, 1);
  assert.equal((await post(`/store/api/coupons/${item.id}/redeem`, f.cookies.partner, { store: "fuzzy" })).status, 403);
  assert.equal((await post(`/store/api/coupons/${item.id}/redeem`, f.cookies.issuer, { store: "fuzzy" })).status, 403);
  assert.equal((await post(`/store/api/coupons/${item.id}/redeem`, f.cookies.admin, { store: "peanut" })).status, 404);
  const redeemed = await Promise.all([post(`/store/api/coupons/${item.id}/redeem`, f.cookies.manager, { store: "fuzzy" }), post(`/store/api/coupons/${item.id}/redeem`, f.cookies.manager, { store: "fuzzy" })]);
  assert.deepEqual(redeemed.map((r) => r.status).sort(), [200, 409]);
  const session = await (await f.request("/auth/api/session", f.cookies.admin)).json();
  assert.equal(session.destinations.store, "/store");
  const login = await f.request("/login?returnTo=/store", "");
  assert.match(await login.text(), /门店管理/);
  assert.equal((await f.request("/login?returnTo=/store", f.cookies.admin)).headers.get("location"), "/store");
  f.grant("manager", "manager", ["peanut"], ["coupon:view"]);
  assert.equal((await f.request("/store/api/session", f.cookies.manager)).status, 401);
  const admin = f.accounts.getAccount("admin"); f.accounts.updateAccount("admin", { enabled: false }, { actor: "fixture", expectedVersion: admin.version });
  assert.equal((await f.request("/store/api/session", f.cookies.admin)).status, 401);
  // A stopped/unreachable gateway must not fall back to anonymous or role-based access.
  const app = createApp({ repository: f.repository, env: { ADMIN_AUTH_GATEWAY_URL: "http://127.0.0.1:1", ADMIN_AUTH_INTERNAL_TOKEN: "unreachable-fixture-secret-00000001" } });
  const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/store/api/session`)).status, 503); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});

test("batch endpoint authorizes first, supports partial results and concurrent request replay", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const f = await fixture(); t.after(() => f.close());
  const data = { requestId: randomUUID(), store: "fuzzy", codes: ["FUZZY-100-001", "FUZZY-ZY-002", "PEANUT-ZY-003", "bad-code"], reason: "整批赠送", operator: "手工操作人", issuedAt: "2026-09-14T12:00+08:00" };
  const post = (cookie, body = data, headers) => f.request("/store/api/coupons/batch", cookie, { method: "POST", body: JSON.stringify(body), headers });
  assert.equal((await post("")).status, 401);
  assert.equal((await post(f.cookies.partner)).status, 403);
  assert.equal((await post(f.cookies.manager, { ...data, store: "peanut" })).status, 403);
  assert.equal((await post(f.cookies.manager, data, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await post(f.cookies.manager, { ...data, reason: " " })).status, 400);
  assert.equal(f.repository.list("fuzzy", 1).total, 0);
  const replies = await Promise.all([post(f.cookies.manager), post(f.cookies.manager)]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200]);
  const [first, replay] = await Promise.all(replies.map((r) => r.json()));
  assert.deepEqual(first, replay); assert.equal(first.issuedCount, 2); assert.equal(first.failedCount, 2);
  assert.equal(first.results[0].item.type, "cash_100"); assert.equal(first.results[1].item.type, "free_drink");
  assert.equal(f.repository.list("fuzzy", 1).total, 2);
  assert.equal((await post(f.cookies.manager, { ...data, codes: ["FUZZY-ZY-9"] })).status, 409);
  const duplicate = await (await post(f.cookies.manager, { ...data, requestId: randomUUID() })).json();
  assert.equal(duplicate.issuedCount, 0); assert.equal(duplicate.failedCount, 4);
  assert.equal((await post(f.cookies.manager, { ...data, requestId: randomUUID(), codes: Array(51).fill("FUZZY-ZY-9") })).status, 400);
  // Replays still require current store authorization.
  f.grant("manager", "manager", ["peanut"], ["coupon:view"]);
  assert.equal((await post(f.cookies.manager)).status, 401);
  for (const asset of ["coupon-code.js", "coupon-scanner.js", "vendor/jsQR.js"]) {
    const reply = await f.request(`/store/assets/${asset}`);
    assert.equal(reply.status, 200); assert.match(reply.headers.get("content-type"), /javascript/);
  }
});

test("batch redemption enforces permissions, time, concurrency, replay and independent operators", async (t) => {
  const { randomUUID } = await import("node:crypto");
  const f = await fixture(); t.after(() => f.close());
  const earlier = Date.now() - 120000;
  const issue = (code, issuedAt = earlier) => f.repository.issue("fuzzy", { type: "free_drink", code, reason: "赠送", operator: "激活姓名", issuedAt }, "fixture");
  const first = issue("FUZZY-ZY-2001"), second = issue("FUZZY-ZY-2002"), third = issue("FUZZY-ZY-2003");
  const data = { requestId: randomUUID(), store: "fuzzy", codes: [first.code, "FUZZY-ZY-9999"], operator: "核销姓名", redeemedAt: new Date(Date.now() - 60000).toISOString() };
  const post = (cookie, body = data, headers) => f.request("/store/api/coupons/redeem-batch", cookie, { method: "POST", body: JSON.stringify(body), headers });
  assert.equal((await post("")).status, 401);
  assert.equal((await post(f.cookies.issuer)).status, 403);
  assert.equal((await post(f.cookies.partner)).status, 403);
  assert.equal((await post(f.cookies.manager, { ...data, store: "peanut" })).status, 403);
  assert.equal((await post(f.cookies.admin, data, { Origin: "https://evil.test" })).status, 403);
  for (const body of [{ ...data, operator: " " }, { ...data, redeemedAt: new Date(Date.now() + 60000).toISOString() }]) assert.equal((await post(f.cookies.admin, body)).status, 400);
  assert.equal(f.repository.get(first.id).status, "unredeemed");
  const [a, b] = await Promise.all([post(f.cookies.admin), post(f.cookies.admin)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const result = await a.json(); assert.deepEqual(await b.json(), result);
  assert.equal(result.redeemedCount, 1); assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].item.operator, "激活姓名"); assert.equal(result.results[0].item.redeemedOperator, "核销姓名");
  assert.equal((await post(f.cookies.admin, { ...data, operator: "修改姓名" })).status, 409);
  const competing = await Promise.all([post(f.cookies.manager, { ...data, requestId: randomUUID(), codes: [second.code] }), post(f.cookies.admin, { ...data, requestId: randomUUID(), codes: [second.code] })]);
  assert.deepEqual((await Promise.all(competing.map(r => r.json()))).map(r => r.redeemedCount).sort(), [0, 1]);
  const redeemerOnly = f.grant("redeemer", "manager", ["fuzzy"], ["coupon:view", "coupon:redeem"]);
  assert.equal((await (await post(redeemerOnly, { ...data, requestId: randomUUID(), codes: [third.code] })).json()).redeemedCount, 1);
  const legacy = issue("legacy-coupon-code");
  const single = await f.request(`/store/api/coupons/${legacy.id}/redeem`, f.cookies.manager, { method: "POST", body: JSON.stringify({ store: "fuzzy" }) });
  assert.equal(single.status, 200); assert.equal((await single.json()).item.redeemedOperator, "测试manager");
  const future = issue("FUZZY-ZY-2999", Date.now() + 3600000);
  assert.equal((await f.request(`/store/api/coupons/${future.id}/redeem`, f.cookies.manager, { method: "POST", body: JSON.stringify({ store: "fuzzy" }) })).status, 409);
  f.grant("admin", "admin", "all", ["coupon:view"]);
  assert.equal((await post(f.cookies.admin)).status, 401);
});
