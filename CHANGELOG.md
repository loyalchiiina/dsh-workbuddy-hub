
## 1.9.6 — 2026-10-14

**性能回归修复**（在排查「关掉 VPN 后整机变卡 / 微信发图很慢」时查出来的）。

### 现象

客户端**每 30 秒**轮询一次 `/state`，但实测该接口耗时：

| 第几次 | 耗时 |
|---|---|
| 1 | **21.76 s** |
| 2 | **26.19 s** |
| 3 | **21.71 s** |

→ 几乎**始终有一个长请求在飞**，DSH 自身 CPU 占用被拉到 ~124%。

### 根因

| 来源 | 说明 |
|---|---|
| 国内版（**原有行为**） | 8 个账号，**每次 /state 都实时打上游取额度** |
| 国际版（**我 1.9.4 引入的回归**） | 2 个账号走 `workbuddy.ai`（国外端点）——实测**直连超时 12s+、走代理仍要 10.4s**，而 `BILLING_TIMEOUT_MS` 是 **15s** |

两者叠加 = 20 s 以上。额度本身是**分钟级变化**的增强信息，
每次轮询都去上游取既无必要、又很贵。

### 修复：TTL 缓存（国内 3 分钟 / 国际 6 分钟）

新增 `realtimeCreditCache` + 两个helper：

- `fetchRealtimeCreditsCached(cred, region)` —— 命中缓存直接返回
- `peekRealtimeCredit(uid, region)` —— **在解密凭据之前**先看缓存

第二点很关键：解密凭据会 **spawn 该 variant 的 Electron 二进制（200 MB 级）**，
比网络更贵。命中缓存时整个跳过。

**失败语义**（遵循「检测失败 ≠ 结果为空」）：
取数失败**不清空**已有缓存值，继续沿用上次成功的结果（网络抖动不该让界面变空），
同时更新时间戳抑制重试风暴。

### 实测效果

```
第 1 次: HTTP 200  1642ms   国际版额度: 021eca36=250/250 fd8f0d2f=30/60
第 2 次: HTTP 200   868ms   国际版额度: 021eca36=250/250 fd8f0d2f=30/60
第 3 次: HTTP 200   897ms   国际版额度: 021eca36=250/250 fd8f0d2f=30/60
```

**21~26 秒 → 0.87 秒（约 25 倍）**，且额度显示不变。

> 剩余的 ~0.87 s 来自**国内版原有路径**（`loadAllAccountCredentials` 解密 8 个账号
> + `fetchWorkDaddyAccounts`），不是本次引入，行为与之前一致。

### 附：这次排查的完整结论（写给以后）

用户报「关掉 VPN 后变卡、微信发图也慢，是不是夸克网盘上传导致的」。实测证据：

| 检查 | 结果 | 判定 |
|---|---|---|
| **Fluent MPI 进程** | **64 个 `fl_mpi2610`**，每个 ~103% 单核 = **64 核满载**；内存合计 **217.7 GB** | 🔴 **主因**（与插件无关） |
| `/state` 耗时 | 21~26 s（本次已修） | 🟠 我引入的回归 |
| 系统代理 | `ProxyEnable=1` → `127.0.0.1:7890` | 🟠 VPN 关闭时该端口无转发 → 走系统代理的程序全部连接超时 |
| 夸克网盘 | 16 个进程，两个累计 CPU 800~1100 s | 🟡 上传会占**上行带宽**，与微信发图互相竞争 |

**结论**：整机卡的主因是 Fluent 占满 64 核；
「关 VPN 后更卡」是系统代理指向失效端口；
「微信发图慢」与夸克上传抢上行带宽有关。三者与插件都无直接关系（除本次修掉的 `/state` 回归）。

## 1.9.5 — 2026-10-14

用户反馈：**「模型里面没有出现 workbuddyai 分组」**（设了环境变量并重启 DSH 之后仍然如此）。

### 🔴 排查中揪出三个真 bug（都是自动探测本身的缺陷，逐个实测定位）

| # | Bug | 症状 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **注册表字段顺序假设错误** | 国际版永远探测不到 | 我在拿到 `DisplayName` 时**立刻**判定，但该值块里 `DisplayIcon` 出现在 **4 行之后**（实际顺序：`DisplayName → UninstallString → QuietUninstallString → DisplayVersion → DisplayIcon`），此时 `displayIcon` 仍是 `undefined` → 永不匹配 | 改为**收集整块、读完全部行再统一判定**（与 vendor 的 `parseWindowsRegistryOutput` 一致） |
| 2 | **`stripIconIndex` 懒惰匹配不剥离 `,0`** | 候选路径带 `,0` 后缀 → `statSync ENOENT` | 原写法 `/^(.*?)(?:,\d+)?$/`：`(.*?)` 懒惰 + `(?:,\d+)?` **可选** → 正则引擎选择"让 `.*?` 吃到末尾、可选组不匹配"，`,0` 根本没被剥掉（实测捕获值 `...WorkBuddyAI.exe,0`） | 改用**贪婪** `.*` + **非可选**尾部组：`/^(.*),\d+$/` |
| 3 | **`reg.exe` 输出编码在真实模块内损坏** 🔴 | 含中文的安装目录名变乱码 `workbuddy???.???` → `statSync ENOENT` | 本机**系统代码页 936（GBK）**，而该注册表值以 UTF-8 存储。**最阴的一点**：同一命令在**独立脚本**里 `encoding:'utf8'` 是对的（U+FFFD 0 个），在**插件真实模块里**却是坏的（U+FFFD **77 个**）—— 极易误判为"代码没问题" | 三级兜底：① 直接调 `reg.exe` 取 Buffer → `toString('utf8')`；② 若含 `U+FFFD`，改用 `TextDecoder('gbk')` 重解；③ 仍不行则用 `chcp 65001` 强制 UTF-8 重试 |

> **Bug 3 的教训（方法论）**：诊断"插件内失败、脚本内成功"这类现象时，
> **必须在插件真实运行环境里取证**（我最后靠给源码插桩打日志才锁定），
> 在独立脚本里反复验证只会越来越确信"代码没问题"。

### 为什么设了环境变量还是不行

诊断链（每步都有实证）：

1. **变量确实写进了注册表**：`HKCU\Environment\WORKBUDDY_AI_ELECTRON_BIN` ✅
2. **但 DSH 进程读不到**。决定性证据 —— 让插件在**自己的进程里**报环境变量值：
   ```
   selfCheck.workbuddy   (国内): envValue='<国内版 exe 路径>'  envOk=True
   selfCheck.workbuddyAI (国际): envValue=''                     envOk=False   ← 空
   ```
3. **原因**：Windows 环境变量只对**新启动的进程**生效。DSH 的环境继承自
   **已在运行的 explorer**（启动于前一天），而 `SetEnvironmentVariable(...,'User')`
   只写注册表 + 广播 `WM_SETTINGCHANGE`，**不会更新已在运行进程的环境块**。
   → 于是"重启 DSH"也不够，除非连 explorer 一起重启（注销/重登）。

### ✅ 正解：插件**自己探测并注入**（用户零配置）

关键洞察：**Node 的 `process.env` 是可写的**，而 vendor 正是在**同一个进程里**
读 `process.env[product.envVar]`：

```js
// vendor connect-heartbeat.js:2047
const fromEnv = process.env[options.product.envVar]?.trim();
this.explicitPath = options.electronPath ?? envPath;
```

所以插件在**加载 vendor 之前**自己把 exe 探测出来写进 `process.env` 即可 ——
等价于"替用户设好了环境变量"，**且立刻生效、不需要重启任何东西**。

> 为什么不能走 Config 传参：vendor 的 `Config` 只有
> `authFile` / `authFileAI` / `useMaximumContextWindow` 三个字段，
> **没有 `electronPath`** —— 环境变量是唯一注入途径。

### 新增 `autoDetectElectronBin()`

探测顺序（与 vendor 的发现规则一致）：

1. **已存在的有效环境变量** → 一律尊重，不覆盖
2. **默认安装位置** `%LOCALAPPDATA%\Programs\<产品名>\<exe>`
3. **注册表**卸载项的 `DisplayIcon`（遍历 HKCU / HKLM / WOW6432Node 三条根，
   按 `DisplayName` 正则过滤，剥离 `,N` 图标索引后缀）
4. **全盘扫描**（C–G 盘 × Program Files 等 × 常见目录名，覆盖"装在别的盘/中文目录名"）

**候选校验与 vendor 的 `inspectWindowsElectronCandidate` 规则完全一致**
（避免误选 `RepairApp.exe` 之类）：
- 文件名（不区分大小写）等于期望的 exeBasename
- 是普通文件且可执行
- 同目录 `version` 文件内容匹配 `/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/`
- 同目录 `resources/` 含 `app.asar`

**两个 variant 分别处理**，且 DisplayName 正则**必须区分**（否则会把国内版选给国际版）：
| | 环境变量 | exe 名 | DisplayName 正则 |
|---|---|---|---|
| 国内 | `WORKBUDDY_ELECTRON_BIN` | `workbuddy.exe` | `/^WorkBuddy(?:\s+\d+…)?$/` |
| 国际 | `WORKBUDDY_AI_ELECTRON_BIN` | `workbuddyai.exe` | `/^WorkBuddy AI(?:\s+\d+…)?$/` |

### 实测验证（清空环境变量，模拟全新机器）

```
=== 清空环境变量后执行自动探测 ===
  WORKBUDDY_ELECTRON_BIN:    自动探测成功 → <WorkBuddy.exe 路径>
  WORKBUDDY_AI_ELECTRON_BIN: 自动探测成功 → <WorkBuddyAI.exe 路径>

=== 用 vendor 的 AI_VARIANT 读国际版凭据（provider 能否工作的判据）===
  ✅ 解密成功
     uid    = <redacted-uid>
     domain = www.workbuddy.ai
     token 长度 = 1395
```

→ **用户不需要设任何环境变量、不需要重启 explorer**，重启 DSH 即可。

> 注：之前手动设的 User 级 `WORKBUDDY_AI_ELECTRON_BIN` 保留也无害
> （探测逻辑「只填空缺」，会尊重已有值）。

## 1.9.4 — 2026-10-14

用户反馈两点：**「①国际版没显示积分余额 ②模型列表本来有 workbuddyai 现在没有了」**。

### 🔴 两个问题**同一根因**：缺环境变量 `WORKBUDDY_AI_ELECTRON_BIN`

查证过程（不猜）：

```
GET /plugins/dsh-workbuddy-connect/ai/status
→ status: "signed-out"
→ reasonCode: "electron-binary-unavailable"
→ reason: "Windows uninstall records found 1 WorkBuddy AI candidate, but it did not
   match the expected app layout (the app's exe beside a version file and
   resources\app.asar); set WORKBUDDY_AI_ELECTRON_BIN to the installed app's executable"
```

**国际版 provider 找不到 `WorkBuddyAI.exe`** → 无法解密凭据 → 连锁导致：
- 模型列表**没有 workbuddy-ai 分组**（provider 注册了但拿不到账号）
- **积分余额取不到**（解密凭据是取额度的前置条件，抛 `WorkBuddyElectronPathError`）

> 注：`/health` 里 `provider.registered` 一直是 `["workbuddy","workbuddy-ai"]` ——
> **"注册成功"不等于"可用"**，这正是这两个问题看起来"莫名其妙"的原因。

**为什么本机需要显式设置**：国际版装在 `<非默认安装目录>\`（非默认位置），
且注册表里**只有国内版有卸载项**（`WorkBuddy 5.7.7`），国际版没有记录。
→ 三条发现路径（环境变量 / 注册表 / 默认路径）**全部落空**。

实测确认国际版布局本身**完全合规**：`WorkBuddyAI.exe` + `version` + `resources\app.asar` 三件齐全。

**修复**：设置用户级环境变量

```powershell
[Environment]::SetEnvironmentVariable('WORKBUDDY_AI_ELECTRON_BIN',
  '<WorkBuddyAI.exe 路径>', 'User')
```

国内版的 `WORKBUDDY_ELECTRON_BIN` **未受影响**（两个变量互不干扰）。

### ① 积分余额：**国际版本来就支持**，是我上一版写错了

上一版我在代码里硬编码 `creditsRealtimeError: '国际版暂不支持实时额度'` —— **那是错的**。
查 vendor 源码发现它早就按域名分流好了：

```js
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE     = "https://www.workbuddy.ai";
function billingBase(credential) {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
```

所以国际版凭据（`domain: www.workbuddy.ai`）会自动打到 `workbuddy.ai` 的账单接口。

**修复**：`buildGlobalRows()` 改为与国内版同样处理——并发解密每个国际版账号凭据、
调 `fetchRealtimeCredits()` 取实时额度，结果经 `realtimeFields()` 摊平进行内字段；
客户端国际版行新增「实时额度」一行。

**实测验证（2/2 全部取到）**：

| 账号 | 实时额度 | 套餐数 |
|---|---|---|
| `021eca36-…`（当前） | **250 / 250** | 1 |
| `fd8f0d2f-…` | **30 / 60** | 2 |

### 自检增强（防止别人再踩同一个坑）

`runInstallSelfCheck()` 新增 `workbuddyAI` 段，与国内版同一套范式：

```json
"workbuddyAI": {
  "envVar": "WORKBUDDY_AI_ELECTRON_BIN",
  "envValue": "<WorkBuddyAI.exe 路径>",
  "envOk": true,
  "defaultPath": "...\\Programs\\WorkBuddy AI\\WorkBuddyAI.exe",
  "defaultPathOk": false,
  "foundElsewhere": [],
  "authPath": "...\\workbuddy-desktop-ai.info",
  "authExists": true,
  "advice": "ok"
}
```

**最容易被忽略的组合已单独处理**：已登录但找不到二进制 →
给出明确可照做的建议（"不设则模型列表里不会有 workbuddy-ai 分组、也取不到积分余额"）。

### 验证

- 端到端（真实插件 + 桩 ctx）：国际版 **2/2 账号取到额度**，自检 `advice: ok`
- 国内 `selfCheck.workbuddy.advice` 仍为 `ok`（未受影响）
- `node --check` 双绿、无 BOM

## 1.9.3 — 2026-10-14

用户反馈三点：**「①国际版不退出账号登录没效果 ②显示两个账号也不能切换
③为啥登录国际版账号，打开客户端显示的是国内版」**。

### ①② 是我的实现缺陷，已修

| 用户反馈 | 根因（都是我上一版没做完） | 修复 |
|---|---|---|
| ② **不能切换** | 国际版行**只渲染了信息，忘了加「切到此账号」按钮** | 补上按钮，并传 `region:"global"`，宿主写入 `workbuddy-desktop-ai.info`（不碰国内登录位） |
| ① **两个账号都不标"当前"** | `currentUidAI()` 写得偷懒：**只有恰好 1 个账号时才返回**，2 个就永远返回 `''` | 改为**读国际版登录文件里的真实 uid**（与国内版同一套逻辑），并提供 vendor 解密兜底 |

**实测验证**（真实插件 + 桩 ctx）：

```
AI 登录位 uid = <redacted-uid>
/state → rowsAI: 2 个，其中 isCurrent **恰好 1 个**，且正好是这个 uid ✅
/state → rows  : 8 个，其中 isCurrent 1 个（国内未受影响）✅
```

客户端切号调用链复核：国内行仍是 `switchToAccount(r, swBtn)`（**2 参数，行为不变**），
国际行是 `switchToAccount(r, swBtn2, "global")`。

### ③ 不是插件问题：腾讯国际站登录页的**品牌数据回落**

用户问："为啥登录国际版账号，打开客户端显示的是国内版"。

查证国际站登录页的实际源码，找到这段：

```js
if (q === 'codebuddy' || q === 'workbuddy') { ... }
if (!brand) { brand = host.indexOf('.workbuddy.') !== -1 ? 'workbuddy' : 'codebuddy'; }
var brandData = DATA.tkd[brand] || DATA.tkd.codebuddy || DATA.tkd.workbuddy;
```

**`DATA.tkd[brand]` 取不到 `workbuddy` 的品牌数据时，回落到 `codebuddy`（国内那条）**。
页面里 `codebuddy.ai` 出现 13 次、`workbuddy.ai` **0 次** —— 所以国际站登录页
显示的是**国内版 CodeBuddy 的品牌信息**。

**这是腾讯侧的行为，插件改不了。** 另实测确认：
- 本机注册表里**只有国内版有卸载项**（`WorkBuddy 5.7.7`），国际版没有注册协议处理器
- 因此「网页登录后拉起客户端」在任何情况下都会拉到国内版

→ **结论：国际版不要走网页登录，用 App 内登录 + 台账「导入」**（这也正是 1.9.2 起
界面上的首选路径）。

### 界面措辞调整

国际版登录按钮的 tooltip 现在明确说明这一点，避免用户再次被误导。

## 1.9.2 — 2026-10-14

用户反馈：**「国内登录正常，国外登录不显示网页」**。

### 查证：网页**打开了**，只是内容"白到看不见"

按"先取证再改"的顺序排查（全程未猜）：

| 检查 | 结果 |
|---|---|
| 真实路由 `POST /login/start?region=global` | `opened: true` ✅ 浏览器确实被打开 |
| 返回的 `verificationUri` | `https://www.workbuddy.ai/login?...` ✅ 正确 |
| `openInBrowser` 是否报错 | 无 openError |
| DNS / 站点可达性 | `workbuddy.ai` → 301→200 ✅ |
| 资源 CDN `download.codebuddy.ai` | 走代理 200 / 不走代理 200 ✅ |
| **无头浏览器真实渲染对比** | **国内站截图 245KB（正常紫底+二维码）；国际站截图 44KB** |

把国际站截图拉出来看：**页面其实渲染完整**（WorkBuddy logo、Tencent OneID、
手机号/邮箱输入框、SSO 都在），**但配色极浅、近乎全白** —— 肉眼看起来就像白屏。

### 排除代理嫌疑（用户机器开着 iKuuuVPN）

实测两条路径都通：

| | 不走代理 | 走代理 127.0.0.1:7890 |
|---|---|---|
| 登录页 | HTTP 301（0.26s） | HTTP 301（3.46s） |
| CDN js | HTTP 200（2.04s） | HTTP 200（2.45s） |

→ **白屏与 VPN 代理无关**，是腾讯国际站页面自身在未登录态下的渲染表现。

### 界面调整（按用户选定的 A + C）

**C. 国际版登录按钮从标题栏移到「国际版 · WorkBuddy AI」分组内**

标题栏现在只有：
- **＋ 登录国内账号**（workbuddy.cn）
- 签到 / 网页版 / 刷新 / ★Star / ×

国际版分组内（从上到下）：
- **导入国际版账号（刷新凭据）** ← 首选路径
- **＋ 登录国际账号**（workbuddy.ai，品牌色）

**A. 明确首选路径，避免用户被白屏误导**

- 国际版登录按钮的 tooltip 现在写明：
  > 注意：该页面未登录态下配色很浅、可能看起来像白屏（腾讯站点自身行为，非插件问题）；
  > 更稳妥的做法是直接在国际版 App 里登录，然后点左边的「导入国际版账号」。

**为什么「导入」是首选**：国际版账号**主要在国际版 App 里登录**，登完点「导入」即可入库。
实测用户本机就是这个状态：`appSignedIn:true` + `accounts:1`（uid `fd8f0d2f-…`，
domain `www.workbuddy.ai`）—— **国际版账号其实早已成功导入**。

### 验证

- 客户端 bundle 探针 ✅（注册成功、factory 未抛错）
- 9 项按钮归属与链路断言 ✅（含"标题栏已无登录国际账号"、"未知区域回落国内"）
- 国内端点常量未改动 ✅
- `node --check` 双绿、无 BOM

## 1.9.1 — 2026-10-14

用户反馈：**「点击登录新账号只弹出来 WorkBuddy AI 的网页，这样的话国内版没法登录了，
不能拆东墙补西墙」**。

### 先查证，再动手（结论：不是我改坏的，但确实是问题）

三条硬证据：

1. **OAUTH 常量一行未改**：`WB_API_ENDPOINT='https://www.workbuddy.cn'`、
   `OAUTH_PLATFORM='workbuddy'` 与 1.8.3 逐字一致
2. **git diff 里我碰的登录相关行全是注释**（`// 国际版…`），没有一行代码
3. **实测复刻 `oauthStart()`**：`POST workbuddy.cn/v2/plugin/auth/state` →
   服务端返回的 `authUrl` 也是 `https://www.workbuddy.cn/login?...`；且该页实测
   **HTTP 200、无服务端跳转**

→ **插件申请到的、交给浏览器的 URL 确实是国内站**。但用户说的是事实：
**国内登录页会把人导向国际站**，所以国内账号登不进去。

### 修复：拆成两个按钮，各走各的端点

先探测国际版端点（实测，不猜）：国际站与国内**完全同构**——

```
POST https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy
→ https://www.workbuddy.ai/login?platform=workbuddy&state=...
```

关于 `platform` 参数：实测 5 个候选值（`workbuddy` / `workbuddy-ai` / `workbuddyai` /
`ai` / `global`）在 `auth/state` 与 `auth/token` 的**响应完全相同**
（都返回 `code 11217 "login ing..."`），说明该参数**不区分站点**。
→ **真正决定"登到哪个站"的是端点域名本身**，`platform` 沿用 `workbuddy` 即可。

### 改动（国内链路一字不改）

| | 国内 | 国际（新增） |
|---|---|---|
| 端点 | `https://www.workbuddy.cn`（**原值**） | `https://www.workbuddy.ai` |
| 按钮 | 「＋ 登录国内账号」→ `startSeamlessLogin("cn")` | 「＋ 登录国际账号」→ `startSeamlessLogin("global")` |
| 请求 | `POST /login/start`（**不带参数，与旧版逐字相同**） | `POST /login/start?region=global` |
| 入库 | `workbuddy-data/accounts/` | `workbuddy-data/ai/accounts/` |

- `oauthStart(region)` / `oauthPollOnce(loginId)` 按**发起时记录的 region** 打对应端点
  （跨域会拿到"state 不存在"，表现为登录成功但入库失败）
- `saveSeamlessAccount(tokenData, accData, region)` 写入对应区域目录与索引
- `/login/start` 支持 `?region=cn|global`，**默认 `cn`**；未知区域**回落国内**
- 国际版分组内也加了一个「＋ 登录国际账号」（导入只能拿已登录的；想新登就得走扫码）

### 验证（无副作用 + 真实路由）

**源码级断言（24 项，全绿）**：端点表 / 回落逻辑 / 按钮参数 / 台账分组字段 /
国内端点常量未改动。

**真实路由**：`POST /login/start?region=global` → 返回
`https://www.workbuddy.ai/login?...` ✅
（国内那条此前实测返回 `https://www.workbuddy.cn/login?...` ✅）

### 界面

标题栏原「＋ 登录新账号」拆为：
- **＋ 登录国内账号**（workbuddy.cn）
- **＋ 登录国际账号**（workbuddy.ai，品牌色）

两个按钮各有 tooltip 说明打开的站点，避免再次混淆。

## 1.9.0 — 2026-10-14

用户需求：**「把国际版在这个插件登录也弄上，现在只能登录国内的」** + **「分成两组」**。

### 背景：国际版此前只通了「一半」

先做了三层核查，确认缺口到底在哪（不猜）：

| 层 | 国际版支持情况（实测） |
|---|---|
| provider（模型转接） | ✅ **早已支持** — `/health` 实测 `registered:["workbuddy","workbuddy-ai"]` |
| 签到 | ✅ 已支持（按 token 的 `iss` 自动选 `workbuddy.ai` 域名） |
| **账号台账 / 登录 / 切号** | ❌ **只走国内** — 3 处硬编码 `variant: CN_VARIANT` |

根因（`lib/index.js` 旧版）：
```js
const WB_API_ENDPOINT = 'https://www.workbuddy.cn';   // 登录请求写死国内
const TARGET = LIVE_AUTH_PATH;                        // 切号写死国内登录位
const store = new vendor.WorkBuddyCredentialStore({ variant: vendor.CN_VARIANT, ... }); // ×3 处
```
而 vendor 层（`connect-heartbeat.js`）**两套变体都写好了**：
`CN_VARIANT`（`workbuddy.exe` / `workbuddy.cn` / `workbuddy-desktop.info`）与
`AI_VARIANT`（`workbuddyai.exe` / `workbuddy.ai` / `workbuddy-desktop-ai.info`）。
**只是插件外壳没调用国际版那条路。**

### 实施方案：先落「导入已登录账号」（用户选定 A）

国际版**不做扫码登录新账号**（那需要国际版 OAuth 端点，属第二阶段）；
本版先做**导入**：国际版 App 已登录时，直接读它的凭据入库，立刻可看/可切/可签到。
好处：**完全不需要猜测**任何端点值。

🔴 决定性实验（先验证可行性再动手）：用 vendor 的 `AI_VARIANT` 读本机
`workbuddy-desktop-ai.info` → **成功**：
```
uid=fd8f0d2f-… nickname=<redacted> domain=www.workbuddy.ai
token iss = https://www.workbuddy.ai/auth/realms/copilot
token exp = 2027-09-23
```

### 与国内版**物理隔离**（照 `global-vs-cn.md` 既有约定）

| 项 | 国内版 | 国际版（新增） |
|---|---|---|
| 账号库 | `workbuddy-data/accounts/` | **`workbuddy-data/ai/accounts/`** |
| 索引 | `accounts-index.json` | **`accounts-index-ai.json`** |
| 登录位 | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |
| provider | `workbuddy` | `workbuddy-ai` |

实测确认隔离有效：导入国际版账号后，国内 8 个账号**未受任何影响**。

### 新增

- **`POST /global/import`** — 导入国际版当前登录账号（纯读 App 登录文件，不改动它）
- **`GET /global/status`** — 国际版状态（App 是否登录 / 已导入几个 / 域名）
- `buildState()` 返回体新增 **`rowsAI`**（国际版行数组）、`globalAccountCount`、`globalAppSignedIn`
  —— **不混进 `rows`**，两组语义不同（国际版没有 WorkDaddy 的冷却/实时额度/今日用量）
- `selfContainedSwitch(uid, { region })` — **参数化区域**；不传 `opts` 时行为与以往**逐字一致**
- `/switch` 支持 `region:'global'`：国际版**跳过 WorkDaddy API**（那是国内工具，不认识国际版 uid），
  直接走自包含切换，写入 `workbuddy-desktop-ai.info`
- 国际版**不做** `mirrorCredentialToDsh()` —— 那个镜像针对国内路径，国际版镜像过去会写错文件

### 界面：台账**分成两组**

- 新增分组标题：**「国内版 · WorkBuddy」**（workbuddy.cn / codebuddy.cn）与
  **「国际版 · WorkBuddy AI」**（workbuddy.ai）
- 国际版组内含「导入国际版账号（刷新凭据）」按钮
- 未登录 / 未导入时**明确提示下一步该做什么**，不留空白（SKILL §7.20）

### 验证（真实插件 + 桩 ctx 端到端）

| 步骤 | 结果 |
|---|---|
| `GET /global/status`（导入前） | ✅ 200 · `appSignedIn:true` · 0 个账号 |
| `POST /global/import` | ✅ **200 · 导入成功** → uid/nickname 正确 |
| `GET /global/status`（导入后） | ✅ 账号数 1 · `domain: www.workbuddy.ai` |
| `GET /state` | ✅ 国内 `rows` **8** 个 + 国际 `rowsAI` **1** 个（两组分离） |
| 客户端 bundle | ✅ `__ModuleLoader__` 注册成功、factory 未抛错 |
| `node --check` | ✅ index.js / client.js 双绿 |
| 落盘核验 | ✅ `ai/accounts/<uid>.info` 已写入，国内账号数不变 |


- 同步 README 到 npm（1.8.0 发布后又优化了效果图图注文案，但未重发 npm，
  导致 npm 用户看到的图注与 GitHub 不一致）。本次仅同步文档，功能无变化。
## 1.8.2

- ⚠️ 1.8.1 是**半成品版本**（registry 元数据可见但 tarball 404，无法安装），
  按"不可覆盖已发布版本"的规则，**升版本号跨过**，不再重试 1.8.1。
- 内容与 1.8.1 相同：同步 README 到 npm（效果图图注文案与 GitHub 一致）。