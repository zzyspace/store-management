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
