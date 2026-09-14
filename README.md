# 待办中枢 · 部署说明

## 目录结构
```
index.html           前端（待办中枢 + 知识库 + 登录页，纯静态，无需构建）
api/auth.js          登录 / 会话检查 / 退出
api/todos.js         读写云端 KV（待办与知识库）；无有效会话返回 401
lib/session.js       密码校验与签名会话 cookie
scripts/dev-server.js 本地联调（静态页 + API）
package.json         让 Vercel 识别为 Node 项目
```

底部导航在「待办中枢」和「知识库」之间切换。待办能力保持原样；原「个人」主体已更名为「家庭」，旧数据里 `entity: "个人"` 会在读取/写入时兼容并迁移为 `"家庭"`。

全站用**单一站点密码**保护（一人使用，无多用户账号）。未登录看不到待办 / 知识库内容，也不能调用读写 API。登录后会话写在 HttpOnly cookie 里，刷新仍保持登录；可退出。密码不要写进仓库或前端。

## 知识库
- 分类：证件号码、账号密码、文件；支持标题搜索、逐行复制、删除。
- 「家庭待办」是主列表家庭待办的只读镜像（同源数据，不能在知识库勾选/编辑/删除）。
- 筛选 tab 顺序：家庭待办 → 全部 → 证件号码 → 账号密码 → 文件。

### 文件存储限制（请读）
文件以 **base64 写入现有 Vercel KV / Upstash Redis**，不另接对象存储。这样跨设备能同步，但有硬限制：

- 单文件 **不超过 1.5MB**（前端拦截；接口也会拒更大的 body）。
- KV 单 value、Vercel Hobby 请求体（约 4.5MB）都不适合放大文件。
- 列表接口只回元数据；下载走 `GET /api/todos?resource=kb-file&id=`。
- 不适合视频、安装包等大文件；证件扫描件、截图、小 PDF 可以。
- 数据在 KV 里仍是明文。密码门只挡未登录访问，**不是**加密存储。

## 部署步骤

### 1. 建 GitHub 仓库
把这些文件推到 GitHub 仓库，比如 todo-hub。

### 2. 在 Vercel 里导入项目
Vercel 控制台 -> Add New -> Project -> 选这个仓库 -> 直接 Deploy（不用改任何构建设置，静态页面 + /api 目录会被自动识别）。

### 3. 挂一个 KV 存储
项目页面 -> Storage 标签 -> 创建一个 KV（底层是 Upstash for Redis，免费额度够用）-> 选 Connect to Project，连接到你刚部署的这个项目。

连接后 Vercel 会自动往项目里写入两个环境变量：KV_REST_API_URL 和 KV_REST_API_TOKEN。`api/todos.js` 就是靠这两个变量读写数据的 —— 正常情况不用你手动配置，如果连接后名字不一样，去 Settings -> Environment Variables 里核对一下，改成这两个名字。

连接完 KV 后需要重新部署一次（Deployments 页面点 Redeploy），让新的环境变量生效。

### 4. 设置站点密码（必做，否则全站拒绝访问）
Vercel 项目 -> **Settings -> Environment Variables**，新增：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `SITE_PASSWORD` | 是 | 站点登录密码。不要写进仓库、前端或提交说明。 |
| `SITE_SESSION_SECRET` | 强烈建议 | 用来给会话 cookie 做 HMAC 签名。用足够长的随机串，例如 `openssl rand -hex 32`。 |

勾选 **Production** 和 **Preview**（本地 `vercel dev` 再勾 Development）。保存后必须 **Redeploy**，否则线上还是旧环境变量。

未设置 `SITE_PASSWORD` 时，登录和数据接口都会拒绝访问（503），不会回退成公开站点。

未设置 `SITE_SESSION_SECRET` 时，服务会从 `SITE_PASSWORD` 派生签名密钥，方便先跑起来。**风险**：密码一旦泄露，攻击者也能伪造会话；改密码会换掉派生密钥。请尽快补上独立 secret。

会话 cookie：`HttpOnly`、生产 / Vercel 环境带 `Secure`、`SameSite=Lax`，默认约 **14 天**。改 `SITE_PASSWORD` 会使已有会话失效。不要把密码存进 `localStorage`。

### 5. 绑定你自己的域名
项目 -> Settings -> Domains -> 输入你的域名 -> 按提示去你的域名服务商那边加一条 DNS 记录（通常是 CNAME 或 A 记录）-> 生效后就能用你自己的域名访问了。

### 6. 完工
之后用你的域名在任何浏览器打开都行，包括微信、钉钉的内置浏览器。先输入站点密码；数据存在 Vercel 的 KV 里，所有设备打开同一个域名看到的是同一份。

## 本地验证

**不要**只用 `python3 -m http.server` 预览内容：没有 API 就无法登录，页面会停在登录 / 配置提示，这是故意的。

在仓库根目录建**未提交**的 `.env.local`（已被 `.gitignore` 忽略）：

```bash
SITE_PASSWORD=换成你自己的密码
SITE_SESSION_SECRET=换成足够长的随机串
```

不要把真实密码写进 README、PR 或命令行 history 演示。

```bash
# 在仓库根目录
npm test
npm run dev
# 浏览器打开 http://127.0.0.1:4173
```

建议按这个顺序自测（可用任意本地密码，不要把真实生产密码打进日志或截图）：

1. 不配 `SITE_PASSWORD` 启动时，页面提示未配置，`GET /api/todos` 返回 503。
2. 配好后再开：未登录只看到登录页；直接请求 `/api/todos`、`/api/todos?resource=kb`、`/api/todos?resource=kb-file` 均为 401。
3. 错密码无法进入。
4. 正确密码进入应用；刷新后仍是登录态。
5. 点「退出」回到登录页，再请求 API 为 401。
6. 有 KV 时，登录后待办 / 知识库跨设备同步与原来一致。

完整云端同步仍可用 `vercel dev`（需已连接 KV）或部署后再测。
