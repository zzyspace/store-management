# 门店管理

统一登录后台 `/store`，包含优惠券列表、连续扫码批量发放和手动核销。沿用报账后台浅深主题与导航样式。数据独立保存在 SQLite，不调用外部发券平台。

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
- 批量发放的券码格式为 `门店代码-券类型-数字编号`：`FUZZY` / `FUZZYQZ` / `PEANUT` 对应上述三家门店，`ZY` 为赠饮券，`100` 为100元代金券。例如 `FUZZYQZ-ZY-2026101`。必须大写，编号不限定长度且保留前导零，完整券码最多200字符；跨店券码拒绝加入。
- 类型由券码自动识别；券码通过扫码加入，每张确认后才进入清单，可移除、不可编辑。每批1至50张，整批共用赠送原因、操作人及发放时间。发放时间在界面按上海时区输入，接口必须含显式时区。
- 扫码页优先启动后置相机，确认框仅暂停识别，实时视频持续播放；结束扫码或离开页面释放相机。页面转入后台时释放相机，返回后手动重试并保留已确认券码。浏览器需要 HTTPS（本机 localhost/回环地址亦可）及相机权限。jsQR 1.4.0 从本服务提供，画面在浏览器中解码、不上传。
- 已发放或同批重复券逐张返回失败，其余有效券正常保存。部分成功后只保留失败券及原因供移除或重试；网络结果不明时锁定内容并使用原批次重试。刷新页面或取消发放丢弃当前草稿。
- 新券为未核销；核销时间由服务器记录，不支持修改、删除或撤销。操作人可编辑，实际创建及核销账号独立留痕。
- 权限变更后旧的该后台会话失效，重新登录生效；不影响其他应用权限版本。

## 接口

所有业务接口使用统一网关 Cookie。写请求使用 JSON 和同源 `Origin`，不接受客户端身份头作为授权。

| 接口 | 输入 / 输出 |
| --- | --- |
| `GET /store/api/session` | 账号显示名、stores、permissions、features、types |
| `GET /store/api/coupons?store=fuzzy&page=1` | items、total、page、pageSize（固定 50） |
| `POST /store/api/coupons` | store、type、code、reason、operator、issuedAt；返回 item，201 |
| `POST /store/api/coupons/batch` | requestId（UUID v4）、store、codes（1至50个券码）、reason、operator、issuedAt；返回逐券 results、issuedCount、failedCount，200 |
| `POST /store/api/coupons/:id/redeem` | store；返回 item，200 |
| `GET /health/store` | 不含业务数据的健康检查 |

错误使用 `{ success: false, error: { message, field? } }`。参数错误为 400，登录/授权会话失效为 401，操作或门店越权为 403，当前门店找不到券为 404，重复券码或已核销为 409，网关不可用为 503。

批量接口先校验授权、门店和公共字段；通过后响应为 `{ success: true, requestId, results, issuedCount, failedCount }`。`results` 按提交顺序包含 `index、code、success`，成功项附 `item`，失败项附 `error: { message, field }`。部分乃至全部券码失败仍返回200和逐券结果；HTTP错误表示整次请求未正常完成。

`coupon_issue_batches` 表以账号和 `requestId` 为唯一键，保存请求摘要及结果，与有效券记录在同一事务内提交。原批次重试返回原结果，同一标识对应不同内容返回409；每次重试仍校验当前权限。系统级数据库异常整批回滚。结果不明时使用原请求重试，收到确定结果后对失败券发起新的 `requestId`。旧单张接口保留原校验规则，历史券码不进行格式迁移。

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

浏览器测试包含真实二维码图像经 canvas 视频流解码、确认时暂停解码但视频保持播放、权限失败、设备中断、迟到的相机授权、部分成功及丢失响应后的原请求重试。二维码图案固定在 `tests/fixtures/qr-codes.json`，测试仅替换相机来源，不替换 jsQR 的实际解码结果。

联调和浏览器检查均使用临时数据库、临时账号和动态回环端口，结束后清理。截图及尺寸记录位于 `outputs/browser-check/`（Git 忽略），其中数据为测试数据。

## 发布与回滚

日常更新使用服务器直接从 GitHub 获取指定提交：

```sh
# 完成测试、提交和推送后，明确选择本次已验收的完整提交 SHA。
release_sha=$(git rev-parse HEAD)
bash deploy/deploy-store-management.sh "$release_sha" root@139.196.140.215
```

脚本要求40位完整提交SHA，不接受 `main` 或其他移动分支名。本机只通过SSH发送部署脚本，服务器使用 `git fetch origin <SHA>` 下载代码，在独立候选目录检出指定提交并核对SHA；不会上传 Git bundle，也不会在正在运行的目录执行 `git pull`。依赖锁文件不变时复用上一版本依赖，否则使用 `npm ci --omit=dev` 安装。候选测试、SQLite在线备份及备份副本升级验证通过后，才原子切换 `current` 并重启门店服务；本机回环与正式HTTPS资源或鉴权检查失败时自动切回旧目录，保留数据库和备份。

首次配置仓库读取权限时，在服务器生成专用密钥 `/root/.ssh/id_ed25519_github_store_management`，将对应 `.pub` 添加到 GitHub `zzyspace/store-management` 的 **Settings → Deploy keys**，不要启用 **Allow write access**。私钥只保留在服务器，权限0600；脚本显式指定此密钥及严格主机验证，不使用其他仓库的Deploy Key。服务器需要预先可信的GitHub主机记录、现有门店服务和SQLite数据目录。部署加锁，拒绝同时运行两次。

首次安装整个门店服务的步骤及顺序：

1. 备份网关账号数据库（使用 SQLite 在线备份或停服备份完整数据库），记录网关和各业务当前 SHA。新网关启动时事务重建 `account_access` 的应用 CHECK 约束，保留已有账号、权限、版本和审计，不添加任何 store 授权。
2. 部署新网关并验证原后台登录、账号管理及 `/internal/authorization/store`；新授权必须由现有账号管理明确配置。
3. 安装门店服务到 `/opt/store-management/releases/<git-sha>`，在该目录运行 `npm ci --omit=dev`；创建独立 `store-management` 系统用户，配置 `/etc/store-management.env`（root 所有、0600），填写内部令牌和网关地址。
4. 使用 `ss -ltnp` 确认 8791 未被其他服务占用，核对 Node 路径。安装 `deploy/store-management.service`，将 `/opt/store-management/current` 链接到目标 release，仅启动/重启此服务。数据由 systemd 保存在 `/var/lib/store-management`。本项目不修改或 reload Nginx。
5. 验证回环健康接口和目标 release SHA 后，通过 server-infra 发布 `/store` 路由。其流程会先验证候选 Nginx，再切换、reload、冒烟，失败回滚；随后发布其他后台的导航入口。
6. 验证登录返回 `/store`、实际授权账号的门店和操作范围；核对已部署 SHA。

回滚先移除或恢复共享入口及导航，再恢复服务的 `current` 链接和网关代码；不要删除新券数据库。账号库扩大后的 CHECK 对旧代码兼容，可保留新增 store 授权数据；仅在确认迁移失败且无后续有效写入时使用备份恢复，避免覆盖新的账号变更。业务数据库在 release 目录之外，回退代码不丢失已发放和核销记录。
