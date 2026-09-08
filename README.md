# 门店管理

统一登录后台 `/store`，第一版包含优惠券列表、发放和手动核销。沿用报账后台浅深主题与导航样式。数据独立保存在 SQLite，不调用外部发券平台。

## 本地启动

使用 Node.js 20.19 以上版本（生产版本应与现有后台一致）：

```sh
npm ci
cp .env.example .env
# 在 .env 中填写本地统一网关地址及其内部令牌
npm start
```

默认监听 `127.0.0.1:8791`。仅支持 unified 模式，必须配置 `ADMIN_AUTH_INTERNAL_TOKEN`。使用本地反向代理将 `/login`、`/logout`、`/auth/` 接到统一网关，`/store` 接到本服务。生产共享入口由 server-infra 唯一管理。

## 权限和业务规则

在现有账号管理新增的“门店管理”区显式启用访问和操作权限，不自动迁移或授予旧账号权限：

- `coupon:view`：查看当前门店全部优惠券；`coupon:issue`：发放；`coupon:redeem`：核销。后两者依赖查看权限。
- 管理员和合伙人的 `viewScope.stores` 固定为 `all`；店长可选择一家或多家。角色不隐含操作权限，也不授予账号管理入口。
- 门店编码为 `fuzzy`、`fuzzy_qz`、`peanut`。配置 `viewScope.ownership` 为 `any`，只看顶部所选门店，不提供跨店汇总。
- 类型为 `cash_100`（100元代金券）、`free_drink`（赠饮券）。券码去除首尾空白，保留大小写，各门店内唯一。
- 类型、券码、赠送原因、操作人、发放时间均必填。发放时间在界面按上海时区输入，接口必须含显式时区。
- 新券为未核销；核销时间由服务器记录，不支持修改、删除或撤销。操作人可编辑，实际创建及核销账号独立留痕。
- 权限变更后旧的该后台会话失效，重新登录生效；不影响其他应用权限版本。

## 接口

所有业务接口使用统一网关 Cookie。写请求使用 JSON 和同源 `Origin`，不接受客户端身份头作为授权。

| 接口 | 输入 / 输出 |
| --- | --- |
| `GET /store/api/session` | 账号显示名、stores、permissions、features、types |
| `GET /store/api/coupons?store=fuzzy&page=1` | items、total、page、pageSize（固定 50） |
| `POST /store/api/coupons` | store、type、code、reason、operator、issuedAt；返回 item，201 |
| `POST /store/api/coupons/:id/redeem` | store；返回 item，200 |
| `GET /health/store` | 不含业务数据的健康检查 |

错误使用 `{ success: false, error: { message, field? } }`。参数错误为 400，登录/授权会话失效为 401，操作或门店越权为 403，当前门店找不到券为 404，重复券码或已核销为 409，网关不可用为 503。

## 验证

```sh
npm test
# 以下联调要求相邻目录有 admin-auth-gateway 及其已安装依赖
npm run test:integration
# Playwright 可由现有工具环境提供；指定其入口文件和本地浏览器
STORE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
STORE_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:browser
```

联调和浏览器检查均使用临时数据库、临时账号和动态回环端口，结束后清理。截图及尺寸记录位于 `outputs/browser-check/`（Git 忽略），其中数据为测试数据。

## 发布与回滚

生产发布步骤及顺序：

1. 备份网关账号数据库（使用 SQLite 在线备份或停服备份完整数据库），记录网关和各业务当前 SHA。新网关启动时事务重建 `account_access` 的应用 CHECK 约束，保留已有账号、权限、版本和审计，不添加任何 store 授权。
2. 部署新网关并验证原后台登录、账号管理及 `/internal/authorization/store`；新授权必须由现有账号管理明确配置。
3. 安装门店服务到 `/opt/store-management/releases/<git-sha>`，在该目录运行 `npm ci --omit=dev`；创建独立 `store-management` 系统用户，配置 `/etc/store-management.env`（root 所有、0600），填写内部令牌和网关地址。
4. 使用 `ss -ltnp` 确认 8791 未被其他服务占用，核对 Node 路径。安装 `deploy/store-management.service`，将 `/opt/store-management/current` 链接到目标 release，仅启动/重启此服务。数据由 systemd 保存在 `/var/lib/store-management`。本项目不修改或 reload Nginx。
5. 验证回环健康接口和目标 release SHA 后，通过 server-infra 发布 `/store` 路由。其流程会先验证候选 Nginx，再切换、reload、冒烟，失败回滚；随后发布其他后台的导航入口。
6. 验证登录返回 `/store`、实际授权账号的门店和操作范围；核对已部署 SHA。

回滚先移除或恢复共享入口及导航，再恢复服务的 `current` 链接和网关代码；不要删除新券数据库。账号库扩大后的 CHECK 对旧代码兼容，可保留新增 store 授权数据；仅在确认迁移失败且无后续有效写入时使用备份恢复，避免覆盖新的账号变更。业务数据库在 release 目录之外，回退代码不丢失已发放和核销记录。
