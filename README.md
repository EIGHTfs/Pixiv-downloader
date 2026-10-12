# Pixiv-downloader

> 零依赖 Node.js 实现的 Pixiv 下载器：登录、关注同步、收藏下载、断点续传、代理（http/socks5）与限速。
> 只用 Node 内置模块，**不需要 `npm install`**，没有 `node_modules`。

---

## 特性

| 能力 | 说明 |
|---|---|
| 零依赖 | 仅用 `node:http/https/tls/net/zlib/crypto/stream/readline`；仓库内无 `package.json`、无 `node_modules` |
| 登录 | OAuth PKCE 授权（浏览器打开链接 → 粘贴 code）或直接用 refresh token 登录；**只保存 refresh_token，不保存账号密码** |
| 关注同步 | 拉取公开/私密关注列表写入清单，支持 `--download` 立即下载 |
| 收藏下载 | 下载自己的公开/私密收藏到 `「Bookmark」` 目录 |
| 按 UID / PID | `-u` 批量下画师、`-p` 下指定作品 |
| 清单更新 | `-U` 按清单增量下载；`-d` 把大清单拆成多份 |
| 断点续传 | 目标文件先写 `.tmp`，中断后自动用 `Range` 续传；服务器不支持 Range 时自动重下（不会拼出坏文件） |
| 完整性校验 | `content-length` 与落盘字节数严格比较；识别并拒绝 HTML 反爬页；动图校验 zip 魔数 |
| 反爬友好 | 全局 TPS 限速（默认 1 请求/秒）、指数退避重试、429 尊重 `Retry-After` |
| 代理 | 支持 `http(s)` 与 `socks5/socks5h` 代理（手写 SOCKS5 握手，零依赖）；支持可选 HTTPDNS 直连 |
| 跨进程安全 | 同一文件被别的进程下载时自动跳过（`.pxrepo/locks/`） |
| 状态安全 | 状态文件原子写；损坏文件改名留档而不是删除；清理类命令把文件移入回收站 |
| 进度条 | 三种样式：`single` / `multi` / `ipull`（非 TTY 或 `NO_COLOR` 时自动静默） |

---

## 架构

```
Pixiv-downloader/
├── cli.js                     # 唯一入口：参数解析 + 命令分发
├── src/
│   ├── cli/                   # 编排层
│   │   ├── context.js         # 装配（配置→HTTP→客户端→存储→进度条）+ .env 读写 + 断言
│   │   ├── fetch.js           # 分页拉取 + 公共下载编排
│   │   └── commands.js        # 11 个命令实现
│   ├── config.js              # 配置：.env 解析、默认值、类型转换、校验
│   ├── net/
│   │   ├── http.js            # 请求层：超时 / 重试退避 / 429 / 解压 / 连接分派
│   │   ├── proxy.js           # 代理：http CONNECT 隧道 + SOCKS5 握手 + HTTPDNS
│   │   └── limiter.js         # 令牌桶 TPS 限速
│   ├── pixiv/
│   │   ├── auth.js            # 协议常量 / 伪装请求头 / X-Client-Hash / PKCE / token
│   │   └── client.js          # API 端点封装 + 错误解析 + 401 自动刷新
│   ├── download/
│   │   ├── engine.js          # 下载引擎：并发 / .tmp 断点 / 校验 / 进度
│   │   ├── plan.js            # 作品 JSON → 下载任务（纯函数）
│   │   └── ugoira.js          # 动图：zip 地址推导、帧延时、魔数校验
│   ├── store/
│   │   ├── json.js            # JSON 原子读写（损坏留档，绝不删除）
│   │   └── stores.js          # 黑名单 / 待下载清单 / 历史记录
│   └── util/
│       ├── names.js           # 目录名/文件名净化与反解
│       ├── progress.js        # 三样式进度条
│       └── lock.js            # 跨进程文件锁
├── test/                      # 零依赖测试（run-all.mjs 一键跑）
├── docs/                      # 设计与调查文档
├── env.example                # 配置模板
└── README.md
```

**数据流（一次下载）**

```
命令解析 → 配置装配(.env) → 登录态断言 → 分页拉作品列表
        → 作品 JSON 规划成任务(单图/多图/动图) → 并发队列
        → 每个文件：查已存在 → 取跨进程锁 → 发请求(带 Referer/Range)
        → 写 <目标>.tmp（实时进度）→ 校验(大小/HTML/zip) → rename 落盘
        → 汇总(新/跳过/失败) → 记历史
```

---

## 安装

只要 **Node.js ≥ 18**（无任何第三方依赖）：

```bash
git clone <仓库地址> Pixiv-downloader
cd Pixiv-downloader
cp env.example .env      # 按需填写
node cli.js --help
```

---

## 快速开始

```bash
# 1) 配置下载目录（编辑 .env）
#    PXREPO_DATA_ROOT=~/Pixiv

# 2) 登录（浏览器打开链接 → 粘贴回调地址里的 code）
node cli.js --login

# 3) 拉取关注列表（false = 私密关注）
node cli.js -G

# 4) 先干跑看看会下什么（不发请求、不落盘）
node cli.js -U --dryrun

# 5) 真正下载（并发 3、每秒 1 请求）
node cli.js -U --concurrency 3 --tps 1
```

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `--login [token]` | 登录。不带 token 走 PKCE 授权；带 token 直接用它换 access_token |
| `--logout` | 登出（清除 `.env` 中的 refresh token） |
| `-G, --get [isPublic]` | 拉取关注列表写入清单（`false` = 私密）；加 `--download` 立即下载 |
| `-B, --bookmark [isPublic]` | 下载自己的收藏到 `「Bookmark」` |
| `-u, --uid <uid(s)>` | 按画师 UID 下载（逗号分隔） |
| `-p, --pid <pid(s)>` | 按作品 PID 下载到 `「PID」` |
| `-U, --update [json]` | 按清单更新下载（`downJson` / `historyJson` / 任意 `.json` 路径） |
| `-l, --blacklist <uid(s)>` | 黑名单增删（已存在则移出，否则加入） |
| `-d, --divide [json,size]` | 把清单拆成每份 size 条（**原文件不动**） |
| `-D, --delete` | 清理未完成下载（`.tmp` 移入回收站，可恢复） |
| `--setting` | 查看当前生效配置（凭据脱敏） |

通用选项：`--dryrun`、`--concurrency N`、`--tps N`、`--progress single|multi|ipull`、`--limit N`、`--verbose`、`-h`、`-v`。
位置参数 `path` 可覆盖 `.env` 的 `PXREPO_DATA_ROOT`。

---

## 配置（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PXREPO_DATA_ROOT` | 无（必填） | 下载根目录，支持 `~` |
| `PXREPO_REFRESH_TOKEN` | 空 | 登录凭据（`--login` 成功后自动写入） |
| `PXREPO_CONCURRENCY` | 5 | 并发下载数 |
| `PXREPO_TPS` | 1 | 每秒请求上限（0 = 不限速） |
| `PXREPO_TIMEOUT_MS` | 30000 | 单请求超时 |
| `PXREPO_RETRIES` | 3 | 失败重试次数（指数退避） |
| `PXREPO_PROXY` | 空 | 代理地址；`disable` = 强制直连；空 = 读环境变量 |
| `PXREPO_HTTPDNS` | 0 | 1 = 启用硬编码 IP 直连（失败自动回退系统 DNS） |
| `PXREPO_PROGRESS` | multi | 进度条样式 |
| `PXREPO_STATE_DIR` | `<数据根>/.pxrepo` | 状态文件目录（黑名单/清单/历史/锁/回收站） |

优先级：**命令行参数 > 真实环境变量 > `.env` 文件 > 内置默认值**。

---

## 功能流程详解

### 1. 登录（`--login`）

1. 生成 PKCE 参数：`code_verifier` = 32 字节随机数的 base64url；`code_challenge` = 其 SHA256 的 base64url
2. 打印授权链接（`https://app-api.pixiv.net/web/v1/login?...&code_challenge_method=S256&client=pixiv-android`）
3. 用户在浏览器完成授权后，把回调地址（或其中 `code=`）粘贴回来（整段 URL 也能识别）
4. `POST https://oauth.secure.pixiv.net/auth/token`（`grant_type=authorization_code`）换取 token
5. 把 `refresh_token` 写进 `.env` 的 `PXREPO_REFRESH_TOKEN`（保留文件其余内容与注释）
6. 之后每次运行：用 refresh_token 换 `access_token`；业务请求带 `Authorization: Bearer`；遇 401 自动刷新一次重试

> 请求头按官方 Android 客户端伪装：`App-OS/App-OS-Version/App-Version/User-Agent`，并带 `X-Client-Time`（本地时间带时区偏移）与 `X-Client-Hash = md5(X-Client-Time + HASH_SECRET)`。

### 2. 拉关注（`-G`）

1. 断言已登录（凭据来自 `.env`）
2. 分页请求 `/v1/user/following?user_id=<自己>&restrict=public|private`，跟随 `next_url` 直到没有下一页
3. 过滤出 `{id, name}` 写入 `<stateDir>/download.json`（原子写）
4. 若带 `--download`，直接进入「按清单下载」

### 3. 按清单下载（`-U`）

1. 读取清单（默认 `<stateDir>/download.json`），逐位画师处理
2. 黑名单命中 → 跳过并计数
3. 取画师资料 → 目录名 `(UID)画师名`（截掉 `@摊位后缀`、去掉非法字符）
4. 分页拉该画师作品列表（`/v1/user/illusts`）
5. 作品 JSON → 任务：单图 `(PID)标题.ext`、多图 `(PID)标题_pN.ext`、动图 `(PID)标题@延时ms.zip`
6. 并发下载（见下）→ 完成后写入历史记录

### 4. 单个文件的下载与续传

```
目标已存在且大小匹配 → 跳过（不发请求）
否则 → 取跨进程锁（拿不到 = 别的进程在下，跳过）
     → .tmp 已存在则带 Range: bytes=<size>- 续传
     → 服务器返回 206 → 追加写；返回 200（忽略 Range）→ 截断后重写
     → 边写边报进度（Transform 计数）
     → 校验：HTML 嗅探（反爬页 → 改名 .bad 留档）
             大小与期望不符 → 失败并**保留 .tmp**（下次续传）
             0 字节 → 失败
     → 校验通过 → rename 落盘（原子）
```

失败项统一汇总到结果里（含原因），不会静默丢弃。

### 5. 清理（`-D`）

1. 递归扫描数据根下的 `*.tmp` / `*.tmp.bad`
2. 先报数量；`--dryrun` 时只列出不移动
3. 真正执行时逐个 `rename` 到 `<stateDir>/trash/<时间戳>/`（可恢复，不删除）

### 6. 拆分清单（`-d`）

按 `size` 条切片，写成 `<清单>.1.json`、`<清单>.2.json`…；**原清单保持不变**。

---

## 文件命名规则

| 对象 | 规则 | 示例 |
|---|---|---|
| 画师目录 | `(UID)画师名`（截 `@` 后缀、去非法字符、按字节截断防超长） | `(12345)某某` |
| 单图 | `(PID)标题.ext` | `(87727821)标题.jpg` |
| 多图 | `(PID)标题_pN.ext`（N 从 0 起） | `(87727821)标题_p0.jpg` |
| 动图 | `(PID)标题@延时ms.zip` | `(87727821)标题@60ms.zip` |
| 收藏 | `「Bookmark」/…` | — |
| 按 PID | `「PID」/…` | — |

`(UID)` / `(PID)` 前缀是「识别已下载内容」的依据（更新时按前缀扫描跳过）。

---

## 代理与网络

- 支持 `http://`、`https://`、`socks5://`、`socks5h://`；写在 `.env` 的 `PXREPO_PROXY`，或用环境变量 `HTTPS_PROXY` 等
- SOCKS5 为手写实现（认证协商 + 用户名密码 + 域名交服务端解析），因此**在 DNS 被污染的环境下也能用**
- 图片 CDN（`i.pximg.net`）必须带 `Referer: https://www.pixiv.net/`，否则返回 403；下载引擎已统一带上，缺 Referer 时会在失败原因里提示
- 可选 HTTPDNS：`PXREPO_HTTPDNS=1` 时按映射表把域名换 IP 直连（保留 Host 与 SNI），失败自动回退系统 DNS；映射可用 `PXREPO_HTTPDNS_MAP="host=ip,host=ip"` 覆盖

---

## 测试

```bash
node test/run-all.mjs            # 跑全部离线测试（默认只跑 *check*）
node test/run-all.mjs --all      # 连需要外部条件的脚本一起跑
node test/run-all.mjs --list     # 列出脚本
```

| 脚本 | 覆盖 |
|---|---|
| `cli-args-check.mjs` | 参数解析（可选值不吃位置参数）、命令分发、退出码 |
| `cli-e2e-check.mjs` | 免登录端到端：清理进回收站、拆分不改原文件、配置查看 |
| `download-engine-check.mjs` | 本地 HTTP 服务器：续传 / 忽略 Range / 416 / 大小不符 / HTML 反爬 / 404 / 并发上限 / dryrun |
| `download-plan-check.mjs` | 作品 JSON → 任务（单图/多图/动图/异常输入/limit） |
| `http-proxy-check.mjs` | 本地 CONNECT + SOCKS5 服务端：代理链路、认证、错误分支 |
| `live-pixiv-check.mjs` | 真实链路（需代理）：公开接口取原图 → 经代理下载 → SHA256 逐字节比对 → 引擎复跑一致 |
| `pixiv-api-check.mjs` | 鉴权头/PKCE/查询串；在线：未鉴权被 Pixiv 拒绝 |
| `progress-check.mjs` | 三样式渲染、节流、非 TTY 静默、清区域 |
| `store-names-check.mjs` | 命名净化与反解、原子写、损坏留档、黑名单/清单/历史 |
| `probe-proxy.mjs` | 工具：批量探测代理可用性 |

---

## 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v5.0.0 | 2026-10-13 | **零依赖重写**：移除全部 npm 依赖（含 `package.json`/`package-lock.json`）与旧实现，改为分层 `src/`（cli/net/pixiv/download/store/util）；新增零依赖 SOCKS5 与 HTTPDNS、`.tmp` 断点续传、严格大小校验与 HTML 反爬识别、跨进程锁、原子状态写、三样式进度条、`--dryrun/--concurrency/--tps/--progress/--limit`；测试体系 9 个脚本 117 断言（含真实链路 SHA256 比对） |

> 旧实现（含 124 个提交的历史）保存在 `pxder-legacy` 分支，默认分支只保留本次重构之后的演进。

---

## 许可

见 [LICENSE](LICENSE)。
