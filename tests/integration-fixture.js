// This optional integration fixture uses sibling projects and temporary data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAccountStore } from "../../admin-auth-gateway/server/account-store.js";
import { createSessionDatabase } from "../../admin-auth-gateway/server/database.js";
import { loadConfig } from "../../admin-auth-gateway/server/config.js";
import { createApp as createGateway } from "../../admin-auth-gateway/server/app.js";
import { createRepository } from "../server/repository.js";
import { createApp } from "../server/app.js";

export async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-integration-")), servers = [];
  const accounts = createAccountStore({ stateDir }), database = createSessionDatabase({ stateDir });
  const config = loadConfig({ ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: "store-test-internal-secret-00000000000001", ADMIN_AUTH_COOKIE_SECURE: "false", ADMIN_AUTH_COOKIE_NAME: "admin_session", ADMIN_AUTH_MANAGEMENT_ACCOUNT_IDS: "owner" });
  const { app: gateway, sessions } = createGateway({ config, accounts, database });
  async function serve(app) {
    const server = await new Promise((resolve, reject) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); server.on("error", reject); });
    servers.push(server); return `http://127.0.0.1:${server.address().port}`;
  }
  const gatewayUrl = await serve(gateway);
  const env = { ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: config.internalToken, ADMIN_AUTH_GATEWAY_URL: gatewayUrl };
  const repository = createRepository({ stateDir });
  const storeUrl = await serve(createApp({ repository, env }));
  const proxy = http.createServer((request, response) => {
    const target = request.url.startsWith("/store") || request.url.startsWith("/health/store") ? storeUrl : gatewayUrl;
    const upstream = http.request(target + request.url, { method: request.method, headers: { ...request.headers, "x-forwarded-proto": "http" } }, (reply) => {
      if (reply.statusCode === 401 && /^\/store\/?$/.test(request.url)) {
        reply.resume(); response.writeHead(303, { Location: "/login?returnTo=/store" }).end();
      } else { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); }
    });
    upstream.on("error", () => response.writeHead(502).end()); request.pipe(upstream);
  });
  const base = await serve(proxy);
  function grant(id, role, stores, permissions = ["coupon:view", "coupon:issue", "coupon:redeem"]) {
    if (!accounts.getAccount(id)) accounts.createAccount({ accountId: id, username: id, displayName: `测试${id}`, password: "local-fixture-password" }, { actor: "fixture" });
    const previous = accounts.getAccess(id, "store");
    accounts.putAccess({ accountId: id, app: "store", role, permissions, config: { viewScope: { ownership: "any", stores } } }, { actor: "fixture", expectedVersion: previous?.version ?? 0 });
    return `admin_session=${sessions.login(id, "local-fixture-password").token}`;
  }
  const cookies = {
    admin: grant("admin", "admin", "all"), partner: grant("partner", "partner", "all", ["coupon:view"]),
    manager: grant("manager", "manager", ["fuzzy"]), issuer: grant("issuer", "manager", ["fuzzy"], ["coupon:view", "coupon:issue"]),
    multi: grant("multi", "manager", ["fuzzy", "peanut"]),
  };
  accounts.createAccount({ accountId: "owner", username: "owner", displayName: "账号管理员", password: "local-fixture-password" }, { actor: "fixture" });
  cookies.owner = `admin_session=${sessions.login("owner", "local-fixture-password").token}`;
  async function request(route, cookie, options = {}) {
    return fetch(base + route, { redirect: "manual", ...options,
      headers: { Cookie: cookie ?? "", Origin: base, "Content-Type": "application/json", ...options.headers } });
  }
  return { base, storeUrl, gatewayUrl, repository, accounts, sessions, cookies, request, grant, stateDir,
    async close() { for (const server of servers.reverse()) await new Promise((resolve) => server.close(resolve)); repository.close(); database.close(); accounts.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}
