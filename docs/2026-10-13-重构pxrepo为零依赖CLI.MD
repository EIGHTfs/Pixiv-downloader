# 修改方案：按 Pawchive-downloader 范式重构 pxrepo（零依赖 CLI）

> 状态：**待执行**（2026-10-13）
> 设计决策：①CLI 双兼容（保留原参数语义 + 新增 Pawchive 风格参数）②完全零依赖（只用 Node 内置，代理仅 http(s)）③砍掉 Windows 专属功能 ④配置只用 `.env`，不兼容旧 `config/` ⑤改名范围＝本地目录 + GitHub 仓库都改为 `Pixiv-downloader`，置于最后一步执行 ⑥环境变量前缀保持 `PXREPO_*` 不变 ⑦README 重写：功能流程/用法/版本记录，**大重构后不再保留「源码来自 pxder」的来源声明**
> 执行中若方案有修改，针对修改部分重写并整份覆盖入库。

---

## 一、修改目标

- **问题**：pxrepo（`EIGHTfs/pxrepo`，124 提交 / 31 文件 / 3254 行）是 pxder 的个人改版：**23 个 npm 运行时依赖**、`src/index.js` 与 `src/pxrepo.js` **两套重复实现**、`src/tools.js` 与 `src/utils.js` **文件缺失导致 require 断裂（现状跑不起来）**、12 个 `global.*` 隐式耦合、十余处明确缺陷。
- **期望效果**：重构为**零依赖 CJS CLI**——配置、HTTP、鉴权、下载、进度、参数解析、数据文件全部自持，只用 Node 内置模块；功能不丢（登录/关注/收藏/UID/PID/更新/黑名单/拆分 JSON/清理缓存）。
- **成功标准**：
  1. `node cli.js --help` 可用，**全程无 npm install**（不生成 `node_modules`）；
  2. 登录（refresh token）→ 拉关注列表 → 小样本下载，`--dryrun` 与真实下载全链路跑通；
  3. 断点续传生效：中断后重跑从 `.tmp` 续传，不整文件重下；
  4. `test/` 零依赖脚本全 PASS（相对路径，无绝对路径硬编码）；
  5. 审计 0 blocker；README 功能表/流程/版本记录齐备。

**不做（边界）**：不做 WebUI / HTTP 服务；不做小说(novel)下载；不保留 Windows 协议注册登录；不做 SOCKS 代理。

---

## 二、现状分析（读代码实测，非文档转述）

读取文件：`package.json`、`index.js`(19)、`bin/pxrepo`(441)、`src/pxrepo.js`(530)、`src/index.js`(432)、`src/downloader.js`(348)、`src/illust.js`(82)、`src/illustrator.js`(101)、`src/plugins/utils.js`(209)、`src/plugins/download.js`(81)、`src/pixiv-login.js`(27)、`src/pixiv-api-client-mod.js`(1-210)、`git log`(124 提交)。

| 维度 | 事实 |
|---|---|
| 规模 | 31 文件 / 3254 行；分支 `main` 跟踪 `origin/main` |
| 依赖 | 23 个运行时依赖：axios、commander、colors、fs-extra、pixiv-api-client、node-fetch、socks-proxy-agent、https-proxy-agent、readline-sync、prompts、open、shelljs、moment、blueimp-md5、qs、dns-packet、is-online、latest-version、compare-versions、node-stream-zip、normalize-url、path-parse、appdata-path、register-protocol-win32（+ `package-lock.json`） |
| 可运行性 | `src/index.js:8,401` `require('./tools')`、`src/pxrepo.js:499` `require('./utils')` → **`src/tools.js`、`src/utils.js` 不存在**；`node_modules` 未安装 → 现状不可运行 |
| 重复实现 | `src/index.js` 与 `src/pxrepo.js` 各自实现 initConfig/readConfig/checkConfig/applyConfig/login/loginByToken/relogin/logout/getMyFollow/getAllMyFollow/downloadByUIDs/downloadBookmark/downloadFollowAll/downloadUpdate/downloadByPIDs |
| 全局状态 | `bin/pxrepo` 定义 12 个 `global.*`（pxrepodir/inComplete/configFileDir/downJson/blacklistJson/historyJson/configFile/bookMark/blacklist/pixiv…） |
| 核心链路 | OAuth PKCE 登录（`src/pixiv-login.js`）→ refresh_token 落 `config/config.json` → 拉关注/收藏/UID/PID → `downloader.js` 多线程 → `inComplete/` 暂存 → `content-length` 校验 → `moveSync` 到下载目录 |
| API | `app-api.pixiv.net` `/v1,/v2`（user/illust/ugoira/bookmark/follow）+ `oauth.secure.pixiv.net/auth/token` + `i.pximg.net` 图片；鉴权 header：`X-Client-Time` + `X-Client-Hash = md5(time + HASH_SECRET)` |

### 已定位缺陷（重构不得照抄）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/pxrepo.js:51,67` | 裸变量 `configFile`（未声明）→ ReferenceError |
| 2 | `src/pxrepo.js:242,332,391` 等 | 用 `require()` 读可变 JSON（blacklist/download/history）→ 模块缓存导致改动不生效 |
| 3 | `src/pxrepo.js:250` | 黑名单判断写反 + 重复 `if`（黑名单内的才建目录） |
| 4 | `src/pxrepo.js:456` | `this.downloadUpdate(Json)` 无 await 自递归，无终止保证 |
| 5 | `src/pxrepo.js:423,485` | `Fs.unlinkSync` **删除用户指定的 json**（数据丢失风险） |
| 6 | `src/pxrepo.js:509` vs `src/index.js:411` | PID 目录名不一致（`「PID」` vs `PID`） |
| 7 | `src/downloader.js:62,64` | `require(historyJson)` 文件不存在即崩；裸变量 `historys` |
| 8 | `src/downloader.js:105` | `do{}while(...)` 后紧跟 `utils.clearProgress(...)` 无分号 → ASI 陷阱 |
| 9 | `src/downloader.js:212-258` | 重试递归 `tryDownload` 无次数上限 |
| 10 | `src/downloader.js:238` | `content-length`（字符串）与 `statSync().size`（数字）宽松相等比较 |
| 11 | `src/plugins/utils.js:45-53` | `mkdirsSync` 递归无终止（父目录已存在时无限递归） |
| 12 | `src/plugins/utils.js:91-112` | `divideJson` 以「条数」当「大小」；末尾 `writeFileSync(jsonFile, item)` 覆盖原文件 |
| 13 | `src/plugins/utils.js:164-181` | `isOnline` 在 `async` 内把 `return` 写在 `then` 回调里 → 永远返回 undefined |
| 14 | `src/pixiv-api-client-mod.js:95-99` | 裸变量 `follows`；`callApi(null)` 递归无终止 |
| 15 | `src/plugins/download.js:31-33` | `setTimeout(reject, global.errorTimeout)` 未清理，下载完成后仍可能 reject |
| 16 | 多处 | 硬编码 IP（`210.140.131.218`、`210.140.92.138`） |
| 17 | 全局 | 无断点续传、无 TPS 限速、无跨进程锁、无 dryrun、无 `.env` |
| 18 | `src/pxrepo.js` 全文 | 4 空格与 2 空格混用、大量空行、注释掉的死代码 |

---

## 三、Skill 学习检查

| 检查项 | 结果 | 说明 |
|---|---|---|
| 已有类似功能 skill | 有 | `plan-template-enhanced`、`refactor-read-all-code`、`refactor-read-old-code` |
| 已有同类问题方案 | 有 | `zero-dep-nodejs-no-packagejson`、`no-hardcode-config`、`test-design-norms` |
| 官方推荐做法 | 有 | Pixiv App API + OAuth PKCE（RFC 7636）；Node 内置 `https`/`crypto`/`zlib`/`readline`/`fs` |
| 现成库/工具 | 有但不用 | 23 个 npm 依赖按零依赖纪律全部去除 |
| 可复用实现 | 有 | Pawchive-downloader 的 `progress.js`（三样式进度条）、参数解析形态、`.tmp` 断点续传、TPS 门控、JSON 原子写、`test/` 脚本规范 |

**学习结论**
1. 复用：零依赖单引擎 + `lib/` 模块化、自有参数解析、模块级进度条渲染、`.tmp` 断点、原子写、相对路径测试脚本。
2. 不用：npm 依赖、`global` 状态、`require` 读可变 JSON、双实现、`fs-extra` 的隐式行为。
3. 无可用 skill 覆盖的部分（Pixiv 鉴权 header 细节）按第一性原理实现，并**用已知值对拍验证**。
4. **零依赖 ≠ 自己造轮子**：Node 内置能力先查一遍再决定是否自写——`node:crypto` 已提供 `md5`/`sha256`（实测 `md5('abc')` = `900150983cd24fb0d6963f7d28e17f72`，Node v22.23.3），因此**不需要**自写 `lib/md5.js`（原 Step 2 取消）；同理 `zlib`（ugoira/压缩）、`readline`（交互）、`https`（请求）都用内置。

---

## 四、涉及文件汇总

| 文件 | 操作 | 行数预估 | 功能描述 | 依赖关系 |
|---|---|---|---|---|
| `cli.js` | 新增 | +450 | 参数解析 + 命令编排 | 依赖全部 `lib/*` |
| `lib/config.js` | 新增 | +90 | `.env` 读取 + 默认值 + 校验（**不读旧 `config/`**） | 被 cli/download 调用 |
| `lib/http.js` | 新增 | +150 | `node:https` 封装：超时/重试退避/429 退避/http(s) 代理/可选 HTTPDNS | 被 pixiv/download 调用 |
| `lib/pixiv.js` | 新增 | +320 | OAuth PKCE + refresh token + 端点封装 + `X-Client-Hash`（自写 md5） | 依赖 http |
| `lib/download.js` | 新增 | +260 | 并发队列 + `.tmp` 断点 + TPS 门控 + 大小校验 + ugoira | 依赖 http/store/progress |
| `lib/progress.js` | 移植 | ±130 | 三样式进度条（single/multi/ipull） | 被 cli/download 调用 |
| `lib/store.js` | 新增 | +80 | JSON 原子读写（blacklist/download/history） | 被 cli/download 调用 |
| `lib/names.js` | 新增 | +60 | 画师目录名/文件名净化（去摊位后缀 + 非法字符） | 被 download 调用 |
| `test/*.mjs` | 新增 | +400 | 零依赖断言脚本 | 依赖 lib |
| `docs/2026-10-13-重构pxrepo为零依赖CLI.MD` | 新增 | — | 本方案 | 无 |
| `README.md` | 重写 | — | 功能流程 + 用法 + 版本记录 | 无 |
| `package.json` / `package-lock.json` / `src/` / `bin/` / `pxrepo` / `pxrepo.cmd` / `pxrepo.ps1` / `index.js` | 移入 `.trash/` | — | 零依赖收口（**安全删除：mv 不 rm**） | 无 |

---

## 五、目标架构与逐项设计

### 5.1 目录结构

```
pxrepo/
├── cli.js                 # 唯一入口（node cli.js ...）
├── lib/
│   ├── config.js          # .env + 默认值
│   ├── http.js            # https 封装（超时/重试/代理）
│   ├── pixiv.js           # API 客户端 + 鉴权
│   ├── download.js        # 下载引擎
│   ├── progress.js        # 进度条三样式
│   ├── store.js           # JSON 原子读写
│   └── names.js           # 命名净化
├── test/                  # 零依赖测试脚本
├── docs/                  # 方案与调查
├── .env / env.example     # 配置（.env 不入库）
└── README.md
```

### 5.2 CLI 参数（双兼容）

保留原有语义：

```
--login [token]        登录（无 token 走 PKCE；有 token 直接 refresh 登录）
--logout               登出
-G, --get [isPublic]   获取关注（false=私有，默认公开）
-B, --bookmark [isPublic]  下载收藏
-u, --uid <uid(s)>     按画师 UID 下载（逗号分隔）
-p, --pid <pid(s)>     按作品 PID 下载（逗号分隔）
-U, --update [Json]    更新下载（downJson/historyJson/任意 json 路径）
-l, --blacklist <uid(s)>   黑名单增删
-d, --divide [Json]    拆分 json
-D, --delete           清理未完成下载
--setting              设置（改为纯文本交互，去 prompts/readline-sync）
```

新增（Pawchive 风格）：

```
--dryrun               只生成计划不落盘
--concurrency N        并发数（默认 5）
--tps N                每秒请求上限（默认 1）
--progress <style>     single | multi | ipull
--limit N              只处理最新 N 个作品（小样本验证用）
```

### 5.3 配置（只用 `.env`，决策④）

```
PXREPO_DATA_ROOT=<数据根>              # 下载输出根目录（必填）
PXREPO_REFRESH_TOKEN=<token>           # 登录后可写入
PXREPO_CONCURRENCY=5
PXREPO_TPS=1
PXREPO_PROXY=                          # http(s) 代理，空=直连
PXREPO_PROGRESS=multi
PXREPO_HTTPDNS=0                       # 1=启用硬编码 IP 直连，失败自动回退
```

- `.env` 由 `lib/config.js` 解析（不引入 dotenv）；
- **不读取旧 `config/config.json`**（决策④）；旧 `config/` 目录保持原样不删，由用户自行处置；
- `.env` 写入 `.gitignore`。

### 5.4 下载引擎

```
计划 → 并发队列（--concurrency）→ TPS 门控（--tps）
     → 每个文件写 <目标>.tmp（Range 续传）→ 校验大小/类型 → rename 到最终名
     → 失败重试（指数退避，上限 3 次）→ 404 直接跳过并记入失败清单
     → 全部完成输出汇总（成功/跳过/失败/耗时/平均速度）
```

- 断点续传：`.tmp` 存在且 < 期望大小时发 `Range: bytes=<size>-`；
- 完整性校验：`content-length` 与落盘大小做**严格数字比较**；
- 跨进程锁：`.pxrepo/locks/<sha1(url)>.lock`（pid + 陈旧判定），避免同文件并发下载。

### 5.5 鉴权

```
PKCE：code_verifier = base64url(randomBytes(32))
      code_challenge = base64url(sha256(code_verifier))
      login_url = https://app-api.pixiv.net/web/v1/login?code_challenge=...&code_challenge_method=S256&client=pixiv-android
换 token：POST https://oauth.secure.pixiv.net/auth/token
      grant_type=authorization_code / refresh_token
      header 带 X-Client-Time（本地时间）+ X-Client-Hash = md5(X-Client-Time + HASH_SECRET)
```

`CLIENT_ID` / `CLIENT_SECRET` / `HASH_SECRET` 为 Pixiv 官方 App 公开协议常量（非用户凭据），集中放 `lib/pixiv.js` 顶部并注明来源与用途。

---

## 六、影响分析

| 维度 | 影响程度 | 说明 |
|---|---|---|
| 现有功能 | 中 | 参数语义保留；Windows 协议登录与 SOCKS 代理不再支持（决策②③） |
| 性能 | 低 | 并发/TPS 可配；去掉 axios 后内存占用更低 |
| 兼容性 | 中 | **不兼容旧 `config/`**（决策④）：旧 refresh_token/黑名单需手动搬进 `.env` |
| 安全性 | 低 | 凭据只存 `.env`（gitignore）；不再有 `unlinkSync` 删用户 json |
| 可维护性 | 高 | 单引擎 + 模块化，消除双实现与 12 个 global |

---

## 七、任务看板（从简到难，每步本地小提交）

- [x] **Step 1** `lib/config.js` + `.env`/`env.example`：解析 `.env`、默认值、缺 `PXREPO_DATA_ROOT` 明确报错 —— **完成**（提交 `bf6224d`）
- [ ] **Step 2** `lib/http.js`：`https.request` 封装 + 超时 + 重试退避 + 429 退避 + http(s) 代理
- [ ] **Step 3** `lib/pixiv.js`：PKCE 登录、refresh token、userFollowing/userIllusts/illustDetail/ugoiraMetadata/bookmark（md5 用内置 `node:crypto`）
- [ ] **Step 4** `lib/names.js` + `lib/store.js`：命名净化 + JSON 原子读写（**不删用户文件**）
- [ ] **Step 5** `lib/progress.js`：移植三样式进度条
- [ ] **Step 6** `lib/download.js`：并发 + `.tmp` 断点 + TPS 门控 + 校验 + ugoira
- [ ] **Step 7** `cli.js`：参数解析（双兼容）+ 全部子命令编排 + `--dryrun`
- [ ] **Step 8** 收口：旧实现与 npm 清单移入 `.trash/`，确认无 `node_modules`
- [ ] **Step 9** `test/` 零依赖脚本 + 小样本实测（dryrun 先行）
- [ ] **Step 10** README 重写（功能流程/用法/版本记录）+ 经验固化 + **改名 `Pixiv-downloader`（本地目录 + GitHub 仓库）** + 整理成一次提交推送

---

## 八、验证方案

| 类型 | 内容 |
|---|---|
| 单元（`test/`） | md5 已知向量；`.env` 解析；命名净化（含 `@` 摊位后缀、非法字符）；JSON 原子写；黑名单增删；json 拆分；`.tmp` 续传判定 |
| 集成 | `--dryrun` 跑真实 API：拉关注列表、拉某画师作品列表，断言数量与字段结构 |
| 人工 | 小样本真实下载（1 画师 ≤3 图）+ 中断续传验证 + 目录名/文件名核对 |
| 回归 | 对照旧实现功能清单逐项勾选：登录/关注/收藏/UID/PID/更新/黑名单/拆分/清理 |

---

## 九、中断与插入管理

- 执行中若用户插入新需求：暂停当前执行 → 分析冲突/影响 → 给出建议（延后/阻塞前置/可合并）→ 默认不执行，等用户确认；
- 执行中发现新 bug：阻塞性则暂停修复，非阻塞则记入第十节清单继续。

---

## 十、后续优化清单（本次不处理）

- [ ] SOCKS4/5 代理支持（需自实现握手）
- [ ] 小说(novel)下载
- [ ] WebUI / HTTP 服务（对齐 Pawchive 的 server.js 形态）
- [ ] 增量索引：把已下载清单做成 html/json 双级索引（对齐 Pawchive）
- [ ] 多账号 profile 切换

---

## 十一、执行记录（日期 + 事件 + 固化到哪个 skill）

| 日期 | 事件 | 固化到 |
|---|---|---|
| 2026-10-13 | 方案定稿并入库（4 项设计决策） | — |
| 2026-10-13 | 补充决策⑤改名范围、⑥前缀保持 `PXREPO_*` | — |
| 2026-10-13 | Step 1 配置层完成（`lib/config.js` + `env.example` + `.env` + `.gitignore`），提交 `bf6224d` | — |
| 2026-10-13 | 方案简化：`node:crypto` 已内置 md5/sha256（实测对拍通过）→ 取消原 Step 2「自写 lib/md5.js」，后续步骤顺延 | `zero-dep-nodejs-no-packagejson`（零依赖≠自造轮子，先查内置能力） |
| 2026-10-13 | Step 2 网络层完成（`lib/http.js`），并新增 `test/http-proxy-check.mjs` 本地 CONNECT 代理自检 **6/6 PASS**（区分「代理全死」与「实现有 bug」的关键工具） | 待固化：测试用本地代理自证链路 |
| 2026-10-13 | 网络侦察结论：本机 DNS 被污染（`app-api.pixiv.net`→`199.59.149.202`）、直连与 DoH 均不通；http 代理 139 个全部失效；**SOCKS5 公开代理可用**。端到端验证：`i.pximg.net` 无 Referer=403 / 带 Referer=404（真 Pixiv 行为），经代理下载原图 5,193,599 字节 JPEG（FFD8FF 起、FFD9 止）完整 | — |
| 2026-10-13 | 方案扩展（待确认）：可用代理均为 SOCKS5，而决策②限定 http(s) 代理 → 拟给 `lib/http.js` 增加零依赖 SOCKS5（手写握手，no-auth/用户名密码），仍不引入任何 npm 依赖 | — |
| 2026-10-13 | 方案扩展已确认并落地：`lib/http.js` 增加零依赖 SOCKS5（手写 RFC1928/1929），`test/http-proxy-check.mjs` 本地 CONNECT+SOCKS5 自检 **10/10 PASS**；`test/live-pixiv-check.mjs` 真实链路 **8/8 PASS**（公开 ajax 取原图地址 → 经代理下载 → 与 curl 参考图 SHA256 逐字节一致） | 待固化：用本地代理自证链路（区分「代理全死」与「实现有 bug」） |
| 2026-10-13 | Step 3 完成（`lib/pixiv.js`：PKCE 登录 / refresh token / 关注 / 画师作品 / 收藏 / 作品详情 / 动图元数据 / 分页），`test/pixiv-api-check.mjs` **10 PASS**（含在线：未鉴权请求被 Pixiv 拒绝且错误信息正确解析） | — |
| 2026-10-13 | 实测发现：Pixiv 对「缺 Authorization」的业务请求返回 **400**（不是 401），错误信息为 `Error occurred at the OAuth process. Please check your Authorization header.` → 断言改为 400/401 双接受 | 待固化：第三方 API 的错误码不能凭直觉假设 |

---

## 十二、经验固化（硬要求）

执行任何阶段中，凡出现「修掉 bug / 踩坑 / 更优手法 / 用户纠正 / 约定与实现不一致」，**当场**把「现象 / 根因 / 解决 / 防再犯」写进对应 skill：

- 通用方法论 → 技能仓库 `ai-work-archive/skills/`
- 本项目专属 → 本项目 `skills/`
- 已存在同类 skill → 追加合并，不新建重复

验收：skill 文件里能搜到教训关键词；回复给出 skill 完整路径与正文；方案第十一节追加一行。
