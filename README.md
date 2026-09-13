# 待办中枢 · 部署说明

## 目录结构
```
index.html      前端页面（待办中枢 + 知识库，纯静态，无需构建）
api/todos.js    Vercel Serverless Function，读写云端 KV（待办与知识库）
package.json    让 Vercel 识别为 Node 项目
```

底部导航在「待办中枢」和「知识库」之间切换。待办能力保持原样；原「个人」主体已更名为「家庭」，旧数据里 `entity: "个人"` 会在读取/写入时兼容并迁移为 `"家庭"`。

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
- 知识库与待办一样明文存储、无登录保护，请勿放极敏感原件。

## 部署步骤

### 1. 建 GitHub 仓库
把这些文件推到 GitHub 仓库，比如 todo-hub。

### 2. 在 Vercel 里导入项目
Vercel 控制台 -> Add New -> Project -> 选这个仓库 -> 直接 Deploy（不用改任何构建设置，静态页面 + /api 目录会被自动识别）。

### 3. 挂一个 KV 存储
项目页面 -> Storage 标签 -> 创建一个 KV（底层是 Upstash for Redis，免费额度够用）-> 选 Connect to Project，连接到你刚部署的这个项目。

连接后 Vercel 会自动往项目里写入两个环境变量：KV_REST_API_URL 和 KV_REST_API_TOKEN。`api/todos.js` 就是靠这两个变量读写数据的 —— 正常情况不用你手动配置，如果连接后名字不一样，去 Settings -> Environment Variables 里核对一下，改成这两个名字。

连接完 KV 后需要重新部署一次（Deployments 页面点 Redeploy），让新的环境变量生效。

### 4. 绑定你自己的域名
项目 -> Settings -> Domains -> 输入你的域名 -> 按提示去你的域名服务商那边加一条 DNS 记录（通常是 CNAME 或 A 记录）-> 生效后就能用你自己的域名访问了。

### 5. 完工
之后用你的域名在任何浏览器打开都行，包括微信、钉钉的内置浏览器。数据存在 Vercel 的 KV 里，所有设备打开同一个域名看到的是同一份。

## 本地验证
没有 KV 时，前端会回退到 `localStorage`（同步状态显示「本机缓存」），方便看界面和家庭待办镜像，但**不会跨设备同步**。

```bash
# 在仓库根目录
python3 -m http.server 4173
# 浏览器打开 http://127.0.0.1:4173
```

完整云端同步请用 `vercel dev`（需已连接 KV）或部署后再测。

## 后续想加的功能
- 目前谁都能访问这个域名就能读写数据，没有登录保护。如果不想公开，可以在 api/todos.js 里加一个简单的口令校验，或者用 Vercel 的密码保护功能（Pro 版）。
