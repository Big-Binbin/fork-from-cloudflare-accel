# 腾讯云 EdgeOne Makers 部署与实测记录

> 本文记录本仓库在腾讯云 EdgeOne Makers 上的**部署方法、平台限制、实际踩到的坑与验证数据**。
> 数据均为 2026-10 在 `overseas`（香港节点）+ 自定义域名环境下实测所得。

## 一、文件对应关系

| 文件 | 目标平台 | 入口写法 |
|---|---|---|
| [`edge-functions/[[default]].js`](edge-functions/[[default]].js) | **EdgeOne Makers**（catch-all 兜底全站） | `export async function onRequest(context)` |
| [`edge-functions/index.js`](edge-functions/index.js) | 同上（与上一份内容相同，用于匹配根路径 `/`） | 同上 |
| [`_worker.js`](_worker.js) | Cloudflare Workers / Pages | `export default { fetch }` |
| [`wrangler.toml`](wrangler.toml) | Cloudflare 部署配置 | — |

EdgeOne Makers 识别 `functions/**`、`edge-functions/**`（V8 边缘函数）与 `cloud-functions/**`（Node / Go / Python）。
本项目用 `edge-functions/`：其中 `[[default]].js` 是 catch-all，接管所有未命中静态资源的请求。

## 二、部署步骤

### 方式 A：控制台关联 Git 仓库

1. EdgeOne 控制台 → **Pages / Makers** → 新建项目
2. 关联 Git 仓库，选择本仓库、分支 `main`
3. 构建配置：

   | 项 | 值 |
   |---|---|
   | 框架预设 | 其他 |
   | 构建命令 | 留空 |
   | 根目录 | `./` |
   | 输出目录 | 留空 |

4. 保存并部署，等待 1~3 分钟

### 方式 B：CLI 部署（可复现，推荐）

```bash
npm install -g edgeone@latest          # 要求 CLI >= 1.6.0

export PAGES_SOURCE=skills             # 每次执行前设置，不要写进 shell profile
export EDGEONE_PAGES_API_TOKEN=<你的 API Token>
export EDGEONE_PAGES_API_REGION=china  # 中国站账号填 china，国际站填 global

edgeone makers deploy -n <项目名> -a overseas --json
```

> `--json` 输出一行机器可读结果，含 `url` / `projectId` / `deploymentId`。

## 三、⚠️ 三条必读（否则「部署了但加速不了」）

### 1. 加速区域必须选 `overseas`

| 区域 | 边缘节点 | 回源 GitHub 路径 | 实测结果 |
|---|---|---|---|
| `global`（默认） | **中国大陆**（解析到 111.51.x） | 跨境回源 | `raw` → **502**、`api.github.com` → **504**；`codeload` 仅 **30 KB/s** |
| `overseas` | **香港**（43.174.x） | 境外就近回源 | `codeload` **176 KB/s**、Release **582 KB/s**，全部 200 |

反代**境外**站点时选「全球」反而更慢——大陆边缘节点要跨境回源 GitHub。**这是最容易踩的坑。**

### 2. 必须绑定自定义域名

- `overseas` 区域的预览域名（`*.edgeone.dev`）**不对外开放**，直接访问返回 **401 UNAUTHORIZED**
- `global` 区域虽然给预览 token，但有效期仅 3 小时（`Max-Age=10800`），既不能长期使用也无法分享

结论：**绑定自己的域名**。overseas 区域不要求备案。

### 3. 免费版限额

| 项 | Edge Functions（本项目使用） | Cloud Functions |
|---|---|---|
| 代码包 | 5 MB | 128 MB |
| 请求 body | **1 MB** | 6 MB |
| CPU Time | 200 ms / 次（月配额 300 万 ms） | — |
| 执行次数 | 300 万 / 月 | 100 万 / 月 |
| 最长执行 | — | 默认 30s，可调至 120s |

> **1 MB 请求体限制的影响**：`git push`、Docker push 会失败；**拉取 / 下载不受影响**。
> 若将来要支持大请求体，可把对应逻辑迁到 `cloud-functions/`（Node，6 MB / 120s）。

## 四、已修复的线上问题（2026-10）

### 问题 1：浏览器打开加速链接**空白 / 无数据**

**现象**：浏览器访问返回 200，但页面空白；用 `curl`（未声明 `Accept-Encoding`）却完全正常。

**根因**：

```
代码把浏览器的 Accept-Encoding 转发给上游
  → GitHub 返回压缩内容 + Content-Encoding: gzip
  → EdgeOne 自动解压了响应体，却保留了 Content-Encoding 头
  → 平台以为「已经压过了」而跳过压缩，原样透传
  → 浏览器照着 gzip 解压一段明文 → 失败 → 空白
```

**证据**：修复前实测响应头声明 `Content-Encoding: gzip`，而响应体前两字节是 `7B 0A`（即 `{` + 换行，明文 JSON）。

**修复**：

- 请求侧：`delete('Accept-Encoding')` + `set('Accept-Encoding', 'identity')`
- 响应侧：显式 `new Headers(response.headers)` 重建，删除 `Content-Encoding` / `Transfer-Encoding` / `Content-Length`

> 该做法与 EdgeOne 生产项目 [MedicalChannelAI PR #62](https://github.com/wpuu/MedicalChannelAI/pull/62) 一致。

### 问题 2：GitHub Release 下载拿到**裸 302**，绕过加速

**现象**：`/https://github.com/.../releases/download/...` 直接返回 `302`，`Location` 指向 `release-assets.githubusercontent.com`，客户端自行连接（不经过加速）。

**根因**：原重定向跟随写成 `while (isDockerRequest && (302 || 307))` —— **只有 Docker 请求才跟随**。这是为了处理 Docker 跳转到 S3 时补 `x-amz-*` 签名的设计，但把 GitHub Release 的跳转漏掉了。

**修复**：跟随范围扩展到所有 `GET/HEAD`，支持 `301/302/303/307/308`，解析相对 `Location`，并**对跳转目标做白名单校验**（防止被上游 302 带出白名单，SSRF 防护）。

### 问题 3：重定向跳转没有超时保护

`release-assets.githubusercontent.com` 从部分边缘节点回源会长时间无响应，裸 `fetch` 会把函数一直挂到平台掐断（实测 > 40s）。

**修复**：单跳加 **8s** 超时；该定时器只约束「连接 + 首字节」，`fetch` 一旦 resolve 就清除，**不会掐断后续的大文件流式传输**。

### 问题 4：`fetchWithRetry` 重试前不释放响应体

重试分支直接 `continue`，上一个 `Response` 的 body 未消费，可能泄漏连接。**修复**：重试前 `response.body.cancel()`。

## 五、实测数据（overseas + 自定义域名）

| 测试项 | 结果 |
|---|---|
| 首页 | 200 · 14.0 KB |
| TVBox 源 `dianshi.json` | 200 · 45.4 KB |
| `spider.jar` | 200 · 1.8 MB |
| GitHub Release（Range 1 MB） | **206** · 1.0 MB · 1.2s |
| `codeload` 源码包 | 200 · 633.8 KB · 0.5s |
| `api.github.com` | 200 |
| Docker manifest | 200 · registry v2 |
| 白名单外域名 | 400 · 正确拦截 |
| 边缘缓存命中 | **167 ms**（未命中 1354 ms） |
| 大文件吞吐 | **582 KB/s** |

对照：同一台机器**直连 `github.com` 完全不通**（15s 超时），`raw` 直连仅约 8 KB/s。

## 六、验证命令

```bash
D=https://你的域名

# 1) 首页：确认边缘函数已生效（应返回加速页，而非 404）
curl -s -o /dev/null -w "%{http_code}\n" "$D/"

# 2) 小文件代理
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  "$D/https://raw.githubusercontent.com/qist/tvbox/master/dianshi.json"

# 3) Release：修复后应为 206 + 实际内容，而不是 302
curl -s -o /dev/null -w "%{http_code}\n" -r 0-1048575 \
  "$D/https://github.com/cloudflare/cloudflared/releases/download/2025.7.0/cloudflared-linux-amd64"

# 4) 浏览器等价验证（Node 原生 fetch 会自动解压 gzip/br）
node -e "fetch(process.argv[1]).then(async r=>console.log(r.status, (await r.arrayBuffer()).byteLength))" \
  "$D/https://raw.githubusercontent.com/qist/tvbox/master/dianshi.json"
```

> ⚠️ **Windows 自带 curl 不支持 brotli**：遇到 `Content-Encoding: br` 会解压失败、显示 0 字节。
> 这是 curl 自身的限制，**不代表服务有问题**——请用浏览器或 Node 原生 `fetch` 验证。

## 七、已知限制

- 免费版请求体上限 1 MB，`git push` / Docker push 不可用
- 数百 MB 级大文件长时间流式传输是否会被平台掐断，需按需实测
- `_worker.js`（Cloudflare 版）**未同步本次修复**：编码处理是 EdgeOne 专属的——Cloudflare 不会自动解压上游 body，照搬会导致客户端拿到压缩数据当明文。两个平台需分别维护

## 八、社区踩坑记录（供参考）

- EdgeOne Pages Functions **不支持 `addEventListener('fetch')`**，必须使用 Function Handlers（`onRequest`）；且函数代码一旦报错，平台**不会**将其识别为有效路由，后台连函数都看不到
- `edgeone.json` 的 `rewrites` **不能重写到外部绝对 URL**
- 边缘缓存只有传入 `Request` 对象才会命中（传字符串不生效）
- 免费版每天 40 次部署机会
- `edgeone` CLI **不支持**站点级配置（Gzip/Brotli、缓存规则、HTTPS 等）；那些属于 EdgeOne 站点（zone）管理，需要腾讯云 API 密钥或控制台操作

## 九、附：本机无法直连 github.com 时，用加速通道推送代码

部分网络环境下 `github.com:443` 的 git 协议不通（实测直连 **21s 超时失败**），但**本加速服务本身就能代理 git 协议**，可直接拿它来推送：

```bash
# 只读验证
git ls-remote https://你的域名/https://github.com/<user>/<repo>.git

# 推送（token 用 Personal Access Token，需 repo 权限）
git push https://<用户名>:<token>@你的域名/https://github.com/<user>/<repo>.git HEAD:main
```

实测对比：

| 通道 | ls-remote | push（8.8 KB packfile） |
|---|---|---|
| 直连 github.com | ❌ 21s 超时 | ❌ 连接重置 |
| 经本加速服务 | ✅ 2.3s | ✅ 5.2s |

也可以把 remote 直接指向加速通道，之后 `git push` / `git fetch` 都走它：

```bash
git remote set-url origin https://你的域名/https://github.com/<user>/<repo>.git
```

> ⚠️ **限制**：Edge Functions 的**请求 body 上限为 1 MB**，所以这条路只适合小体量推送。
> 大仓库（packfile 超 1 MB）会失败，需换其他网络通道。
>
> 💡 原理：git 客户端 UA 含 `git/`，会被本服务识别为 Git 请求走专门分支，且该分支**保留
> `Authorization` 头**（仅删除 Cookie / CF-* / x-amz-* 等干扰头），因此 Basic 认证可以正常透传。

## 十、许可证

与原项目一致，见 [LICENSE](LICENSE)。
