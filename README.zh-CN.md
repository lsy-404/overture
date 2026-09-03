# Overture

[English](README.md) | [简体中文](README.zh-CN.md)

一个通用的 Cloudflare Workers 部署向导，完全运行在浏览器里。用 Cloudflare 账号登录即可，无需本地工具链、无需 Node.js、无需命令行，就能把 GitHub release 部署到 Cloudflare Workers。

## 怎么用

1. 访问 `https://<你的-overture-主机>/?src=<owner>/<repo>`（把 `<owner>/<repo>` 替换为实际的 GitHub 仓库地址）。
2. 检查这个包会做什么：它需要的权限、会访问的端点、会创建的资源。
3. 向导提示时用 Cloudflare 账号登录授权，它只会申请这个包声明的权限。
4. 命名资源并确认，Overture 负责其余一切：D1 数据库、R2 存储桶、KV 命名空间和 Worker 脚本本身。

向导会逐步展示进度。部署失败后可以重试，已经创建好的资源会被复用而不是重复创建。

## 给应用开发者：让你的项目可以被部署

要让你的 GitHub 仓库能通过 Overture 部署，在每个 release 里发布两个资产：

| 资产 | 内容 |
|------|------|
| `overture.json` | 安装配置：元数据、内联的许可证/条款全文、权限声明、声明的 D1/R2/KV 资源、步骤清单，以及数据包的 SHA-256 |
| `overture.tar.gz` | 安装数据包：`recipe.js`、Worker 模块、assets 与 SQL —— 真正会被执行的字节 |

`overture.json` 体积很小（KB 级），在下载任何数据前就能读取，所以向导能在下载前就展示许可证、条款与权限。`overture.tar.gz` 只保留 recipe 运行所需的内容。

包可以在 `turnstiles[]` 中声明 Turnstile 小组件。Overture 总会把小组件的公开 sitekey 和配置交给 `recipe.js`。Turnstile secret 可以显式交给 `recipe.js`（`secret.target: "recipe"`，确认页会标为高风险），也可以在 recipe 完成后由 Overture 写入指定名称的 Worker Secret（`secret.target: "workerSecret"`）。使用 Turnstile 的包必须支持账户 API 令牌（`auto`）认证；创建令牌的链接会自动加入 Turnstile 权限。

完整的规范见 [`docs/RECIPE.md`](docs/RECIPE.md)。可以参考 [EdgeSonic 仓库](https://github.com/wuyilingwei/edgesonic)的完整实现。

## 给运维者：自建 Overture

Overture 本身也是一个 Cloudflare Worker。要运行自己的实例：

### 前置条件

- 一个 Cloudflare 账号
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Node.js 20+

### 设置步骤

1. 克隆这个仓库。

2. 复制示例配置：
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```
   编辑 `wrangler.toml`，填入你的 `account_id`。

   把 `ALLOWED_ORIGINS` 设为你的 Overture 实例所在的源；如果想限制哪些仓库能被部署，把 `ALLOWLIST_ENABLED` 设为 `true`，并在 `ALLOWED_SOURCES` 中列出允许的 `owner/repo`。

3. 部署：
   ```bash
   npm install
   npm run build
   npx wrangler deploy
   ```

没有其他要配置的东西——不需要设置任何密钥，也不需要创建任何命名空间。这台 Worker 没有任何持久化存储；部署策略就是部署时 `wrangler.toml` 里 `ALLOWLIST_ENABLED` / `ALLOWED_SOURCES` 的取值。

## 安全模型

Overture 的设计目标是最小化被攻击包造成的影响：

- **凭证只属于你。** Cloudflare 签发的登录令牌保存在加密的 HttpOnly Cookie 里，只有你自己这台 Overture 部署能读到 —— 页面脚本、recipe 沙箱、日志和 URL 都接触不到它，服务端也不保存任何东西。你填写的 R2 密钥只留在当前浏览器标签页里。

- **Recipe 运行在沙箱 iframe 里。** 每个 `recipe.js` 都在一个不透明源的 iframe 里运行（`sandbox="allow-scripts"`）—— 没有 DOM 访问权限、没有同源策略、没有本地存储。它读不到你的凭证，也干扰不了向导的 UI。

- **能力需要声明才能使用。** Recipe 只能调用它声明过的能力（D1、R2、Workers 等），而且中继接触的每一个 Cloudflare API 路径都是硬编码的、经过验证的 —— 不允许通配符或前缀匹配。

- **中继的路径白名单拦截坏人。** Worker 中继强制实施 Cloudflare API 路径的严格白名单。不在白名单里的路径会直接被拒绝，即使 recipe 请求也不行。

- **不留任何日志，无持久化。** Overture 不写任何日志，也不保留任何部署记录 —— 唯一的诊断信息是挂在出错那一步上的错误消息，长度会被截断，且只存在于你自己浏览器的内存里。这台 Worker 没有自己的数据库或 KV。

- **部署策略只读展示。** 策略页展示的是当前生效的白名单，由 `wrangler.toml` 里的 `ALLOWLIST_ENABLED` / `ALLOWED_SOURCES` 现算得出。没有登录入口，也没有网页端编辑器 —— 运维者要改策略，只能修改这两个变量并重新部署。

也就是说，**白名单里的任何包仍然可以在你的 Cloudflare 账号里做它声明的事** —— 创建资源、执行 D1 查询、上传 Worker 等等。所以只应该把你信任、或者充分审查过的仓库加入白名单。白名单是护栏，不是沙箱。

## 文档

| 文档 | 用途 |
|------|------|
| [`docs/RECIPE.md`](docs/RECIPE.md) | 应用开发者：`recipe.json` 与 `recipe.js` 的完整规范 |
| [`src/lib/recipe/types.ts`](src/lib/recipe/types.ts) | Recipe 格式的 TypeScript 类型参考 |
| [`src/lib/sandbox/protocol.ts`](src/lib/sandbox/protocol.ts) | Recipe 脚本能力与 API 限制 |

## 许可证

[AGPL-3.0-or-later](LICENSE)

浏览器 UI 使用了来自 [WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb) 的组件（GPL-3.0）。详见 [`src/vendor/winui/NOTICE.md`](src/vendor/winui/NOTICE.md)。
