import express from "express";
import path from "node:path";
import { createGatewayAuth, gatewayAuthConfig } from "./gateway-auth.js";
import { allowedStores, OperationError, requirePermission, requireStore, STORES, TYPES, validateAuthorization } from "./policy.js";
import { normalizeCoupon } from "./repository.js";

export function createApp({ repository, env = process.env }) {
  const config = gatewayAuthConfig({ ...env, ADMIN_AUTH_MODE: env.ADMIN_AUTH_MODE ?? "unified" });
  if (config.mode !== "unified") throw new Error("Store management requires unified authentication.");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.get("/health/store", (_request, response) => response.json({ success: true, service: "store-management" }));
  app.use("/store", (_request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "same-origin");
    response.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  // Static assets contain no account or coupon data and must load on an expired session.
  app.use("/store/assets", express.static(path.resolve(import.meta.dirname, "../public/assets"), { dotfiles: "deny", index: false }));
  app.use("/store", createGatewayAuth({ app: "store", config, validate: validateAuthorization }));
  app.use("/store/api", express.json({ limit: "16kb" }));
  app.use("/store/api", (request, _response, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !request.is("application/json")) return next(new OperationError(415, "请求必须使用 JSON 格式。"));
    next();
  });
  app.get(["/store", "/store/"], (_request, response) => response.sendFile(path.resolve(import.meta.dirname, "../public/index.html")));
  app.get("/store/api/session", (_request, response) => {
    const auth = response.locals.gatewayAuthorization;
    response.json({ success: true, account: { displayName: auth.account.displayName || auth.account.username },
      stores: allowedStores(auth).map((id) => ({ id, label: STORES[id] })), permissions: auth.access.permissions,
      features: [{ id: "coupons", label: "优惠券管理" }], types: TYPES });
  });
  app.get("/store/api/coupons", (request, response) => {
    const auth = response.locals.gatewayAuthorization;
    requirePermission(auth, "coupon:view");
    const store = requireStore(auth, request.query.store);
    const page = Number(request.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new OperationError(400, "页码无效。");
    response.json({ success: true, ...repository.list(store, page) });
  });
  app.post("/store/api/coupons", (request, response) => {
    const auth = response.locals.gatewayAuthorization;
    requirePermission(auth, "coupon:issue");
    const store = requireStore(auth, request.body?.store);
    const input = normalizeCoupon(request.body);
    response.status(201).json({ success: true, item: repository.issue(store, input, auth.account.accountId) });
  });
  app.post("/store/api/coupons/:id/redeem", (request, response) => {
    const auth = response.locals.gatewayAuthorization;
    requirePermission(auth, "coupon:redeem");
    const store = requireStore(auth, request.body?.store);
    const id = Number(request.params.id);
    const item = Number.isSafeInteger(id) && id > 0 ? repository.get(id) : null;
    if (!item || item.store !== store) throw new OperationError(404, "未找到该门店的优惠券。");
    response.json({ success: true, item: repository.redeem(id, store, auth.account.accountId) });
  });
  app.use((_request, response) => response.status(404).json({ success: false, error: { message: "页面或接口不存在。" } }));
  app.use((error, _request, response, _next) => {
    const status = error instanceof OperationError ? error.status : error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    response.status(status).json({ success: false, error: { message: error instanceof OperationError ? error.message : status === 500 ? "保存或查询失败，请稍后重试。" : "请求内容无效或过大。", ...(error.field ? { field: error.field } : {}) } });
  });
  return app;
}
