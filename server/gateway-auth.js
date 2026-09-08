// Keep this backend protocol aligned with the other admin applications.
export function gatewayAuthConfig(env = process.env) {
  const mode = env.ADMIN_AUTH_MODE ?? "legacy";
  if (!["legacy", "unified"].includes(mode)) throw new Error("Invalid ADMIN_AUTH_MODE.");
  const url = env.ADMIN_AUTH_GATEWAY_URL ?? "http://127.0.0.1:8790";
  const token = env.ADMIN_AUTH_INTERNAL_TOKEN ?? "";
  if (mode === "unified") {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid internal gateway configuration.");
  }
  return { mode, url, token };
}

export function createGatewayAuth({ app, config, validate }) {
  return async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    try {
      const reply = await fetch(`${config.url.replace(/\/$/, "")}/internal/authorization/${app}`, {
        redirect: "error", signal: AbortSignal.timeout(2000),
        headers: {
          Authorization: `Bearer ${config.token}`, Cookie: request.get("Cookie") ?? "",
          "X-Original-Method": request.method, "X-Original-Host": request.get("Host") ?? "",
          "X-Original-Proto": request.protocol, "X-Original-Origin": request.get("Origin") ?? "",
        },
      });
      if (!reply.ok) {
        await reply.body?.cancel();
        const status = [401, 403].includes(reply.status) ? reply.status : 503;
        if (status === 401 && request.method === "GET" && /^\/store\/?$/.test(request.originalUrl)) {
          response.redirect(303, "/login?returnTo=/store"); return;
        }
        response.status(status).json({ success: false, error: { message: status === 503 ? "登录服务暂不可用。" : "登录已失效或无权访问。" } });
        return;
      }
      const data = await reply.json();
      if (!data.success || data.account?.enabled !== true || data.access?.enabled !== true || data.access.app !== app ||
          typeof data.account.accountId !== "string" || !data.account.accountId ||
          data.account.accountId !== data.access.accountId || typeof data.account.username !== "string" || !data.account.username ||
          !Number.isSafeInteger(data.account.version) || data.account.version < 1 || !Number.isSafeInteger(data.access.version) || data.access.version < 1) throw new Error("Invalid authorization.");
      response.locals.gatewayAuthorization = validate(data);
      request.adminUsername = data.account.username;
      next();
    } catch {
      // Never log service secrets, cookies, or authorization response contents.
      response.status(503).json({ success: false, error: { message: "登录服务或权限配置暂不可用。" } });
    }
  };
}
