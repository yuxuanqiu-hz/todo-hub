# 待办中枢 · 部署说明

## 目录结构
```
index.html      前端页面（纯静态，无需构建）
api/todos.js    Vercel Serverless Function，读写云端 KV 存储
package.json    让 Vercel 识别为 Node 项目
```

## 部署步骤

### 1. 建 GitHub 仓库
把这三个文件（index.html、api/todos.js、package.json）推到一个新的 GitHub 仓库，比如 todo-hub。

### 2. 在 Vercel 里导入项目
Vercel 控制台 -> Add New -> Project -> 选这个仓库 -> 直接 Deploy（不用改任何构建设置，静态页面 + /api 目录会被自动识别）。

### 3. 挂一个 KV 存储
项目页面 -> Storage 标签 -> 创建一个 KV（底层是 Upstash for Redis，免费额度够用）-> 选 Connect to Project，连接到你刚部署的这个项目。

连接后 Vercel 会自动往项目里写入两个环境变量：KV_REST_API_URL 和 KV_REST_API_TOKEN。api/todos.js 就是靠这两个变量读写数据的 —— 正常情况不用你手动配置，如果连接后名字不一样，去 Settings -> Environment Variables 里核对一下，改成这两个名字。

连接完 KV 后需要重新部署一次（Deployments 页面点 Redeploy），让新的环境变量生效。

### 4. 绑定你自己的域名
项目 -> Settings -> Domains -> 输入你的域名 -> 按提示去你的域名服务商那边加一条 DNS 记录（通常是 CNAME 或 A 记录）-> 生效后就能用你自己的域名访问了。

### 5. 完工
之后用你的域名在任何浏览器打开都行，包括微信、钉钉的内置浏览器。数据存在 Vercel 的 KV 里，所有设备打开同一个域名看到的是同一份。

## 后续想加的功能
- 目前谁都能访问这个域名就能读写数据，没有登录保护。如果不想公开，可以在 api/todos.js 里加一个简单的口令校验，或者用 Vercel 的密码保护功能（Pro 版）。
