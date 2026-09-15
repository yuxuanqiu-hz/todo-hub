# 待办中枢 · 部署说明

## 目录结构
```
index.html           前端（待办中枢 + 知识库 + 交易 + 登录页，纯静态，无需构建）
api/auth.js          登录 / 会话检查 / 退出
api/todos.js         读写云端 KV（待办、知识库、交易流水）；无有效会话返回 401
lib/session.js       密码校验与签名会话 cookie
lib/trades.js        交易校验与移动加权平均持仓计算（服务端与测试共用）
scripts/dev-server.js 本地联调（静态页 + API）
package.json         让 Vercel 识别为 Node 项目
```

底部导航在「待办中枢」「知识库」「交易」之间切换。待办能力保持原样；原「个人」主体已更名为「家庭」，旧数据里 `entity: "个人"` 会在读取/写入时兼容并迁移为 `"家庭"`。

全站用**单一站点密码**保护（一人使用，无多用户账号）。未登录看不到待办 / 知识库 / 交易内容，也不能调用读写 API。登录后会话写在 HttpOnly cookie 里，刷新仍保持登录；可退出。密码不要写进仓库或前端。

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

## 股票交易记录
底部「交易」页记录 A股 / 港股 / 美股买卖流水，并由流水汇总持仓。本期**不接实时行情**，盈亏按你录入的成交价计算；未实现盈亏只在持仓上手填「现价」后出现。

### 用法
1. 登录后点底部「交易」。
2. **流水**：选市场（A / HK / US）、买入或卖出，填代码、可选名称、成交价、数量、成交时间、手续费、税费/其他费用、备注，点「记一笔」。列表按时间倒序，可按市场筛选或搜索代码/名称。点「编辑」改流水并重算持仓；删除会先确认。
3. **持仓**：按人民币 CNY、港币 HKD、美元 USD **分组汇总**，不会把不同币种加总成一个未标注的数字。每条持仓显示数量、成本均价、总成本、已实现盈亏；手填现价后显示未实现盈亏和持仓收益率。
4. 卖出数量按成交时间顺序校验，不能超过当时持仓，否则给出明确错误。编辑或删除买入若会让后续卖出变成空头，也会被拒绝。

### 数据模型
流水存在 Vercel KV，键为 `trade:{id}`，id 集合为 `trade:ids`。手填现价存在 `trade:marks`。无 KV 时前端回退 `localStorage`（`trades-cache` / `trade-marks-cache`），同步状态显示「本机缓存」。

单条流水 JSON：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `market` | `A` / `HK` / `US` |
| `symbol` | 代码（A 股补齐 6 位，港股补齐 5 位，美股大写） |
| `name` | 名称，可选 |
| `side` | `buy` / `sell` |
| `price` | 成交价 |
| `qty` | 数量 |
| `tradedAt` | 成交时间（毫秒时间戳） |
| `fee` | 手续费 |
| `tax` | 税费或其他费用 |
| `note` | 备注 |
| `createdAt` / `updatedAt` | 写入时间 |

持仓用**移动加权平均成本**：买入时把成交金额 + 买入费用计入成本；卖出时 `已实现盈亏 = 卖出金额 - 卖出数量 × 成本均价 - 卖出费用`。货币：A股 CNY、港股 HKD、美股 USD。

接口（均需登录会话，未登录 **401**）：

- `GET/POST/DELETE /api/todos?resource=trades`
- `GET/POST /api/todos?resource=trade-marks`

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
2. 配好后再开：未登录只看到登录页；直接请求 `/api/todos`、`/api/todos?resource=kb`、`/api/todos?resource=kb-file`、`/api/todos?resource=trades`、`/api/todos?resource=trade-marks` 均为 401。
3. 错密码无法进入。
4. 正确密码进入应用；刷新后仍是登录态。底部能在「待办中枢 / 知识库 / 交易」之间切换。
5. 在「交易」录入 A股买入+卖出（含手续费/税费）、港股买入、美股买入；持仓按 CNY / HKD / USD 分组，已实现盈亏与剩余数量正确；超卖会报错。刷新后流水仍在（有 KV 则云端，无 KV 则显示本机缓存）。
6. 点「退出」回到登录页，再请求上述 API 为 401。待办与知识库原有能力不被破坏。

完整云端同步仍可用 `vercel dev`（需已连接 KV）或部署后再测。
