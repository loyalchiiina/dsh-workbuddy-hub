/**
 * dsh-workbuddy-hub — host half.
 *
 * ONE plugin that does what used to take three moving parts:
 *
 *   1. PROVIDER (转接)   — registers the `workbuddy` LLM provider, so WorkBuddy's
 *                          models are usable inside DSH. The provider code is
 *                          VENDORED from dsh-workbuddy-connect (MIT, see
 *                          lib/vendor/LICENSE.connect.txt) instead of being
 *                          reimplemented, so credential decryption (which needs
 *                          WorkBuddy's own Electron binary) keeps working.
 *   2. LEDGER  (记录)    — reads WorkDaddy's account store and serves the
 *                          multi-account table: phone, daily credits, check-in,
 *                          credit expiry, rate-limit cooldown, rotation order.
 *   3. CONTROL (操作)    — switches accounts through WorkDaddy's own API and
 *                          mirrors the resulting credential to DSH.
 *
 * Routes (all read-only except /switch and /open):
 *   GET  /dsh-workbuddy-hub/state    account table as JSON (client half polls this)
 *   GET  /dsh-workbuddy-hub/board    full-page HTML dashboard
 *   POST /dsh-workbuddy-hub/switch   { uid } -> WorkDaddy switch + credential mirror
 *   POST /dsh-workbuddy-hub/open     launch the board in the system browser
 *   GET  /dsh-workbuddy-hub/health   liveness
 *
 * Everything local is best-effort: a missing WorkDaddy install, a locked DB or a
 * schema change degrades to `available:false` instead of throwing, so the UI
 * always has something to show.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

export const name = 'dsh-workbuddy-hub';
/**
 * `llm` is REQUIRED, not optional.
 *
 * The vendored provider half calls `ctx.llm.registerAdapter(...)` while
 * registering. With only `webServer` injected, cordis activates the plugin
 * before the LLM service exists, `ctx.llm` is undefined, the vendored code
 * catches that and logs "provider registration failed" — leaving the model list
 * empty while our own wrapper happily reported success.
 *
 * Declaring `llm` makes cordis wait for the service, so registration succeeds.
 * `attachment`/`fs`/`settings` are read defensively by the vendor via ctx.get()
 * and need no injection.
 */
export const inject = ['webServer', 'llm'];

const ROUTE_PREFIX = '/dsh-workbuddy-hub';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const LOW_CREDIT = 5;
const USAGE_STALE_MS = 6 * 60 * 60 * 1000;
/**
 * GitHub 仓库（Star 直达），与客户端 REPO_URL 保持一致。
 * 仓库尚未创建时点击会 404，所以未发布时只在页面上显示提示而不是推一个错误页给用户。
 * 发布后把 REPO_READY 改成 true 即可切换为可点击。
 */
const REPO_URL = 'https://github.com/loyalchiiina/dsh-workbuddy-hub';
const REPO_READY = true;

// WorkDaddy's local panel API — the authoritative source for account facts.
const WD_API_DEFAULT_PORT = 47832;
const WD_API_TIMEOUT_MS = 5000;

const HOME = os.homedir();
const DSH_DIR = path.join(HOME, '.dsh');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const WD_DIR = path.join(APPDATA, 'WorkDaddy');
const WD_API_TOKEN_PATH = path.join(WD_DIR, '.api-token');
const WD_UI_PORT_PATH = path.join(WD_DIR, 'ui-port.json');
const META_PATH = path.join(WD_DIR, 'meta.json');
const DB_PATH = path.join(WD_DIR, 'credit-usage.db');
const CREDIT_CACHE_PATH = path.join(WD_DIR, 'account-credit-cache.json');
const ACCOUNTS_DIR = path.join(WD_DIR, 'accounts');
const LEDGER_PATH = path.join(DSH_DIR, 'workbuddy-rate-limit-ledger.json');
const LIVE_AUTH_PATH = path.join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');

// ------------------------------------------------------------------ utilities
function readJsonSync(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * 隐私脱敏（🔴 硬要求，用户 2026-10-11 明确指定）
 *
 * 手机号与昵称属于个人隐私，**任何输出面都不得完整露出**：
 * 悬浮球抽屉、网页版看板、`/state` API 响应、日志 —— 全部必须走这里。
 *
 * 手机号：保留前 3 后 4，中间 4 位打星（例 156****9121）。
 * 昵称：超过 2 字只留首尾（例「示例用户甲」→「示…甲」）；
 *       2 字以内本身就是弱信息，原样保留。
 *
 * 为什么 API 层也要脱敏：/state 是 HTTP 路由，任何能访问本机端口的进程都能读，
 * 不能假设"只有我们的 UI 会看"。真需要完整值时应走显式的、单独的、带确认的接口。
 */
function maskPhone(p) {
  const s = String(p || '');
  if (!s) return '';
  // 保留前 3 位（运营商段）+ 后 3 位，中间与第 11 位一并打码。
  // 用户 2026-10-11 要求：后四位再隐藏一位，确保更高安全性。
  if (s.length >= 11) return s.slice(0, 3) + '****' + s.slice(-4, -1) + '*';
  if (s.length >= 7) return s.slice(0, 3) + '****' + s.slice(-2, -1) + '*';
  return s;
}
function maskNickname(n) {
  const s = String(n || '').trim();
  if (!s) return '';
  // 纯数字/纯手机号形态的昵称：按手机号规则
  if (/^\d{7,}$/.test(s)) return maskPhone(s);
  const chars = Array.from(s);
  if (chars.length <= 2) return s;
  return chars[0] + '…' + chars[chars.length - 1];
}
function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtLeft(ms, now) {
  const diff = Number(ms) - (now || Date.now());
  if (diff <= 0) return '已解禁';
  const s = Math.floor(diff / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${s % 60}秒`;
}
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function currentUid() {
  try {
    const m = readFileSync(LIVE_AUTH_PATH, 'utf8').match(/"uid"\s*:\s*"([^"]+)"/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

// ------------------------------------------------------- WorkDaddy panel API
function wdApiPort() {
  try {
    const p = JSON.parse(readFileSync(WD_UI_PORT_PATH, 'utf8'));
    if (p && Number(p.port)) return Number(p.port);
  } catch (e) { /* default */ }
  return WD_API_DEFAULT_PORT;
}
function wdApiToken() {
  try { return readFileSync(WD_API_TOKEN_PATH, 'utf8').trim(); } catch (e) { return ''; }
}

/**
 * Ask WorkDaddy for the account table.
 * Auth header is `x-workdaddy-token` (verified against its daemon — NOT x-api-token).
 */
async function fetchWorkDaddyAccounts() {
  const token = wdApiToken();
  if (!token) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WD_API_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${wdApiPort()}/api/accounts`, {
      headers: { 'x-workdaddy-token': token },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.accounts)) return null;
    return doc;
  } catch (e) { return null; }
}

/** flatten creditSegments into a soonest-expiry summary plus the full schedule */
function summariseSegments(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let soonest = null;
  for (const s of list) {
    const remaining = Number(s && s.remaining);
    const exp = s && s.expiresAt != null && s.expiresAt !== '' ? Number(s.expiresAt) : null;
    if (!Number.isFinite(remaining) || remaining <= 0 || exp === null) continue;
    if (soonest === null || exp < soonest.expiresAt) soonest = { expiresAt: exp, remaining };
  }
  const schedule = list
    .map((s) => ({
      remaining: Number(s && s.remaining) || 0,
      expiresAt: s && s.expiresAt != null && s.expiresAt !== '' ? Number(s.expiresAt) : null,
      source: String((s && s.source) || ''),
    }))
    .filter((s) => s.remaining > 0)
    .sort((a, b) => {
      const ae = a.expiresAt === null ? Number.MAX_SAFE_INTEGER : a.expiresAt;
      const be = b.expiresAt === null ? Number.MAX_SAFE_INTEGER : b.expiresAt;
      return ae - be;
    });
  return {
    soonestExpiry: soonest ? soonest.expiresAt : null,
    soonestRemaining: soonest ? Math.round(soonest.remaining * 100) / 100 : null,
    schedule,
  };
}

// ------------------------------------------------------------- file fallbacks
function loadAccountsFromFiles() {
  const map = new Map();

  // 🔴 自有索引优先：它不依赖 WorkDaddy 存在，且新登录的账号会即时写入。
  try {
    const index = loadOwnedIndex();
    for (const uid of Object.keys(index)) {
      const e = index[uid] || {};
      map.set(uid, { uid, phone: String(e.phone || ''), nickname: String(e.nickname || '') });
    }
  } catch (e) { /* owned index optional */ }

  // 再用 WorkDaddy 的 meta.json 补齐（自有索引没有的账号）
  const doc = readJsonSync(META_PATH, null);
  if (doc) {
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 10) return;
      if (!Array.isArray(o) && typeof o.phone === 'string' && o.phone) {
        const uid = String(o.uid || o.id || o.userId || '');
        const key = uid + '|' + o.phone;
        if (uid && !seen.has(key)) {
          seen.add(key);
          if (!map.has(uid)) map.set(uid, { uid, phone: o.phone, nickname: String(o.nickname || '') });
        }
      }
      for (const k of Object.keys(o)) { try { walk(o[k], depth + 1); } catch (e) { /* ignore */ } }
    })(doc, 0);
  }
  try {
    // 自家账号库 + WorkDaddy 账号库合并（自有优先，WorkDaddy 可缺席）
    for (const uid of listAllAccountUids()) {
      if (!map.has(uid)) map.set(uid, { uid, phone: '', nickname: '' });
    }
  } catch (e) { /* ignore */ }
  return map;
}
function loadCreditsFromFiles() {
  // 🔴 自有积分缓存优先（迁移时已复制），WorkDaddy 的原文件作回退。
  // 否则卸载 WorkDaddy 后积分一律显示 0 —— 那是"没读到"，不是"真的没有"。
  const ownedCredit = path.join(OWNED_DIR, 'credit-cache.json');
  const doc = readJsonSync(ownedCredit, null) || readJsonSync(CREDIT_CACHE_PATH, null);
  const out = new Map();
  if (!doc || typeof doc !== 'object') return out;
  for (const uid of Object.keys(doc)) {
    const e = doc[uid];
    if (!e || typeof e !== 'object') continue;
    const seg = summariseSegments(e.creditSegments);
    out.set(uid, {
      credits: Number.isFinite(Number(e.credits)) ? Number(e.credits) : 0,
      unlimited: e.creditUnlimited === true,
      soonestExpiry: seg.soonestExpiry,
      soonestRemaining: seg.soonestRemaining,
      schedule: seg.schedule,
    });
  }
  return out;
}
// ------------------------------------------------------- realtime credits
/**
 * 实时额度（上游权威数据）。
 *
 * 背景（2026-10-11）：WorkDaddy 卸载后，"今日用量 / 今日请求数" 彻底拿不到了 ——
 * 原数据源（WorkDaddy 的 `credit-usage.db`）已删，且**上游没有任何用量查询端点**
 * （实测 8 个候选路径全部 404）。但 vendor 里藏着一个更强的接口：
 *
 *   POST {billingBase}/v2/billing/meter/get-user-resource
 *   body: { PageNumber, PageSize, ProductCode: "p_tcaca", Status: [0,3],
 *           PackageEndTimeRangeBegin, PackageEndTimeRangeEnd }
 *
 * 它返回**逐套餐**的额度与周期，比旧的静态缓存精确得多：
 *   CapacitySize / CapacityUsed / CapacityRemain   总额度 / 已用 / 剩余
 *   CycleStartTime / CycleEndTime                  周期（= 积分有效期）
 *   DeductionEndTime                               扣费截止（过期时间戳）
 *   PackageName / SubProductName                   套餐名（用于展示"哪个包快过期"）
 *
 * 因此用「实时额度 + 即将过期套餐数」替换拿不到的「今日用量 / 请求数」。
 */
const BILLING_CN = 'https://www.codebuddy.cn';
const BILLING_GLOBAL = 'https://www.workbuddy.ai';
const BILLING_TIMEOUT_MS = 15000;

function billingRegion(domain) {
  const d = String(domain || '').trim().toLowerCase();
  return (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) ? 'global' : 'cn';
}
function billingBaseFor(domain) {
  return billingRegion(domain) === 'global' ? BILLING_GLOBAL : BILLING_CN;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function billingStamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 取一个账号的实时额度。**永不抛错**（失败返回 { ok:false, error }），
 * 因为它是展示数据，不能因为它挂掉影响整个台账。
 */
async function fetchRealtimeCredits(cred) {
  const base = billingBaseFor(cred.domain);
  const now = new Date();
  try {
    const r = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cred.accessToken,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-client-platform': 'web',
        origin: base,
        referer: base + '/profile/plans-usage',
        'x-user-id': String(cred.uid || ''),
        'x-domain': String(cred.domain || ''),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: billingStamp(now),
        // 厂商实现用 ~36.9 天的窗口（3185136e3 ms），照抄同样的范围
        PackageEndTimeRangeEnd: billingStamp(new Date(now.getTime() + 3185136e3)),
      }),
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
    const text = await r.text();
    let doc = null;
    try { doc = JSON.parse(text); } catch (e) { doc = null; }
    if (!r.ok || !doc || doc.code !== 0) {
      return { ok: false, error: (doc && doc.msg) || `HTTP ${r.status}` };
    }
    const data = (doc.data && doc.data.Response && doc.data.Response.Data) || {};
    const raw = Array.isArray(data.Accounts) ? data.Accounts : [];
    const plans = raw.map((a) => {
      const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
      const size = num('CapacitySize');
      const remain = num('CapacityRemain');
      const used = num('CapacityUsed');
      const endMs = num('DeductionEndTime') || (a.CycleEndTime ? Date.parse(String(a.CycleEndTime).replace(/-/g, '/')) : 0);
      return {
        name: String(a.PackageName || a.SubProductName || '套餐'),
        sub: String(a.SubProductName || ''),
        size, used, remain,
        unit: String(a.CapacityUnit || 'credits'),
        cycleEnd: String(a.CycleEndTime || ''),
        expiresAt: endMs || null,
      };
    });
    const totalRemain = plans.reduce((s, p) => s + (p.remain || 0), 0);
    const totalSize = plans.reduce((s, p) => s + (p.size || 0), 0);
    // 即将过期 = 有效期在未来 3 天内且还有余额（先花快作废的）
    const soonMs = 3 * 24 * 60 * 60 * 1000;
    const expiring = plans.filter((p) => p.expiresAt && p.expiresAt > Date.now()
      && p.expiresAt - Date.now() < soonMs && p.remain > 0);
    return {
      ok: true,
      plans,
      planCount: plans.length,
      totalRemain,
      totalSize,
      expiringCount: expiring.length,
      soonestExpiry: plans.reduce((m, p) => (p.expiresAt && p.remain > 0 && (!m || p.expiresAt < m) ? p.expiresAt : m), null),
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'fetch failed' };
  }
}

/**
 * 批量解密所有账号的凭据（供实时额度查询用）。
 * 单个账号解密失败不影响其他账号。
 */
async function loadAllAccountCredentials() {
  let vendor = null;
  try { vendor = await import('./vendor/connect-index.js'); } catch (e) { return []; }
  if (!vendor || !vendor.WorkBuddyCredentialStore) return [];
  const out = [];
  for (const uid of listAllAccountUids()) {
    const file = accountFileFor(uid);
    if (!existsSync(file)) continue;
    try {
      const store = new vendor.WorkBuddyCredentialStore({ variant: vendor.CN_VARIANT, desktopPath: file });
      const cred = await store.readDesktop();
      if (cred && typeof cred.accessToken === 'string') {
        out.push({ uid, accessToken: cred.accessToken, domain: cred.domain || '', enterpriseId: cred.enterpriseId });
      }
    } catch (e) { /* skip this account */ }
  }
  return out;
}

/**
 * 把实时额度结果摊平成行内字段（供两条分支共用）。
 * 实时额度取不到时不报错，只是留空，UI 会显示占位。
 */
function realtimeFields(uid, realtime) {
  const r = realtime && realtime.get ? realtime.get(String(uid)) : null;
  if (!r || !r.ok) {
    return {
      creditsRealtime: null,
      creditsTotal: null,
      creditsPlanCount: null,
      creditsExpiringCount: null,
      creditsRealtimeError: (r && r.error) || '',
      creditsRealtimeAt: null,
    };
  }
  return {
    creditsRealtime: r.totalRemain,
    creditsTotal: r.totalSize,
    creditsPlanCount: r.planCount,
    creditsExpiringCount: r.expiringCount,
    creditsRealtimeError: '',
    creditsRealtimeAt: r.fetchedAt,
  };
}

// ----------------------------------------------------- auto rate-limit ledger
/**
 * 🔴 自动登记限流（429 / soft_rate）—— 2026-10-11 用户实测发现缺口后补上。
 *
 * 问题：hub 只「读」冷却台账不「写」。原写入方式是**手动命令**
 * （`workbuddy-ledger.cjs limit --text "<429 原文>"`），所以用户真撞上 429 时，
 * 台账里没有任何记录 —— 界面看着像"没人被限流"。
 *
 * 现在 hub 自己也能写：解析 429 文案里的解禁时间并 upsert 到同一份台账，
 * 与外部脚本共用格式（uid/model/resetAt/observedAt/source/rawText）。
 *
 * 解禁时间解析与 workbuddy-ledger.cjs 的 parseResetAt 同规则：
 *   "您的使用量已超出频率限制，将在 2026-10-11 13:11:07 UTC+8 重置"
 */
function parseResetAtFromText(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const tzMatch = s.match(/UTC\+(\d+)/i);
  const tz = tzMatch ? Number(tzMatch[1]) : 8;
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]) - tz, Number(m[5]), Number(m[6] || 0)
  );
  return Number.isFinite(ms) ? ms : null;
}

/** 判断一段上游错误文本是否属于限流 */
function looksLikeRateLimit(status, text) {
  if (Number(status) === 429) return true;
  const t = String(text || '');
  return /频率限制|触发限流|请求过于频繁|使用量已超出|rate\s*limit|too many requests|soft_rate/i.test(t);
}

/**
 * 把一次限流写进台账（upsert：同 uid+model 覆盖）。
 * **永不抛错** —— 登记失败不能影响模型请求本身。
 */
function recordRateLimit(uid, model, status, rawText, source) {
  try {
    const fs = require('node:fs');
    const doc = loadLedger();
    const records = Array.isArray(doc.records) ? doc.records.slice() : [];
    const text = String(rawText || '').slice(0, 2000);
    const resetAt = parseResetAtFromText(text);
    const key = String(uid) + '|' + String(model);
    const idx = records.findIndex((r) => r && (String(r.uid) + '|' + String(r.model)) === key);
    const rec = {
      uid: String(uid),
      model: String(model),
      resetAt: resetAt || null,
      observedAt: Date.now(),
      source: String(source || 'hub-auto'),
      rawText: text,
      status: Number(status) || 0,
    };
    if (idx >= 0) {
      const prev = records[idx] || {};
      const prevReset = Number(prev.resetAt) || 0;
      // 只在「新信息更有价值」时覆盖：解禁时间更晚，或原本就没有解禁时间
      if ((resetAt && resetAt > prevReset) || !prevReset) records[idx] = rec;
      else records[idx] = Object.assign({}, prev, { observedAt: rec.observedAt, rawText: rec.rawText || prev.rawText });
    } else {
      records.push(rec);
    }
    const out = { version: 1, updatedAt: Date.now(), records };
    const tmp = LEDGER_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, LEDGER_PATH);
    return { ok: true, uid: String(uid).slice(0, 8), model, resetAt, parsed: !!resetAt };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'write failed' };
  }
}

// ------------------------------------------------- rate-limit active probe
/**
 * 主动探测限流（定时，逐账号轻量请求）。
 *
 * 为什么需要它（2026-10-11 用户实测反馈）：光有"撞到 429 就登记"还不够 ——
 * 那要求用户恰好把报错送到 hub。主动探测能**自己发现**哪些账号被限流，
 * 不需要用户配合。
 *
 * 移植自 workbuddy-ledger.cjs 的 `probe` 命令：
 *   · 请求 `{model, messages:[{role:'user',content:'ping'}], max_tokens:1, stream:true}`
 *     —— `max_tokens:1` 让消耗可忽略；**必须 stream:true**（上游拒绝非流式）
 *   · `ok`      → 清除该账号的 CD 记录（已解禁，必须及时清，否则误判为不可用）
 *   · `soft_rate` → 登记（含解析出的解禁时间）
 *   · 其它状态   → 不动台账
 *   · 账号之间加间隔，避免把探测本身打成限流
 */
const PROBE_INTERVAL_MS = 10 * 60 * 1000;   // 每 10 分钟一轮
const PROBE_GAP_MS = 1500;                  // 账号间隔
const PROBE_TIMEOUT_MS = 25000;
let probeTimer = null;
let lastProbeRun = null;

/** 清除某账号在某模型上的 CD 记录（探测可用时调用） */
function clearRateLimit(uid, model) {
  try {
    const fs = require('node:fs');
    const doc = loadLedger();
    const before = Array.isArray(doc.records) ? doc.records : [];
    const kept = before.filter((r) => !(r && String(r.uid) === String(uid) && String(r.model) === String(model)));
    if (kept.length === before.length) return false;
    const tmp = LEDGER_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), records: kept }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, LEDGER_PATH);
    return true;
  } catch (e) { return false; }
}

/**
 * 跑一轮探测。返回汇总；永不抛错（探测是增强功能，坏了不能影响主功能）。
 */
async function runRateLimitProbe(model) {
  const targetModel = String(model || DEFAULT_MODEL);
  let vendor = null;
  try { vendor = await import('./vendor/connect-index.js'); } catch (e) { return { ok: false, error: 'vendor 未加载' }; }
  if (!vendor || !vendor.WorkBuddyUpstreamClient) {
    return { ok: false, error: 'vendor 未导出 WorkBuddyUpstreamClient' };
  }

  const uids = listAllAccountUids();
  if (!uids.length) return { ok: false, error: '没有可探测的账号' };

  const client = new vendor.WorkBuddyUpstreamClient();
  const results = [];
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    const file = accountFileFor(uid);
    if (!existsSync(file)) { results.push({ uid, outcome: 'no-file' }); continue; }
    let cred = null;
    try {
      const store = new vendor.WorkBuddyCredentialStore({ variant: vendor.CN_VARIANT, desktopPath: file });
      cred = await store.readDesktop();
    } catch (e) { cred = null; }
    if (!cred || typeof cred.accessToken !== 'string') {
      results.push({ uid, outcome: 'no-credential' });
      continue;
    }
    const body = JSON.stringify({
      model: targetModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: true,
    });
    let out;
    try {
      out = await client.chatStream(cred, body, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    } catch (e) {
      out = { ok: false, status: 0, kind: 'transport', message: String((e && e.message) || e).slice(0, 200) };
    }

    if (out && out.ok) {
      try { await out.response.text(); } catch (e) { /* drain */ }
      const cleared = clearRateLimit(uid, targetModel);
      results.push({ uid, outcome: 'ok', cleared });
    } else {
      const kind = (out && out.kind) || 'client';
      const msg = String((out && out.message) || '');
      if (kind === 'soft_rate' || looksLikeRateLimit(out && out.status, msg)) {
        const rec = recordRateLimit(uid, targetModel, (out && out.status) || 429, msg, 'hub-probe');
        results.push({ uid, outcome: 'soft_rate', resetAt: rec.resetAt });
      } else {
        results.push({ uid, outcome: kind, status: (out && out.status) || 0 });
      }
    }
    if (i < uids.length - 1 && PROBE_GAP_MS > 0) {
      await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
    }
  }

  const okCount = results.filter((r) => r.outcome === 'ok').length;
  const limited = results.filter((r) => r.outcome === 'soft_rate').length;
  return {
    ok: true,
    model: targetModel,
    total: results.length,
    okCount,
    limitedCount: limited,
    clearedCount: results.filter((r) => r.cleared).length,
    results: results.map((r) => Object.assign({}, r, { uid: String(r.uid).slice(0, 8) })),
    at: Date.now(),
  };
}

function startRateLimitProbe(ctx) {
  const tick = () => {
    runRateLimitProbe(DEFAULT_MODEL).then((r) => {
      lastProbeRun = r;
      if (ctx.logger && ctx.logger.info) {
        ctx.logger.info(`[next-ui-diagnostic] hub rate-probe: ok=${r.okCount || 0} limited=${r.limitedCount || 0}`
          + ` cleared=${r.clearedCount || 0} of ${r.total || 0}`);
      }
    }).catch((e) => {
      if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[next-ui-diagnostic] hub rate-probe failed: ' + (e && e.message));
    });
  };
  // 启动后 45 秒跑第一轮（避开启动高峰：provider 注册 + 签到都在前 30 秒内）
  setTimeout(tick, 45 * 1000);
  probeTimer = setInterval(tick, PROBE_INTERVAL_MS);
  if (probeTimer.unref) probeTimer.unref();
  return () => { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } };
}

function loadUsageFromDb(dateStr) {
  const out = new Map();
  const sync = new Map();
  if (!existsSync(DB_PATH)) return { usage: out, sync };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { return { usage: out, sync }; }
  let db;
  try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch (e) { return { usage: out, sync }; }
  try {
    for (const r of db.prepare('SELECT uid, SUM(credit) AS used, COUNT(*) AS n FROM credit_usage_records WHERE usage_date = ? GROUP BY uid').all(dateStr)) {
      out.set(String(r.uid), { used: Math.round(Number(r.used) * 100) / 100, requests: Number(r.n) });
    }
    for (const r of db.prepare('SELECT uid, last_success_at FROM credit_usage_sync_state').all()) {
      sync.set(String(r.uid), Number(r.last_success_at) || 0);
    }
  } catch (e) { /* schema drift */ }
  try { db.close(); } catch (e) { /* ignore */ }
  return { usage: out, sync };
}
function loadLedger() {
  const doc = readJsonSync(LEDGER_PATH, null);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.records)) return { records: [] };
  return doc;
}

// --------------------------------------------------------------- state builder
/** Everything the UI needs, in one object. Never throws. */
async function buildState(model) {
  const now = Date.now();
  const today = localDate(new Date(now));
  // 可用性：自有账号库或 WorkDaddy 数据目录任一存在即可。
  // 之前只看 WD_DIR，导致「已迁移到自有目录、WorkDaddy 已卸载」被误报为不可用。
  const available = ownedModeActive() || existsSync(WD_DIR);
  const ledger = loadLedger();
  const current = currentUid();

  const cooling = new Map();
  for (const r of ledger.records) {
    if (r && r.resetAt && Number(r.resetAt) > now) cooling.set(String(r.uid) + '|' + String(r.model), r);
  }

  const checkinLedger = loadCheckinLedger();
  const api = await fetchWorkDaddyAccounts();
  const dataSource = api ? 'workdaddy-api' : 'files';
  const rows = [];

  // ---- 实时额度：并发向每个账号的上游取（可选增强，全部失败也不影响台账） ----
  // 用户 2026-10-11 决定：用它替换拿不到的「今日用量 / 请求数」。
  const realtime = new Map();
  try {
    const creds = await loadAllAccountCredentials();
    const pairs = await Promise.all(creds.map(async (c) => {
      const r = await fetchRealtimeCredits(c);
      return [String(c.uid), r];
    }));
    for (const [uid, r] of pairs) realtime.set(uid, r);
  } catch (e) { /* realtime credits are best-effort */ }

  if (api) {
    for (const a of api.accounts) {
      const uid = String(a.uid || '');
      if (!uid) continue;
      const seg = summariseSegments(a.creditSegments);
      const credits = Number.isFinite(Number(a.credits)) ? Number(a.credits) : 0;
      const usage = a.todayUsage && typeof a.todayUsage === 'object' ? a.todayUsage : null;
      const usageKnown = !!usage && usage.synced === true;
      const rec = cooling.get(uid + '|' + model) || null;
      rows.push({
        uid,
        phone: maskPhone(String(a.phone || '')),
        nickname: maskNickname(String(a.nickname || '')),
        note: String(a.note || ''),
        isCurrent: uid === current,
        credits: Math.round(credits * 100) / 100,
        unlimited: a.creditUnlimited === true,
        soonestExpiry: seg.soonestExpiry,
        soonestRemaining: seg.soonestRemaining,
        creditSchedule: seg.schedule,
        usedToday: usage && Number.isFinite(Number(usage.used)) ? Math.round(Number(usage.used) * 100) / 100 : 0,
        requestsToday: usage && Number.isFinite(Number(usage.count)) ? Number(usage.count) : 0,
        modelsToday: {},
        usageSyncedAt: null,
        ...realtimeFields(uid, realtime),
        usageStale: !usageKnown,
        usageKnown,
        authValid: a.authValid !== false,
        tokenExpiresAt: Number(a.tokenExpiresAt) || null,
        refreshExpiresAt: Number(a.refreshExpiresAt) || null,
        lastRefreshTime: Number(a.lastRefreshTime) || null,
        lastSeen: Number(a.lastSeen) || null,
        activityStreak: a.activityStreak && typeof a.activityStreak === 'object' ? a.activityStreak : null,
        // 优先用 WorkDaddy API 的签到状态；它没给（例如它没跑过签到）就用自有台账兜底
        checkin: (a.checkin && typeof a.checkin === 'object'
          ? {
            ok: a.checkin.ok === true,
            already: a.checkin.already === true,
            code: a.checkin.code === undefined ? null : a.checkin.code,
            message: String(a.checkin.message || ''),
            source: 'workdaddy',
          }
          : null) || selfCheckinFor(uid, today, checkinLedger),
        wdRateLimits: a.modelRateLimits && typeof a.modelRateLimits === 'object' ? a.modelRateLimits : null,
        cooling: !!rec,
        resetAt: rec ? Number(rec.resetAt) : null,
        limitSource: rec ? String(rec.source || '') : '',
        usable: !rec && a.authValid !== false && (a.creditUnlimited === true || credits > LOW_CREDIT),
      });
    }
  } else {
    const accounts = loadAccountsFromFiles();
    const credits = loadCreditsFromFiles();
    const { usage, sync } = loadUsageFromDb(today);
    for (const [uid, a] of accounts) {
      const c = credits.get(uid) || { credits: 0, unlimited: false, soonestExpiry: null, soonestRemaining: null, schedule: [] };
      const u = usage.get(uid) || { used: 0, requests: 0 };
      const rec = cooling.get(uid + '|' + model) || null;
      const syncAt = sync.get(uid) || 0;
      const stale = syncAt === 0 || (now - syncAt) > USAGE_STALE_MS;
      rows.push({
        uid,
        // 🔴 隐私：files 降级分支同样必须脱敏。
        // 这条路径最初漏了（只有 API 分支做了），结果 WorkDaddy 停止、
        // 降级到 files 时手机号与昵称就明文输出了 —— 脱敏必须**每条产出路径**都做，
        // 不能只在"主路径"做。
        phone: maskPhone(String(a.phone || '')),
        nickname: maskNickname(String(a.nickname || '')),
        note: '',
        isCurrent: uid === current,
        credits: Math.round(c.credits * 100) / 100,
        unlimited: c.unlimited === true,
        soonestExpiry: c.soonestExpiry,
        soonestRemaining: c.soonestRemaining,
        creditSchedule: c.schedule || [],
        usedToday: u.used,
        requestsToday: u.requests,
        modelsToday: {},
        usageSyncedAt: syncAt || null,
        ...realtimeFields(uid, realtime),
        usageStale: stale,
        usageKnown: u.used > 0 || !stale,
        authValid: true,
        tokenExpiresAt: null,
        refreshExpiresAt: null,
        lastRefreshTime: null,
        lastSeen: null,
        activityStreak: null,
        // 降级路径也用**自有签到台账**填充（这样 WorkDaddy 不在时签到状态依然可见）
        checkin: selfCheckinFor(uid, today, checkinLedger),
        wdRateLimits: null,
        cooling: !!rec,
        resetAt: rec ? Number(rec.resetAt) : null,
        limitSource: rec ? String(rec.source || '') : '',
        usable: !rec && (c.unlimited === true || c.credits > LOW_CREDIT),
      });
    }
  }

  // rotation order: usable first, then the credit expiring soonest (spend it
  // before it lapses), then least used today, then most credits. Accounts with
  // UNKNOWN usage are not treated as "used 0" — they sort after known-smaller ones.
  rows.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    const ae = a.soonestExpiry === null ? Number.MAX_SAFE_INTEGER : a.soonestExpiry;
    const be = b.soonestExpiry === null ? Number.MAX_SAFE_INTEGER : b.soonestExpiry;
    if (ae !== be) return ae - be;
    const au = a.usageKnown ? a.usedToday : Number.MAX_SAFE_INTEGER;
    const bu = b.usageKnown ? b.usedToday : Number.MAX_SAFE_INTEGER;
    if (au !== bu) return au - bu;
    return b.credits - a.credits;
  });

  const coolingRows = rows.filter((r) => r.cooling).sort((a, b) => a.resetAt - b.resetAt);
  const currentRow = rows.find((r) => r.isCurrent) || null;
  const next = rows.find((r) => r.usable && !r.isCurrent) || rows.find((r) => r.usable) || null;

  return {
    ok: true,
    available,
    dataSource,
    reason: available ? '' : '账号库为空 —— 请用「＋ 登录新账号」添加账号；添加后这里会显示账号、积分与用量。',
    model,
    today,
    generatedAt: now,
    currentUid: current,
    current: currentRow,
    next,
    usableCount: rows.filter((r) => r.usable).length,
    coolingCount: coolingRows.length,
    totalUsedToday: Math.round(rows.reduce((s, r) => s + r.usedToday, 0) * 100) / 100,
    // 实时额度合计（拿到的账号之和）+ 取数成功的账号数，便于判断"是不是全失败"
    totalRealtime: rows.reduce((s, r) => s + (Number(r.creditsRealtime) || 0), 0),
    realtimeOkCount: rows.filter((r) => r.creditsRealtime !== null && r.creditsRealtime !== undefined).length,
    realtimeExpiring: rows.reduce((s, r) => s + (Number(r.creditsExpiringCount) || 0), 0),
    // 🔴 rows = 国内版（WorkBuddy）。**国际版单独放 rowsAI**，不混进 rows ——
    // 用户的明确要求是「分成两组」，且两边的额度/冷却/签到语义不同，
    // 混在一起会让"今日用量合计"之类的聚合数字失去意义。
    rows,
    coolingRows,
    // ---- 国际版（WorkBuddy AI / workbuddy.ai）---- 2026-10-14 v1.9.0
    rowsAI: await buildGlobalRows(model),
    globalAccountCount: listOwnedAccountsAI().length,
    globalAppSignedIn: existsSync(LIVE_AUTH_PATH_AI),
  };
}

// ------------------------------------------------------------------ HTML board
/** 数据源内部值 → 用户友好文案（内部值仍用于逻辑判断，仅显示层映射） */
function dataSourceLabel(src) {
  const s = String(src || '');
  if (s === 'workdaddy-api') return '本地账号库（实时）';
  if (s === 'files') return '本地账号库（只读）';
  return s || '本地账号库';
}

function renderBoard(state) {
  const rows = state.rows || [];
  // 🔴 隐私：网页版也必须脱敏。曾用 opts.fullPhone 让本页显示完整手机号，
  // 那等于把隐私暴露在一个可截屏/可分享的页面上，已废弃 —— 一律脱敏。
  const showPhone = (p, uid) => esc(maskPhone(p)) || esc(String(uid || '').slice(0, 8));
  const showNick = (n) => esc(maskNickname(n)) || '-';
  const unavailable = !state.available;
  const staleCount = rows.filter((r) => !r.usageKnown).length;

  const trs = rows.map((r, i) => `    <tr class="${r.isCurrent ? 'cur' : ''}${r.usable ? '' : ' unusable'}">
      <td class="n">${i + 1}</td>
      <td class="mono">${showPhone(r.phone, r.uid)}${r.isCurrent ? ' <span class="tag">DSH当前</span>' : ''}</td>
      <td>${showNick(r.nickname)}</td>
      <td class="n"><b>${r.credits}</b></td>
      <td class="n">${r.creditsRealtime === null || r.creditsRealtime === undefined
  ? `<span class="unk" title="${esc(r.creditsRealtimeError || '上游未返回')}">未取到</span>`
  : `<b>${r.creditsRealtime}</b>${r.creditsTotal ? `<span class="dim"> / ${r.creditsTotal}</span>` : ''}${r.creditsExpiringCount ? ` <span class="unk" title="有套餐即将到期">⚠${r.creditsExpiringCount}</span>` : ''}`}</td>
<td class="n dim">${r.creditsPlanCount === null || r.creditsPlanCount === undefined ? '-' : r.creditsPlanCount + ' 个'}</td>
      <td>${r.cooling
        ? `<span class="b bad" data-reset="${r.resetAt}">限流 ${esc(fmtLeft(r.resetAt, Date.now()))}</span>`
        : '<span class="b ok">可用</span>'}</td>
      <td class="s">${r.checkin
        ? (r.checkin.ok ? `<span class="ok-t">${r.checkin.already ? '已签到' : '已签到 ✓'}</span>` : '<span class="bad-t">签到失败</span>')
        : '<span class="dim">-</span>'}</td>
      <td class="s">${r.authValid === false ? '<span class="bad-t">登录失效</span>'
        : (r.tokenExpiresAt ? esc(fmtTime(r.tokenExpiresAt).slice(5, 16)) : '<span class="dim">-</span>')}</td>
      <td class="dim s">${r.creditSchedule && r.creditSchedule.length
        ? r.creditSchedule.slice(0, 3).map((s) => esc((s.expiresAt ? fmtTime(s.expiresAt).slice(5, 10) : '无期限') + ' · ' + s.remaining)).join('<br>')
          + (r.creditSchedule.length > 3 ? `<br><span class="dim">…共 ${r.creditSchedule.length} 段</span>` : '')
        : '-'}</td>
      <td class="s">${r.isCurrent ? '<span class="dim">当前</span>'
        : `<button class="sw" data-uid="${esc(r.uid)}">切到此账号</button>`}</td>
    </tr>`).join('\n');

  const cooling = (state.coolingRows || []).map((r) => `    <tr>
      <td class="mono">${showPhone(r.phone, r.uid)}</td>
      <td>${showNick(r.nickname)}</td>
      <td>${esc(fmtTime(r.resetAt))}</td>
      <td><span data-reset="${r.resetAt}">${esc(fmtLeft(r.resetAt, Date.now()))}</span></td>
    </tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy Hub · 多账号台账 · ${esc(state.today || '')}</title>
<style>
  :root { color-scheme: dark; }
  *{box-sizing:border-box}
  body{margin:0;padding:26px 30px 60px;background:#14161a;color:#e6e8ec;
       font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  h1{font-size:21px;margin:0 0 5px;font-weight:650}
  .sub{color:#8b93a1;font-size:12.5px;margin-bottom:20px}
  .cards{display:flex;gap:13px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#1c1f26;border:1px solid #2a2e38;border-radius:10px;padding:11px 17px;min-width:126px}
  .card .k{color:#8b93a1;font-size:11.5px}
  .card .v{font-size:21px;font-weight:650;margin-top:3px}
  table{width:100%;border-collapse:collapse;background:#1a1d23;border-radius:10px;overflow:hidden}
  th{text-align:left;font-size:11.5px;color:#98a0ae;font-weight:600;padding:10px 13px;
     background:#20242c;border-bottom:1px solid #2a2e38;white-space:nowrap}
  td{padding:10px 13px;border-bottom:1px solid #242832;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr.cur{background:#1d2a22;box-shadow:inset 3px 0 0 #35c46a}
  tr.unusable{opacity:.55}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  .b{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;white-space:nowrap}
  .b.ok{background:#16351f;color:#56d98a;border:1px solid #235e37}
  .b.bad{background:#3a1a1e;color:#ff8a8a;border:1px solid #6b2a30}
  .tag{background:#235e37;color:#7ee2a8;border-radius:4px;padding:1px 6px;font-size:10.5px}
  .dim{color:#7c8492}.s{font-size:11.5px}
  .unk{color:#f0c98a;border-bottom:1px dotted #f0c98a;cursor:help}
  .ok-t{color:#56d98a}.bad-t{color:#ff8a8a}
  .sw{background:#232a35;border:1px solid #2f3745;color:#cfd7e3;border-radius:6px;
      padding:3px 9px;font-size:11.5px;cursor:pointer;font-family:inherit}
  .sw:hover{background:#2b3440}
  .sw:disabled{opacity:.55;cursor:default}
  .note{background:#1e2430;border:1px solid #2f3a4a;color:#9fb0c6;padding:10px 14px;border-radius:9px;
        margin-bottom:16px;font-size:12px;line-height:1.7}
  .note b{color:#cfd9e6}
  .h2{font-size:14px;margin:24px 0 8px;font-weight:600;color:#cfd5de}
  .warn{background:#3a2a1a;border:1px solid #6b502a;color:#f0c98a;padding:11px 14px;border-radius:9px;margin-bottom:18px}
  .foot{margin-top:18px;color:#7c8492;font-size:11.5px;line-height:1.9}
  .star{display:inline-block;margin-top:6px;padding:5px 12px;border-radius:7px;text-decoration:none;
        background:#2a2410;border:1px solid #6b5a2a;color:#f0c98a;font-size:12px}
  .star:hover{background:#332c14}
  .star-disabled{display:inline-block;margin-top:6px;padding:5px 12px;border-radius:7px;
        background:#23262e;border:1px solid #2f3745;color:#8b93a1;font-size:12px;cursor:help}
  .starbtn{display:inline-block;padding:4px 11px;border-radius:7px;text-decoration:none;
        background:#2a2410;border:1px solid #6b5a2a;color:#f0c98a;font-size:12px;white-space:nowrap}
  .loginbtn{background:#1e4d33;border:1px solid #2b6b46;color:#8ee0ae;border-radius:7px;
        padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
  .loginbtn:hover{background:#255c3d}
  .loginbtn:disabled{opacity:.55;cursor:default}
  .loginstat{color:#8ee0ae;font-size:12px;white-space:nowrap}
  code{background:#23262e;padding:2px 7px;border-radius:5px;color:#c9d1dc;font-family:Consolas,monospace;font-size:11.5px}
  #toast{position:fixed;right:22px;bottom:22px;background:#1e4d33;border:1px solid #2b6b46;
         color:#b6f0cd;padding:11px 16px;border-radius:9px;font-size:13px;opacity:0;
         transition:opacity .25s;pointer-events:none;max-width:520px;z-index:9}
  #toast.show{opacity:1}
</style></head><body>
<div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
  <div style="flex:1 1 auto;min-width:260px">
    <h1>Workhoney · 多账号台账</h1>
    <div class="sub">${esc(state.today || '')} · 生成于 ${esc(fmtTime(state.generatedAt))} · 目标模型 ${esc(state.model || '')} · 数据源 ${esc(dataSourceLabel(state.dataSource))} · 每 30 秒自动刷新</div>
  </div>
  <div style="flex:0 0 auto;padding-top:6px;display:flex;gap:8px;align-items:center">
    <button class="loginbtn" id="btnLoginNew" title="无感登录：不退出当前账号，浏览器扫码后自动入库">＋ 登录新账号</button>
    <span class="loginstat" id="loginStat" style="display:none"></span>
    ${REPO_READY
      ? `<a class="starbtn" href="${esc(REPO_URL)}" target="_blank" rel="noopener noreferrer">★ Star</a>`
      : `<span class="star-disabled" title="${esc(REPO_URL)}">★ Star（未发布）</span>`}
  </div>
</div>
${unavailable ? `<div class="warn"><b>多账号信息不可用</b><br>${esc(state.reason || '')}<br><span class="s">观察模型使用不受影响，只是看不到账号/积分汇总。</span></div>` : ''}
${state.realtimeOkCount === 0 && rows.length > 0 ? `<div class="note"><b>实时额度未取到</b>：本页额度来自上游接口，需要每个账号的凭据可解密且网络可达。请检查 <code>/dsh-workbuddy-hub/selfcheck</code> 的 <code>authFile</code> 与 <code>workbuddy.advice</code>。</div>` : ''}
${state.realtimeExpiring > 0 ? `<div class="note"><b>有 ${state.realtimeExpiring} 个套餐即将到期</b>（3 天内）：建议优先使用即将过期的账号，避免积分作废。</div>` : ''}
<div class="cards">
  <div class="card"><div class="k">账号总数</div><div class="v">${rows.length}</div></div>
  <div class="card"><div class="k">当前可用</div><div class="v">${state.usableCount}</div></div>
  <div class="card"><div class="k">正在限流</div><div class="v">${state.coolingCount}</div></div>
  <div class="card"><div class="k">实时总额度</div><div class="v">${state.totalRealtime || 0}</div><div class="k" style="margin-top:3px">仅统计已同步账号</div></div>
</div>
<table><thead><tr>
  <th>顺序</th><th>手机号</th><th>昵称</th><th>实时额度</th><th>套餐</th>
  <th>${esc(state.model || '')} 状态</th><th>签到</th><th>登录令牌到期</th>
  <th>积分有效期（先过期先花）</th><th>操作</th>
</tr></thead><tbody>
${trs}
</tbody></table>
${cooling ? `<div class="h2">冷却队列（按解禁先后）</div><table><thead><tr><th>手机号</th><th>昵称</th><th>解禁时间</th><th>还需等待</th></tr></thead><tbody>
${cooling}
</tbody></table>` : ''}
<div class="foot">
  数据源：本地账号库（只读）· 冷却台账：${esc(LEDGER_PATH)}<br>
  本页由 <code>dsh-workbuddy-hub</code> 提供（内置 provider 转接 + 多账号记录）<br>
  ${REPO_READY
    ? `<a class="star" href="${esc(REPO_URL)}" target="_blank" rel="noopener noreferrer">★ 觉得有用？点这里给个 Star</a>`
    : `<span class="star-disabled" title="${esc(REPO_URL)}">★ 仓库尚未发布（${esc(REPO_URL)}）</span>`}
</div>
<div id="toast"></div>
<script>
(function(){
  var cells = Array.prototype.slice.call(document.querySelectorAll('[data-reset]'));
  function human(ms){
    if(ms<=0) return '已解禁';
    var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
    if(h>=24) return Math.floor(h/24)+'天'+(h%24)+'小时';
    if(h>0) return h+'小时'+m+'分';
    return m+'分'+(s%60)+'秒';
  }
  function tick(){ var now=Date.now(); cells.forEach(function(el){
    var r=Number(el.getAttribute('data-reset')); if(!r) return;
    el.textContent = human(r-now);
  }); }
  if(cells.length){ tick(); setInterval(tick,1000); }

  var toast = document.getElementById('toast');
  function say(msg, sticky){
    if(!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    if(toast._t) clearTimeout(toast._t);
    if(!sticky) toast._t = setTimeout(function(){ toast.classList.remove('show'); }, 4200);
  }
  // delegated so a table rebuild can never strand the handler
  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('button.sw') : null;
    if(!btn) return;
    e.preventDefault();
    var uid = btn.getAttribute('data-uid');
    if(!uid) return;
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = '切换中…';
    say('正在切换账号…', true);
    fetch('/dsh-workbuddy-hub/switch', {
      method:'POST', credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({uid: uid})
    }).then(function(r){ return r.json().then(function(d){ return {s:r.status, d:d}; }); })
      .then(function(out){
        var d = out.d || {};
        if(d.ok){
          say('已切换（凭据同步：' + (d.credentialMirror||'?') + '），页面即将刷新');
          setTimeout(function(){ location.reload(); }, 1200);
        } else {
          say('切换失败：' + (d.error || (d.workdaddy && d.workdaddy.raw) || ('HTTP ' + out.s)));
          btn.disabled = false; btn.textContent = prev;
        }
      })
      .catch(function(err){
        say('切换失败：' + (err && err.message ? err.message : err));
        btn.disabled = false; btn.textContent = prev;
      });
  });
  // ---- 无感登录（方式一）：不退出当前账号，浏览器扫码后自动入库 ----
  // 复用与悬浮球同一套宿主路由（/login/start + /login/poll），行为完全一致。
  var loginBtn = document.getElementById('btnLoginNew');
  var loginStat = document.getElementById('loginStat');
  var loginPolling = false;
  function setStat(t) {
    if (!loginStat) return;
    loginStat.textContent = t || '';
    loginStat.style.display = t ? 'inline' : 'none';
  }
  if (loginBtn) loginBtn.addEventListener('click', function () {
    if (loginPolling) { say('登录流程进行中，请先在浏览器完成扫码', true); return; }
    loginBtn.disabled = true;
    var prev = loginBtn.textContent;
    loginBtn.textContent = '申请中…';
    say('正在申请登录链接…', true);
    fetch('/dsh-workbuddy-hub/login/start', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          say('发起登录失败：' + ((d && d.error) || '未知错误'), true);
          btnReset(); return;
        }
        say('已打开浏览器，请扫码授权（10 分钟内有效）', true);
        setStat('等待扫码…');
        pollLogin(d.loginId, Date.now() + (d.expiresIn || 600) * 1000);
      })
      .catch(function (e) { say('发起登录失败：' + (e && e.message ? e.message : e), true); btnReset(); });
    function btnReset() { loginBtn.disabled = false; loginBtn.textContent = prev; }
    function pollLogin(loginId, deadline) {
      loginPolling = true;
      (function once() {
        if (Date.now() > deadline) {
          loginPolling = false; btnReset(); setStat('');
          say('登录超时，请重新点击「登录新账号」', true);
          return;
        }
        fetch('/dsh-workbuddy-hub/login/poll?loginId=' + encodeURIComponent(loginId), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.done) {
              loginPolling = false; btnReset(); setStat('');
              if (d.error) { say('登录未完成：' + d.error, true); return; }
              var res = d.result || {};
              say('已登录并入库：' + (res.nickname || res.phone || res.uid || '新账号') + '，页面即将刷新', true);
              setTimeout(function () { location.reload(); }, 1500);
              return;
            }
            setStat('等待扫码…');
            setTimeout(once, 3000);
          })
          .catch(function () { setTimeout(once, 4000); });
      })();
    }
  });

  // 30 秒自动刷新页面数据。🔴 但登录轮询期间必须暂停 —— 否则页面会在扫码中途
  // reload，把轮询打断，用户永远等不到"已入库"的结果（本页最初就踩了这个坑）。
  function autoReload() {
    if (loginPolling) { setTimeout(autoReload, 5000); return; }   // 让路给登录
    location.reload();
  }
  setTimeout(autoReload, 30000);
})();
</script>
</body></html>`;
}

// ------------------------------------------------------------------- check-in
/**
 * 每日签到（自实现，不依赖 WorkDaddy）。
 *
 * 行为规则移植自 WorkDaddy 的 `checkin-result.js` / `daemon.js`（MIT 项目公开行为，
 * 此处按同样规则重写）：
 *
 *   端点  = {host}/billing/meter/daily-checkin  与  {host}/v2/billing/meter/daily-checkin
 *   host  = 由 accessToken 的 JWT `iss` 决定
 *   成功  = code === 0 且 HTTP ok，**或** code === 10001 且文案表明"今天已签到"
 *   排除  = 文案含"未开启/未开始/未开放/已过期/无活动"时不判成功
 *
 * Token 直接解密该账号自己的 `accounts/<uid>.info`（复用 vendor 的解密器），
 * 因此**不依赖 WorkDaddy 进程**，也能为"非当前登录"的账号签到。
 */
const CHECKIN_PATHS = ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin'];
const CHECKIN_TIMEOUT_MS = 12000;
const CHECKIN_LEDGER_PATH = path.join(DSH_DIR, 'workbuddy-checkin-ledger.json');
const ISSUER_HOST_MAP = new Map([
  ['https://www.workbuddy.ai', 'https://www.workbuddy.ai'],
  ['https://www.workbuddy.cn', 'https://www.workbuddy.cn'],
  ['https://www.codebuddy.cn', 'https://www.codebuddy.cn'],
  ['https://www.codebuddy.ai', 'https://www.codebuddy.ai'],
]);
const INACTIVE_MESSAGE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i;
const ALREADY_MESSAGE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already\s*(?:checked[- ]?in|claimed)|already/i;

function tokenIssuerOrigin(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return new URL(String(payload.iss || '')).origin.toLowerCase();
  } catch (e) { return null; }
}

/** 只有明确成功才算成功 —— HTTP 200 本身不够（网关可能返回空/非 JSON 的 200） */
function classifyCheckinResult({ httpOk, code, message }) {
  const hasCode = code !== null && code !== undefined && code !== '' && Number.isFinite(Number(code));
  const normalizedCode = hasCode ? Number(code) : null;
  const text = String(message || '');
  const inactive = INACTIVE_MESSAGE.test(text);
  const already = normalizedCode === 10001 && !inactive && ALREADY_MESSAGE.test(text);
  const ok = !inactive && ((normalizedCode === 0 && !!httpOk) || already);
  return { ok, already, inactive, code: normalizedCode, message: text };
}

function checkinEndpointsForToken(accessToken) {
  const iss = tokenIssuerOrigin(accessToken);
  const host = (iss && ISSUER_HOST_MAP.get(iss)) || 'https://www.workbuddy.cn';
  return CHECKIN_PATHS.map((p) => host + p);
}

/** 用某个 token 执行一次签到，依次尝试候选端点 */
async function dailyCheckin(accessToken, account) {
  const endpoints = checkinEndpointsForToken(accessToken);
  let lastErr = null;
  let first401 = null;
  for (const url of endpoints) {
    const origin = new URL(url).origin;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin,
          referer: origin + '/profile/plans-usage',
          authorization: 'Bearer ' + accessToken,
          'x-user-id': String((account && account.uid) || ''),
          'x-domain': String((account && account.domain) || ''),
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        },
        body: '{}',
        signal: AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
      });
      const text = await r.text();
      let o = {};
      try { o = JSON.parse(text); } catch (e) { /* non-JSON body */ }
      const failMsg = r.status === 401 ? '登录身份过期' : 'HTTP ' + r.status;
      const message = o.msg || o.message || (r.ok ? 'ok' : failMsg);
      const classified = classifyCheckinResult({ httpOk: r.ok, code: o.code, message });
      const result = Object.assign({}, classified, { status: r.status, url });
      if (classified.ok) return result;
      if (r.status === 401) { if (!first401) first401 = result; lastErr = result.message; continue; }
      if ((r.status >= 400 && r.status < 500 && r.status !== 404) || (r.ok && r.status !== 404)) return result;
      lastErr = result.message;
    } catch (e) {
      lastErr = (e && e.name === 'TimeoutError') ? `请求超时（${CHECKIN_TIMEOUT_MS / 1000} 秒）` : (e && e.message);
    }
  }
  if (first401) return first401;
  return { ok: false, already: false, code: -1, message: lastErr || '未知错误', url: endpoints[0] || null };
}

function loadCheckinLedger() {
  const doc = readJsonSync(CHECKIN_LEDGER_PATH, null);
  return doc && typeof doc === 'object' ? doc : {};
}

/**
 * 自有签到台账 → 展示用的 checkin 对象（与 WorkDaddy API 的字段对齐）。
 * 只在"今天的记录"有效时返回，避免把昨天的成功当今天的状态。
 */
function selfCheckinFor(uid, today, ledger) {
  const rec = ledger && ledger[uid];
  if (!rec || rec.date !== today) return null;
  return {
    ok: rec.ok === true,
    already: rec.already === true,
    code: rec.code === undefined ? null : rec.code,
    message: String(rec.message || ''),
    source: 'hub',
  };
}
function saveCheckinLedger(doc) {
  try {
    const fs = require('node:fs');
    const tmp = CHECKIN_LEDGER_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CHECKIN_LEDGER_PATH);
  } catch (e) { /* best effort */ }
}

/**
 * 对指定账号（缺省=全部备份账号）签到。
 * 结果写入自有台账（与 WorkDaddy 的 checkin-cache.json 字段兼容，便于互读）。
 */
async function runCheckin(uids) {
  const fs = require('node:fs');
  const targets = (Array.isArray(uids) && uids.length)
    ? uids
    : (() => {
      try { return listAllAccountUids(); }
      catch (e) { return []; }
    })();
  if (!targets.length) return { ok: false, error: '没有可签到的账号备份', results: [] };

  let vendor = null;
  try { vendor = await import('./vendor/connect-index.js'); } catch (e) { vendor = null; }
  if (!vendor || !vendor.WorkBuddyCredentialStore) {
    return { ok: false, error: '凭据解密器不可用（vendor 未加载）', results: [] };
  }

  const today = localDate(new Date());
  const ledger = loadCheckinLedger();
  const results = [];

  for (const uid of targets) {
    const file = accountFileFor(uid);
    if (!existsSync(file)) { results.push({ uid, ok: false, error: '备份不存在' }); continue; }

    const hit = ledger[uid];
    if (hit && hit.date === today && hit.ok === true) {
      results.push({ uid, ok: true, skipped: true, already: !!hit.already, message: hit.message || '今日已签到' });
      continue;
    }

    let cred = null;
    try {
      const store = new vendor.WorkBuddyCredentialStore({ variant: vendor.CN_VARIANT, desktopPath: file });
      cred = await store.readDesktop();
    } catch (e) { cred = null; }
    if (!cred || typeof cred.accessToken !== 'string') {
      results.push({ uid, ok: false, error: '凭据解密失败' });
      continue;
    }

    let r;
    try { r = await dailyCheckin(cred.accessToken, { uid, domain: cred.domain || '' }); }
    catch (e) { r = { ok: false, code: -1, message: (e && e.message) || '未知错误' }; }

    const rec = {
      date: today,
      ok: !!r.ok,
      already: !!r.already,
      inactive: !!r.inactive,
      code: r.code === undefined ? null : r.code,
      message: String(r.message || ''),
      at: Date.now(),
    };
    ledger[uid] = rec;
    results.push(Object.assign({ uid }, rec));
  }

  saveCheckinLedger(ledger);
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, today, total: results.length, okCount, results };
}

/**
 * 定时自动签到 —— 语义与 WorkDaddy 的 `daily-account-checkin` 任务一致。
 *
 * 该任务的原始定义（本机 `automations.json` 实测）：
 *   name        循环账号静默签到
 *   description 使用各账号 token 签到，不切换当前账号；跳过今日已签到账号。
 *               每小时、客户端加载和打开面板时检查。
 *   trigger     clientLoaded + panelOpened
 *   schedule    { type: "interval", minutes: 60 }
 *   steps       account.forEach(accounts=all, switch=false) → account.checkin
 *               每个账号包在 logic.catch（单账号失败不影响其他）
 *
 * 等价实现：
 *   · DSH 启动后立即跑一次（≈ clientLoaded）
 *   · 之后每 60 分钟一次（≈ schedule.interval）
 *   · 幂等与逐账号容错已在 runCheckin 内实现
 *   · 天然不切换当前登录账号（我们按账号解密凭据，不是切过去再签）
 */
const CHECKIN_INTERVAL_MS = 60 * 60 * 1000;
let checkinTimer = null;
let lastCheckinRun = null;

function startCheckinScheduler(ctx) {
  const tick = (reason) => {
    runCheckin(null).then((r) => {
      lastCheckinRun = { at: Date.now(), reason, okCount: r.okCount || 0, total: r.total || 0 };
      if (ctx.logger && ctx.logger.info) {
        ctx.logger.info(`[next-ui-diagnostic] hub checkin (${reason}): ${r.okCount || 0}/${r.total || 0} ok`);
      }
    }).catch((e) => {
      if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[next-ui-diagnostic] hub checkin failed: ' + (e && e.message));
    });
  };
  setTimeout(() => tick('startup'), 8 * 1000);   // ≈ clientLoaded
  checkinTimer = setInterval(() => tick('interval'), CHECKIN_INTERVAL_MS);   // ≈ interval 60m
  if (checkinTimer.unref) checkinTimer.unref();
  return () => { if (checkinTimer) { clearInterval(checkinTimer); checkinTimer = null; } };
}

// ------------------------------------------------------------ install self-check
/**
 * 安装自检 —— 专为「别人首次安装」设计的诊断。
 *
 * 动机：本机踩过的 A7 坑（WorkBuddy 装在非默认位置且无注册表项 → vendor 的三条
 * 发现路径全失效 → 凭据解不开 → 模型列表整组消失），用户体验是「就是没有模型，
 * 没有任何提示」。对公开发布而言这是**最致命的首次体验问题**。
 *
 * 因此这里主动检查，并给出**可直接照做的修复建议**。
 */
function runInstallSelfCheck() {
  const fs = require('node:fs');
  const out = {
    platform: process.platform,
    workbuddy: {
      envVar: 'WORKBUDDY_ELECTRON_BIN',
      envValue: process.env.WORKBUDDY_ELECTRON_BIN || '',
      envOk: false,
      defaultPath: path.join(LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      defaultPathOk: false,
      foundElsewhere: [],
      advice: '',
    },
    authFile: { path: LIVE_AUTH_PATH, exists: false, encrypted: false },
    ownedData: { dir: OWNED_DIR, accounts: listOwnedAccounts().length },
  };

  if (out.workbuddy.envValue) out.workbuddy.envOk = existsSync(out.workbuddy.envValue);
  out.workbuddy.defaultPathOk = existsSync(out.workbuddy.defaultPath);

  // 探测常见安装位置（覆盖「装在别的盘」这一最常见情形）
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const seg of ['Program Files', 'Program Files (x86)', '']) {
      const g = seg
        ? `${drive}:\\${seg}\\WorkBuddy\\WorkBuddy.exe`
        : `${drive}:\\WorkBuddy\\WorkBuddy.exe`;
      try { if (fs.existsSync(g)) out.workbuddy.foundElsewhere.push(g); } catch (e) { /* ignore */ }
    }
  }

  try {
    if (existsSync(LIVE_AUTH_PATH)) {
      out.authFile.exists = true;
      out.authFile.encrypted = require('node:fs').readFileSync(LIVE_AUTH_PATH, 'utf8').includes('"$wbEncrypted"');
    }
  } catch (e) { /* ignore */ }

  const found = out.workbuddy.envOk || out.workbuddy.defaultPathOk || out.workbuddy.foundElsewhere.length > 0;
  if (!out.authFile.exists) {
    out.workbuddy.advice = '未找到 WorkBuddy 登录文件：请先在 WorkBuddy 桌面端登录一次。'
      + '（期望路径：' + LIVE_AUTH_PATH + '）';
  } else if (!found) {
    out.workbuddy.advice = '未找到 WorkBuddy 程序（WorkBuddy.exe）。请把用户环境变量 WORKBUDDY_ELECTRON_BIN '
      + '设为机器上 WorkBuddy.exe 的完整路径，然后重启 DSH。'
      + '（必需原因：凭据解密要用 WorkBuddy 自带的 Electron 运行时。）';
  } else if (!out.workbuddy.envOk && !out.workbuddy.defaultPathOk && out.workbuddy.foundElsewhere.length) {
    out.workbuddy.advice = 'WorkBuddy 装在非默认位置：' + out.workbuddy.foundElsewhere[0]
      + '。建议把用户环境变量 WORKBUDDY_ELECTRON_BIN 设为该路径后重启 DSH。';
  } else {
    out.workbuddy.advice = 'ok';
  }

  // ---------------------------------------------------------------------------
  // 🔴 2026-10-14 v1.9.4（用户反馈「国际版没积分余额 + 模型列表没有 workbuddyai」）：
  // 两个问题**同一根因** —— 国际版缺环境变量 `WORKBUDDY_AI_ELECTRON_BIN`。
  //
  // 国际版 provider 与凭据解密都需要它自己的 Electron 二进制：
  //   · 找不到 → provider 报 electron-binary-unavailable → 模型列表无 workbuddy-ai
  //   · 找不到 → 凭据解不开 → 实时额度取不到
  // 国际版常装在非默认位置（如自定义目录），此时必须显式设这个变量。
  //
  // 这里把国际版也纳入自检，给出**可照做的建议**（与国内版同一套范式）。
  // ---------------------------------------------------------------------------
  const aiDefault = path.join(LOCALAPPDATA, 'Programs', 'WorkBuddy AI', 'WorkBuddyAI.exe');
  const aiFound = [];
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const seg of ['Program Files', 'Program Files (x86)', '']) {
      for (const sub of ['WorkBuddy AI\\WorkBuddyAI.exe', 'WorkBuddyAI\\WorkBuddyAI.exe']) {
        const g = seg ? `${drive}:\\${seg}\\${sub}` : `${drive}:\\${sub}`;
        try { if (fs.existsSync(g)) aiFound.push(g); } catch (e) { /* ignore */ }
      }
    }
  }
  out.workbuddyAI = {
    envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
    envValue: process.env.WORKBUDDY_AI_ELECTRON_BIN || '',
    envOk: false,
    defaultPath: aiDefault,
    defaultPathOk: false,
    foundElsewhere: aiFound,
    authPath: LIVE_AUTH_PATH_AI,
    authExists: existsSync(LIVE_AUTH_PATH_AI),
    advice: '',
  };
  if (out.workbuddyAI.envValue) out.workbuddyAI.envOk = existsSync(out.workbuddyAI.envValue);
  out.workbuddyAI.defaultPathOk = existsSync(out.workbuddyAI.defaultPath);

  const aiOk = out.workbuddyAI.envOk || out.workbuddyAI.defaultPathOk
    || out.workbuddyAI.foundElsewhere.length > 0;
  if (!aiOk && out.workbuddyAI.authExists) {
    // 登录过但找不到二进制 → 这是最容易被忽略的组合：模型/额度都会静默为 0
    out.workbuddyAI.advice = '国际版已登录，但找不到 WorkBuddy AI 的可执行文件。'
      + '请把用户环境变量 WORKBUDDY_AI_ELECTRON_BIN 设为 WorkBuddyAI.exe 的完整路径，然后重启 DSH。'
      + '（必需原因：模型列表注册与凭据解密都要用 WorkBuddy AI 自带的 Electron 运行时；'
      + '不设则模型列表里不会有 workbuddy-ai 分组、也取不到积分余额。）';
  } else if (!aiOk) {
    out.workbuddyAI.advice = 'ok-or-not-installed';
  } else if (!out.workbuddyAI.envOk && !out.workbuddyAI.defaultPathOk) {
    out.workbuddyAI.advice = 'WorkBuddy AI 装在非默认位置：' + out.workbuddyAI.foundElsewhere[0]
      + '。建议把用户环境变量 WORKBUDDY_AI_ELECTRON_BIN 设为该路径后重启 DSH。';
  } else {
    out.workbuddyAI.advice = 'ok';
  }

  return out;
}

// ------------------------------------------------------- owned data directory
/**
 * hub 自持数据目录 —— 让插件真正独立于 WorkDaddy。
 *
 * 背景（2026-10-11 用户实测发现）：账号凭据、手机号、用量**原本都存在 WorkDaddy
 * 的数据目录里**，hub 只是"读"它们。所以 WorkDaddy 的**进程**停了 hub 没事，
 * 但它的**目录**不在时 hub 就无数据可用（用户截图实证："未检测到 WorkDaddy 数据目录"）。
 *
 * 本目录接管关键数据，使卸载 WorkDaddy 后 hub 仍可用：
 *   accounts/<uid>.info   账号凭据（切号与签到的源）—— 首次从 WorkDaddy 迁移，
 *                         之后由「无感登录」直接写入这里
 *   accounts-index.json   uid → { nickname, phone, uin } 展示索引（替代 meta.json）
 *
 * 隐私：本目录含明文凭据（与 WorkDaddy 的 accounts/ 同级敏感），权限 0700/0600。
 */
const OWNED_DIR = path.join(DSH_DIR, 'workbuddy-data');
const OWNED_ACCOUNTS_DIR = path.join(OWNED_DIR, 'accounts');
const OWNED_INDEX_PATH = path.join(OWNED_DIR, 'accounts-index.json');
const OWNED_MIGRATED_FLAG = path.join(OWNED_DIR, '.migrated-from-workdaddy');

function ensureOwnedDirs() {
  const fs = require('node:fs');
  fs.mkdirSync(OWNED_ACCOUNTS_DIR, { recursive: true });
  try { fs.chmodSync(OWNED_DIR, 0o700); } catch (e) { /* best effort on Windows */ }
}

function loadOwnedIndex() {
  return readJsonSync(OWNED_INDEX_PATH, {}) || {};
}
function saveOwnedIndex(doc) {
  try {
    const fs = require('node:fs');
    ensureOwnedDirs();
    const tmp = OWNED_INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, OWNED_INDEX_PATH);
  } catch (e) { /* best effort */ }
}

/** 列出 hub 自持的账号 uid */
function listOwnedAccounts() {
  try {
    return require('node:fs').readdirSync(OWNED_ACCOUNTS_DIR)
      .filter((f) => f.endsWith('.info'))
      .map((f) => f.replace(/\.info$/, ''));
  } catch (e) { return []; }
}

/**
 * 首次迁移：把 WorkDaddy 的账号备份与手机号索引复制到自有目录。
 * 幂等（有标记文件即跳过）；**只读** WorkDaddy 侧，绝不改它。
 */
function migrateFromWorkDaddy(force) {
  const fs = require('node:fs');
  const result = { migrated: false, accounts: 0, indexed: 0, reason: '' };

  if (!force && existsSync(OWNED_MIGRATED_FLAG)) {
    result.reason = 'already-migrated';
    result.accounts = listOwnedAccounts().length;
    return result;
  }
  if (!existsSync(ACCOUNTS_DIR)) {
    result.reason = 'no-workdaddy-accounts';
    result.accounts = listOwnedAccounts().length;
    return result;
  }

  ensureOwnedDirs();
  try {
    for (const f of fs.readdirSync(ACCOUNTS_DIR)) {
      if (!f.endsWith('.info')) continue;
      const dst = path.join(OWNED_ACCOUNTS_DIR, f);
      if (existsSync(dst) && !force) continue;
      fs.copyFileSync(path.join(ACCOUNTS_DIR, f), dst);
      try { fs.chmodSync(dst, 0o600); } catch (e) { /* best effort */ }
      result.accounts++;
    }
  } catch (e) {
    result.reason = 'copy-failed: ' + e.message;
    return result;
  }

  // 积分缓存也复制过来（否则卸载 WorkDaddy 后积分显示 0）
  try {
    if (existsSync(CREDIT_CACHE_PATH)) {
      const dstCredit = path.join(OWNED_DIR, 'credit-cache.json');
      if (!existsSync(dstCredit) || force) {
        fs.copyFileSync(CREDIT_CACHE_PATH, dstCredit);
        result.credits = true;
      }
    }
  } catch (e) { /* credits best-effort */ }

  try {
    const doc = readJsonSync(META_PATH, null);
    if (doc) {
      const index = loadOwnedIndex();
      const seen = new Set();
      (function walk(o, depth) {
        if (!o || typeof o !== 'object' || depth > 10) return;
        if (!Array.isArray(o) && typeof o.phone === 'string' && o.phone) {
          const uid = String(o.uid || o.id || o.userId || '');
          const key = uid + '|' + o.phone;
          if (uid && !seen.has(key)) {
            seen.add(key);
            index[uid] = {
              uid,
              nickname: String(o.nickname || ''),
              phone: String(o.phone || ''),
              uin: String(o.uin || ''),
            };
            result.indexed++;
          }
        }
        for (const k of Object.keys(o)) { try { walk(o[k], depth + 1); } catch (e) { /* ignore */ } }
      })(doc, 0);
      saveOwnedIndex(index);
    }
  } catch (e) { /* index best-effort */ }

  try {
    fs.writeFileSync(OWNED_MIGRATED_FLAG, JSON.stringify(Object.assign({ at: Date.now() }, result)) + '\n', 'utf8');
  } catch (e) { /* ignore */ }
  result.migrated = true;
  if (!result.reason) result.reason = 'ok';
  return result;
}

/** 自有目录里是否已有账号（决定是否处于"独立模式"） */
function ownedModeActive() {
  return listOwnedAccounts().length > 0;
}

// ===========================================================================
// 国际版（WorkBuddy AI / workbuddy.ai）账号支持 —— 2026-10-14 v1.9.0
//
// 用户需求：「把国际版在这个插件登录也弄上，现在只能登录国内的」+「分成两组」。
//
// 现状（实测确认）：
//   · provider 层**已经**支持国际版（/health 实测 registered=["workbuddy","workbuddy-ai"]）
//   · vendor 层**两套变体都写好**（CN_VARIANT=workbuddy.exe / AI_VARIANT=workbuddyai.exe）
//   · 只有「账号台账 + 登录」这层硬编码了 CN_VARIANT，所以看不到/登不了国际版
//
// 与国内版**物理隔离**（照 global-vs-cn.md 的既有约定）：
//   accounts/     → 国际版 accounts-ai/      （独立目录）
//   accounts-index.json → accounts-index-ai.json
//   登录位 workbuddy-desktop.info → workbuddy-desktop-ai.info
//
// 本版本先落地「导入已登录的国际版账号」（用户选定方案 A）：国际版 App 已经登录时，
// 直接读它的凭据入库，立刻可在台账看到、可切号、可签到。**不做扫码登录新账号**
// （那需要国际版 OAuth 端点，属第二阶段）。
// ===========================================================================

const OWNED_DIR_AI = path.join(OWNED_DIR, 'ai');
const OWNED_ACCOUNTS_DIR_AI = path.join(OWNED_DIR_AI, 'accounts');
const OWNED_INDEX_PATH_AI = path.join(OWNED_DIR_AI, 'accounts-index.json');

/** 国际版 App 的官方登录位（vendor 的 AI_VARIANT.desktopFilename 决定这个 basename） */
const LIVE_AUTH_PATH_AI = path.join(
  LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'
);

function ensureOwnedDirsAI() {
  const fs = require('node:fs');
  fs.mkdirSync(OWNED_ACCOUNTS_DIR_AI, { recursive: true });
  try { fs.chmodSync(OWNED_DIR_AI, 0o700); } catch (e) { /* best effort */ }
}

function loadOwnedIndexAI() {
  return readJsonSync(OWNED_INDEX_PATH_AI, {}) || {};
}
function saveOwnedIndexAI(doc) {
  try {
    const fs = require('node:fs');
    ensureOwnedDirsAI();
    const tmp = OWNED_INDEX_PATH_AI + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, OWNED_INDEX_PATH_AI);
  } catch (e) { /* best effort */ }
}

/** 列出国际版自持账号 uid */
function listOwnedAccountsAI() {
  try {
    return require('node:fs').readdirSync(OWNED_ACCOUNTS_DIR_AI)
      .filter((f) => f.endsWith('.info'))
      .map((f) => f.replace(/\.info$/, ''));
  } catch (e) { return []; }
}

function accountFileForAI(uid) {
  return path.join(OWNED_ACCOUNTS_DIR_AI, String(uid) + '.info');
}

/**
 * 用 vendor 的 **AI_VARIANT** 读国际版凭据。
 *
 * 🔴 必须传 AI_VARIANT —— vendor 会做区域校验（credential-region-mismatch），
 * 而且 CN/AI 两侧的 at-rest 密钥来源不同（不同 Electron 二进制）。
 * 实测（2026-10-14）：AI_VARIANT + workbuddy-desktop-ai.info → 读到
 * accessToken/refreshToken/uid/nickname/domain=www.workbuddy.ai。
 *
 * @returns {Promise<{uid,nickname,phone,domain,accessToken,refreshToken,source}|null>}
 */
async function readGlobalCredentialFromApp() {
  const vendor = await loadVendor();
  if (!vendor || !vendor.WorkBuddyCredentialStore || !vendor.AI_VARIANT) return null;
  if (!existsSync(LIVE_AUTH_PATH_AI)) return null;
  const store = new vendor.WorkBuddyCredentialStore({
    variant: vendor.AI_VARIANT,
    desktopPath: LIVE_AUTH_PATH_AI,
  });
  const cred = await store.readDesktop();
  if (!cred || !cred.accessToken) return null;
  return {
    uid: String(cred.uid || ''),
    nickname: String(cred.nickname || ''),
    phone: String(cred.phoneNumber || cred.phone || ''),
    domain: String(cred.domain || ''),
    accessToken: String(cred.accessToken),
    refreshToken: String(cred.refreshToken || ''),
    source: 'app-desktop-ai',
  };
}

/**
 * 导入已在国际版 App 登录的账号 → 写入国际版自持目录。
 *
 * 幂等：同一 uid 重复导入会覆盖（凭据会刷新，覆盖是期望行为）。
 * 不改动国际版 App 的登录文件（纯读）。
 */
async function importGlobalAccount() {
  const out = { ok: false, imported: false, uid: '', nickname: '', region: 'global', reason: '' };
  let cred = null;
  try {
    cred = await readGlobalCredentialFromApp();
  } catch (e) {
    out.reason = '读取国际版凭据失败：' + ((e && e.message) || e);
    return out;
  }
  if (!cred) {
    out.reason = existsSync(LIVE_AUTH_PATH_AI)
      ? '国际版登录文件存在但读不出凭据（可能是从未登录 / 凭据已损坏）'
      : '未找到国际版登录文件：请先在国际版 WorkBuddy AI 桌面端登录一次';
    return out;
  }
  if (!cred.uid) {
    out.reason = '凭据里没有 uid，无法入库';
    return out;
  }

  try {
    const fs = require('node:fs');
    ensureOwnedDirsAI();
    // 复用国内版的凭据文件形状构造器（它只关心字段，与区域无关）
    // tokenData 需要 accessToken 等字段，这里按 vendor 的读取结果回填。
    const tokenData = {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      domain: cred.domain,
      tokenType: 'Bearer',
    };
    const accData = { uid: cred.uid, nickname: cred.nickname, phoneNumber: cred.phone };
    const session = buildSeamlessAuthFile(tokenData, accData);
    const dest = accountFileForAI(cred.uid);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dest);
    try { fs.chmodSync(dest, 0o600); } catch (e) { /* best effort */ }

    const index = loadOwnedIndexAI();
    index[cred.uid] = {
      uid: cred.uid,
      nickname: cred.nickname,
      phone: cred.phone,
      uin: '',
      region: 'global',
      domain: cred.domain,
      importedAt: Date.now(),
    };
    saveOwnedIndexAI(index);

    out.ok = true;
    out.imported = true;
    out.uid = cred.uid;
    out.nickname = cred.nickname;
    out.reason = 'ok';
    return out;
  } catch (e) {
    out.reason = '写入失败：' + ((e && e.message) || e);
    return out;
  }
}

/**
 * 组装国际版台账行（供 buildState 合并进返回体）。
 *
 * 刻意**不复用**国内版那套「WorkDaddy API + 实时额度 + 冷却台账」链路：
 * 那些是 WorkDaddy（国内工具）特有的，国际版没有对应进程。
 * 国际版这里只给「账号身份 + 签到状态 + 凭据有效性」，够用且不会误报。
 * 永不抛错。
 */
async function buildGlobalRows(model) {
  const rows = [];
  try {
    const uids = listOwnedAccountsAI();
    if (!uids.length) return rows;
    const index = loadOwnedIndexAI();
    const checkinLedger = loadCheckinLedger();
    const today = localDate(new Date());
    const current = await currentUidAIAsync();

    // 🔴 2026-10-14 v1.9.4（用户反馈「国际版没显示积分余额」）：
    // 上一版我写死 `creditsRealtimeError: '国际版暂不支持实时额度'` —— **那是错的**。
    // vendor 的 `billingBase(credential)` 早就按 `credential.domain` 分流：
    //   domain=workbuddy.ai → GLOBAL_BASE (https://www.workbuddy.ai)
    //   domain=workbuddy.cn / codebuddy.cn → CN_BILLING_BASE
    // 实测（2026-10-14）：用国际版凭据打 `workbuddy.ai/v2/billing/meter/get-user-resource`
    // → HTTP 200 / code 0 / 拿到套餐（剩余 250 / 总额 250）。
    // 所以国际版**完全能取额度**，之前取不到的真因是缺 `WORKBUDDY_AI_ELECTRON_BIN`
    // （解密凭据需要国际版自己的 Electron 二进制）。
    //
    // 现在与国内版同样处理：并发取每个账号的实时额度（best-effort，失败不影响台账）。
    const realtimeAI = new Map();
    try {
      const creds = [];
      for (const uid of uids) {
        const file = accountFileForAI(uid);
        if (!existsSync(file)) continue;
        try {
          const v = await loadVendor();
          if (!v || !v.WorkBuddyCredentialStore || !v.AI_VARIANT) continue;
          const store = new v.WorkBuddyCredentialStore({ variant: v.AI_VARIANT, desktopPath: file });
          const cred = await store.readDesktop();
          if (cred && cred.accessToken) {
            creds.push({ uid, accessToken: cred.accessToken, domain: cred.domain || 'www.workbuddy.ai' });
          }
        } catch (e) { /* 单个账号解密失败不影响其他 */ }
      }
      const pairs = await Promise.all(creds.map(async (c) => {
        const r = await fetchRealtimeCredits(c);
        return [String(c.uid), r];
      }));
      for (const [uid, r] of pairs) realtimeAI.set(uid, r);
    } catch (e) { /* 额度是增强项 */ }

    for (const uid of uids) {
      const meta = index[uid] || {};
      const file = accountFileForAI(uid);
      const authValid = existsSync(file);
      const rec = checkinLedger && checkinLedger.records
        ? checkinLedger.records.find((r) => String(r.uid) === String(uid) && r.region === 'global' && r.date === today)
        : null;
      rows.push({
        uid,
        region: 'global',
        phone: maskPhone(String(meta.phone || '')),
        nickname: maskNickname(String(meta.nickname || '')),
        isCurrent: uid === current,
        domain: String(meta.domain || ''),
        credits: 0,
        unlimited: false,
        soonestExpiry: null,
        soonestRemaining: null,
        creditSchedule: [],
        usedToday: 0,
        requestsToday: 0,
        modelsToday: {},
        // 实时额度（与国内版同一套接口，vendor 自动按 domain 选 base）
        ...realtimeFields(uid, realtimeAI),
        usageStale: true,
        usageKnown: false,
        authValid,
        tokenExpiresAt: null,
        refreshExpiresAt: null,
        lastRefreshTime: null,
        lastSeen: meta.importedAt || null,
        activityStreak: null,
        checkin: rec
          ? { ok: rec.ok === true, already: rec.already === true, code: rec.code === undefined ? null : rec.code, message: String(rec.message || ''), source: 'self' }
          : null,
        wdRateLimits: null,
        cooling: false,
        resetAt: null,
      });
    }
  } catch (e) { /* global rows are best-effort */ }
  return rows;
}

/** 国际版「当前登录账号」= 国际版 App 登录文件里的 uid（读 index 兜底） */
/**
 * 国际版「当前登录账号」= **读国际版 App 登录文件里的 uid**。
 *
 * 🔴 2026-10-14 v1.9.3（用户反馈「显示两个账号也不能切换」）：
 * 上一版的实现是「只有恰好 1 个账号时才标记当前」——那是**偷懒且错误**的：
 * 一旦导入了 2 个账号，就永远返回 ''，界面上两个都不标"DSH当前"，
 * 用户看不出哪个在用，也会觉得"切不了号"。
 *
 * 正确做法与国内版一致：**读官方登录位里的 uid**。
 * 国际版登录位是 `workbuddy-desktop-ai.info`（vendor 的 AI_VARIANT.desktopFilename）。
 * 该文件可能是：
 *   · 明文 JSON（我们自己切号写进去的）→ 直接取 "uid"
 *   · `$wbEncrypted` 密文（App 自己写的）→ 用 vendor 的 AI_VARIANT 解密
 */
function currentUidAI() {
  try {
    if (!existsSync(LIVE_AUTH_PATH_AI)) return '';
    const raw = readFileSync(LIVE_AUTH_PATH_AI, 'utf8');
    // ① 明文路径（含我们切号写入的结果）
    const m = raw.match(/"uid"\s*:\s*"([^"]+)"/);
    if (m && m[1]) return String(m[1]);
    return '';
  } catch (e) { return ''; }
}

/**
 * 国际版当前账号（带解密兜底）—— 供 buildGlobalRows 用。
 * 先试明文，再试 vendor 解密（App 自己写的凭据是 `$wbEncrypted`）。
 */
async function currentUidAIAsync() {
  const plain = currentUidAI();
  if (plain) return plain;
  try {
    const cred = await readGlobalCredentialFromApp();
    if (cred && cred.uid) return String(cred.uid);
  } catch (e) { /* decrypt best-effort */ }
  return '';
}

/**
 * 加载 vendor（带缓存）。
 * 原先 loadAllAccountCredentials 里每次 `await import(...)`；这里抽出来共用。
 */
let _vendorCache = null;
let _vendorCacheAt = 0;
async function loadVendor() {
  if (_vendorCache && (Date.now() - _vendorCacheAt) < 10 * 60 * 1000) return _vendorCache;
  try {
    _vendorCache = await import('./vendor/connect-index.js');
    _vendorCacheAt = Date.now();
  } catch (e) { _vendorCache = null; }
  return _vendorCache;
}

/**
 * 解析某个 uid 的账号备份文件路径：**自有目录优先，WorkDaddy 回退**。
 *
 * 这是"独立模式"的核心：一旦自有目录里有该账号，就用它；没有才去 WorkDaddy 找。
 * 这样迁移过的账号在 WorkDaddy 被卸载后仍然可用，而未迁移的仍能从旧位置读到。
 */
function accountFileFor(uid, opts) {
  const preferOwned = !(opts && opts.ownedOnly === false);
  const owned = path.join(OWNED_ACCOUNTS_DIR, String(uid) + '.info');
  if (existsSync(owned)) return owned;
  const legacy = path.join(ACCOUNTS_DIR, String(uid) + '.info');
  if (existsSync(legacy)) return legacy;
  // 都不存在时，返回写入目标（自有目录）——用于新建账号
  return preferOwned ? owned : legacy;
}

/** 列出所有可用账号 uid（自有 + WorkDaddy 合并去重） */
function listAllAccountUids() {
  const set = new Set();
  for (const u of listOwnedAccounts()) set.add(u);
  try {
    for (const f of require('node:fs').readdirSync(ACCOUNTS_DIR)) {
      if (f.endsWith('.info')) set.add(f.replace(/\.info$/, ''));
    }
  } catch (e) { /* WorkDaddy 侧不可用也没关系 */ }
  return Array.from(set);
}

// ------------------------------------------------------- self-contained switch
/**
 * 切号（不依赖 WorkDaddy 进程）。
 *
 * 移植自 WorkDaddy `lib.js` 的 `switchTo()` 语义（MIT 项目的公开行为，此处按
 * 同样的规则重写，不复制其代码）：
 *
 *   1. 源文件 = `<WorkDaddy数据目录>/accounts/<uid>.info`（账号备份）
 *   2. 校验备份里的 `account.uid` 与请求的 uid 一致 —— 不一致就中止，**绝不猜**
 *   3. 目标文件 = WorkBuddy 官方固定登录位（本项目已用 LIVE_AUTH_PATH 表示）
 *      WorkDaddy 的 `resolveAuthTarget()` 首条规则即：官方固定登录文件存在 →
 *      一律写它（带时间戳的历史存档写了官方也不读）
 *   4. 先写 .tmp 再 rename（原子替换），权限 0600
 *   5. 清理 `<target>.logged-out` 标记 —— 它存在时 WorkBuddy 会忽略该登录文件
 *
 * 为什么可以这样简化：本机是单一 CN 通道、官方登录位唯一（`workbuddy-desktop.info`），
 * 不涉及 WorkDaddy 处理的多通道/多存档歧义场景。若将来出现歧义，它会**报错而不是写错文件**。
 */
/**
 * 切号（自包含，不依赖 WorkDaddy 进程）。
 *
 * 🔴 2026-10-14 v1.9.0：参数化区域，支持国际版。
 *   · 不传 opts / opts.region==='cn' → 行为与以往**逐字一致**（国内版，写 workbuddy-desktop.info）
 *   · opts.region==='global'        → 读国际版自持目录，写 workbuddy-desktop-ai.info
 *
 * 国际版的登录位与国内版**不同**（vendor 的 AI_VARIANT.desktopFilename =
 * workbuddy-desktop-ai.info），写错位置国际版 App 读不到，等于没切。
 * 因此区域必须显式传递，不能猜。
 */
function selfContainedSwitch(uid, opts) {
  const fs = require('node:fs');
  const isGlobal = !!(opts && opts.region === 'global');
  const src = isGlobal ? accountFileForAI(uid) : accountFileFor(uid);
  if (!fs.existsSync(src)) throw new Error('未找到该账号的备份文件：' + src);

  const raw = fs.readFileSync(src, 'utf8');
  let doc = null;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error('账号备份不是合法 JSON'); }
  const acct = doc.account || (Array.isArray(doc.accounts) && doc.accounts[0]);
  if (!acct || String(acct.uid) !== String(uid)) {
    throw new Error('备份文件校验失败：uid 不匹配，已中止切换');
  }

  // 目标：官方固定登录位。若它不存在则先建立（首次切换场景）。
  const target = isGlobal ? LIVE_AUTH_PATH_AI : LIVE_AUTH_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const tmp = target + '.hubswitch.tmp';
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (e) { /* best effort on Windows */ }

  // 退役 logout 标记：它存在时 WorkBuddy 会忽略这个登录文件
  try {
    const marker = target + '.logged-out';
    if (fs.existsSync(marker)) fs.renameSync(marker, marker + '.retired.' + Date.now());
  } catch (e) { /* not fatal */ }

  return {
    uid,
    region: isGlobal ? 'global' : 'cn',
    // 只返回脱敏后的展示名；完整值不离开宿主进程
    nickname: maskNickname(String(acct.nickname || '')),
    uin: String(acct.uin || ''),
    authFile: target,
    note: 'builtin switch: copied '
      + (isGlobal ? 'ai/accounts/' : 'accounts/') + '<uid>.info onto the official sign-in file',
  };
}

// ------------------------------------------------------------ request helpers
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { try { req.destroy(); } catch (e) { /* ignore */ } resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * Mirror the live credential onto whatever path DSH actually reads.
 *
 * WorkDaddy writes WorkBuddy's auth file on switch; DSH may read a COPY
 * (WORKBUDDY_AUTH_FILE override), so that copy must be refreshed or the switch
 * never reaches DSH. Hard link first (so it keeps following by itself), then a
 * plain copy, restoring the backup if even that fails.
 */
function mirrorCredentialToDsh() {
  const target = process.env.WORKBUDDY_AUTH_FILE || '';
  if (!target) return 'not-needed (provider reads the live file itself)';
  if (path.resolve(target) === path.resolve(LIVE_AUTH_PATH)) return 'not-needed (already the live file)';
  if (!existsSync(target) || !existsSync(LIVE_AUTH_PATH)) return 'skipped (missing file)';
  const fs = require('node:fs');
  try {
    const a = fs.statSync(target);
    const b = fs.statSync(LIVE_AUTH_PATH);
    if (a.ino !== 0 && a.ino === b.ino) return 'hardlink-alive';
  } catch (e) { /* rewrite below */ }
  const backup = target + '.bak-' + Date.now();
  let moved = false;
  try { fs.renameSync(target, backup); moved = true; } catch (e) { /* ignore */ }
  try {
    fs.linkSync(LIVE_AUTH_PATH, target);
    if (moved) { try { fs.unlinkSync(backup); } catch (e) { /* keep */ } }
    return 'hardlink-created';
  } catch (e) {
    try {
      fs.copyFileSync(LIVE_AUTH_PATH, target);
      if (moved) { try { fs.unlinkSync(backup); } catch (e2) { /* keep */ } }
      return 'copied';
    } catch (e2) {
      if (moved) { try { fs.renameSync(backup, target); } catch (e3) { /* ignore */ } }
      return 'failed: ' + e2.message;
    }
  }
}

// ------------------------------------------------------------- login accounts
//
// WorkBuddy supports two ways to add an account. Both are surfaced here so the
// ball can drive them without the user opening WorkDaddy.
//
//   方式一 无感登录（免退出）—— implemented HERE, pure HTTP + file write:
//     ① POST {apiHost}/v2/plugin/auth/state?platform=workbuddy  -> state + auth URL
//     ② user approves by scanning in the SYSTEM BROWSER (WorkBuddy never quits)
//     ③ poll GET /v2/plugin/auth/token?state=...                -> accessToken
//     ④ GET /v2/plugin/login/account?state=...                  -> account info
//     ⑤ assemble the official auth document -> accounts/<uid>.info
//     The current sign-in is NEVER touched, so other accounts keep working.
//
//   方式二 假退出登录 —— forwarded to WorkDaddy as POST /api/logout.
//     It quits WorkBuddy, deletes the live auth file and relaunches to the login
//     page. That path needs CDP injection into the app (`codeBuddyNative.logout`)
//     plus process orchestration, which is WorkDaddy's own machinery; rewriting it
//     would mean carrying that whole layer, so we proxy instead.

const OAUTH_TIMEOUT_SECONDS = 600;
const OAUTH_RESULT_RETENTION_SECONDS = 300;
/** loginId -> { state, expiresAt, done, result, error, startedAt, region } */
const oauthStates = new Map();

/**
 * WorkBuddy API 端点 —— 国内 / 国际**两套**。
 *
 * 🔴 2026-10-14 v1.9.1（用户反馈「登录新账号弹出的是 workbuddy ai 网页，
 * 国内版登不了」）：
 *
 * 实测查证结论（不是推测）：
 *   ① 插件发出的请求确实打在 workbuddy.cn（`const WB_API_ENDPOINT` 一行未改）
 *   ② 服务端返回的 authUrl 也是 `https://www.workbuddy.cn/login?...`
 *   ③ **但国内登录页会把人导向国际站** → 用户在国内站上无法完成国内账号登录
 *   ④ 国际站 (`workbuddy.ai`) 的 OAuth 端点与国内**完全同构**：
 *      `POST /v2/plugin/auth/state?platform=workbuddy` → 返回
 *      `https://www.workbuddy.ai/login?platform=workbuddy&state=...`
 *
 * 关于 platform 参数：实测 5 个候选值（workbuddy / workbuddy-ai / workbuddyai /
 * ai / global）在 auth/state 与 auth/token **响应完全相同**（都返回 code 11217
 * "login ing..."），说明该参数在两端都**不区分站点**。
 * → 所以真正决定"登到哪个站"的是**端点域名本身**，platform 沿用 `workbuddy` 即可。
 *
 * 实现方式：把端点做成**按区域查表**，国内那套常量与取值**一字不改**
 * （`ENDPOINTS.cn.endpoint` 就是原来的 `https://www.workbuddy.cn`），
 * 国际版是**新增**的一行，绝不"拆东墙补西墙"。
 */
const WB_API_ENDPOINT = 'https://www.workbuddy.cn';   // 保留原名（国内），兼容既有引用
const WB_API_PREFIX = '/v2/plugin';
const OAUTH_PLATFORM = 'workbuddy';

const OAUTH_ENDPOINTS = {
  cn: {
    endpoint: WB_API_ENDPOINT,          // https://www.workbuddy.cn  ← 原值，未改
    prefix: WB_API_PREFIX,
    platform: OAUTH_PLATFORM,
    region: 'cn',
    label: 'WorkBuddy（国内版）',
  },
  global: {
    endpoint: 'https://www.workbuddy.ai', // ← 新增（实测确认可用）
    prefix: WB_API_PREFIX,
    platform: OAUTH_PLATFORM,
    region: 'global',
    label: 'WorkBuddy AI（国际版）',
  },
};

/** 取某区域的 OAuth 端点配置；未知区域一律回落到国内（保持旧行为） */
function oauthEndpointFor(region) {
  return region === 'global' ? OAUTH_ENDPOINTS.global : OAUTH_ENDPOINTS.cn;
}

/** normalise a seconds/milliseconds/string timestamp to ms; null when invalid */
function normTs(v) {
  let ts = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts < 1e10) ts *= 1000;
  return Math.round(ts);
}

/** JSON request with timeout (mirrors WorkDaddy's own httpJson helper). */
function httpJson(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: Object.assign(
        { 'User-Agent': 'dsh-workbuddy-hub', Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
        headers || {}
      ),
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { resolve({ code: res.statusCode, message: text.slice(0, 500) }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Assemble the official `workbuddy-desktop.info` shape from an OAuth token plus
 * the account document. Field names and preserved extras follow WorkDaddy's own
 * builder so the file stays indistinguishable from the app's.
 */
function buildSeamlessAuthFile(tokenData, accData) {
  const now = Date.now();
  const rawToken = tokenData && typeof tokenData === 'object' ? tokenData : {};
  const domain = String(rawToken.domain || '');

  let expiresAt = normTs(rawToken.expiresAt != null ? rawToken.expiresAt : rawToken.expires_at);
  if (expiresAt == null) {
    const expiresIn = Number(rawToken.expiresIn != null ? rawToken.expiresIn : rawToken.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = now + expiresIn * 1000;
  }
  let refreshExpiresAt = normTs(rawToken.refreshExpiresAt != null ? rawToken.refreshExpiresAt : rawToken.refresh_expires_at);
  if (refreshExpiresAt == null) {
    const rin = Number(rawToken.refreshExpiresIn != null ? rawToken.refreshExpiresIn : rawToken.refresh_expires_in);
    if (Number.isFinite(rin) && rin > 0) refreshExpiresAt = now + rin * 1000;
  }

  const accountObj = Object.assign({}, accData && typeof accData === 'object' ? accData : {}, {
    uid: String((accData && accData.uid) || ''),
    // ⚠️ 这里【必须】保留完整昵称/手机号 —— 本对象用于**写入磁盘**的账号备份
    // (accounts/<uid>.info)，脱敏会写出损坏的凭据文件，切号后无法登录。
    // 脱敏只施加在「离开宿主进程的展示数据」上（/state、/board、toast），
    // 绝不能施加在「落盘的凭据」上。二者的边界见 §十六。
    nickname: String((accData && accData.nickname) || ''),
    uin: (accData && accData.uin) || '',
    phoneNumber: (accData && accData.phoneNumber) || '',
    type: (accData && accData.type) || 'personal',
    lastLogin: true,
    pluginEnabled: true,
  });

  const authObj = Object.assign({}, rawToken, {
    accessToken: String(rawToken.accessToken || rawToken.access_token || ''),
    refreshToken: String(rawToken.refreshToken || rawToken.refresh_token || ''),
    tokenType: String(rawToken.tokenType || rawToken.token_type || 'Bearer'),
    domain,
    lastRefreshTime: now,
    scope: rawToken.scope || 'openid profile offline_access email',
    notBeforePolicy: rawToken.notBeforePolicy != null ? rawToken.notBeforePolicy : 0,
    sessionState: rawToken.sessionState || '',
  });
  if (expiresAt != null) {
    authObj.expiresAt = expiresAt;
    authObj.expiresIn = Math.max(0, Math.round((expiresAt - now) / 1000));
    authObj.refreshExpiresAt = refreshExpiresAt != null ? refreshExpiresAt : expiresAt;
    authObj.refreshExpiresIn = Math.max(0, Math.round((authObj.refreshExpiresAt - now) / 1000));
  } else {
    authObj.expiresIn = 0;
    authObj.refreshExpiresIn = 0;
  }

  // merge the existing allAccounts (dedup by uid) to match the official shape
  let all = [];
  try {
    const cur = JSON.parse(readFileSync(LIVE_AUTH_PATH, 'utf8'));
    const arr = cur.allAccounts || cur.accounts;
    if (Array.isArray(arr)) all = arr;
  } catch (e) { /* no current file */ }
  all = all.filter((a) => a && a.uid !== accountObj.uid);
  all.push(accountObj);

  return { account: accountObj, auth: authObj, accounts: all, allAccounts: all };
}

/**
 * 持久化刚授权的账号。
 *
 * 🔴 写入**自有目录**（`~/.dsh/workbuddy-data/accounts/`）而不是 WorkDaddy 的目录 ——
 * 这是"卸载 WorkDaddy 后仍可登录新账号"的关键。同时更新自有索引，
 * 使新账号立刻出现在台账里（含手机号），无需依赖 WorkDaddy 的 meta.json。
 *
 * @param {'cn'|'global'} [region] 默认 'cn'（不传 = 与以往行为一致）。
 *   国际版写入独立的 `workbuddy-data/ai/accounts/` + `accounts-index-ai.json`，
 *   **与国内版物理隔离**（不同 App、不同登录位、不同凭据语义）。
 */
function saveSeamlessAccount(tokenData, accData, region) {
  const uid = String((accData && accData.uid) || '');
  if (!uid) throw new Error('官方接口未返回 uid，无法保存账号');
  const fs = require('node:fs');
  const isGlobal = region === 'global';
  const accountsDir = isGlobal ? OWNED_ACCOUNTS_DIR_AI : OWNED_ACCOUNTS_DIR;
  if (isGlobal) ensureOwnedDirsAI(); else ensureOwnedDirs();
  const session = buildSeamlessAuthFile(tokenData, accData);
  const dest = path.join(accountsDir, uid + '.info');
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o600); } catch (e) { /* best effort */ }

  // 更新自有索引（昵称/手机号/uin）——台账直接用它显示
  try {
    const index = isGlobal ? loadOwnedIndexAI() : loadOwnedIndex();
    index[uid] = {
      uid,
      nickname: String((accData && accData.nickname) || ''),
      phone: String((accData && accData.phoneNumber) || ''),
      uin: String((accData && accData.uin) || ''),
      ...(isGlobal ? { region: 'global', domain: String(tokenData && tokenData.domain || ''), viaLogin: true } : {}),
    };
    if (isGlobal) saveOwnedIndexAI(index); else saveOwnedIndex(index);
  } catch (e) { /* index best-effort */ }

  return {
    uid,
    region: isGlobal ? 'global' : 'cn',
    nickname: (accData && accData.nickname) || '',
    phone: (accData && accData.phoneNumber) || '',
    dest,
  };
}

/** one poll of the authorisation result; persists the account on success */
async function oauthPollOnce(loginId) {
  const info = oauthStates.get(loginId);
  if (!info) return { done: true, error: '登录请求不存在或已过期' };
  if (info.done) return { done: true, result: info.result, error: info.error };
  if (Date.now() > info.expiresAt) {
    info.done = true;
    info.error = '登录超时，请重新发起';
    return { done: true, error: info.error };
  }
  // 🔴 v1.9.1：token / account 两步必须打在**发起时那个区域的端点**上。
  // 跨域会拿到"state 不存在"，表现为登录成功但入库失败。
  const ep = oauthEndpointFor(info.region);
  const tokenResp = await httpJson(
    `${ep.endpoint}${ep.prefix}/auth/token?state=${encodeURIComponent(info.state)}`,
    'GET'
  );
  const code = tokenResp && typeof tokenResp.code === 'number' ? tokenResp.code : -1;
  if (code !== 0 && code !== 200) return { done: false };
  const data = tokenResp.data || {};
  const accessToken = data.accessToken || data.access_token || '';
  if (!accessToken) return { done: false };

  const accHeaders = { Authorization: `Bearer ${accessToken}` };
  if (data.domain) accHeaders['X-Domain'] = data.domain;
  const accResp = await httpJson(
    `${ep.endpoint}${ep.prefix}/login/account?state=${encodeURIComponent(info.state)}`,
    'GET', null, accHeaders
  );
  const accData = (accResp && accResp.data) || {};
  info.done = true;
  try { info.result = saveSeamlessAccount(data, accData, info.region); }
  catch (e) { info.error = e.message; }
  return { done: true, result: info.result, error: info.error };
}

/**
 * start a seamless login: returns a loginId plus the URL the user must visit.
 *
 * @param {'cn'|'global'} [region] 默认 'cn' —— **不传时行为与以往逐字一致**。
 *   国内走 workbuddy.cn，国际走 workbuddy.ai（实测两端接口同构）。
 */
async function oauthStart(region) {
  const ep = oauthEndpointFor(region);
  const resp = await httpJson(
    `${ep.endpoint}${ep.prefix}/auth/state?platform=${ep.platform}`,
    'POST', {}
  );
  const d = (resp && resp.data) || {};
  if (!d.state) throw new Error('auth/state 响应缺少 state');
  const authUrl = d.authUrl || d.auth_url || d.url
    || `${ep.endpoint}/login/started?platform=${ep.platform}&state=${encodeURIComponent(d.state)}`;
  const loginId = 'hub_' + require('node:crypto').randomUUID().replace(/-/g, '');
  oauthStates.set(loginId, {
    state: d.state,
    region: ep.region,
    expiresAt: Date.now() + OAUTH_TIMEOUT_SECONDS * 1000,
    done: false, result: null, error: null, startedAt: Date.now(),
  });
  const timer = setTimeout(
    () => oauthStates.delete(loginId),
    (OAUTH_TIMEOUT_SECONDS + OAUTH_RESULT_RETENTION_SECONDS) * 1000
  );
  if (timer.unref) timer.unref();
  return { loginId, verificationUri: authUrl, expiresIn: OAUTH_TIMEOUT_SECONDS, region: ep.region };
}

/** open a URL in the system browser (rundll32 keeps it independent of cmd parsing) */
function openInBrowser(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) throw new Error('仅支持 http(s) 链接');
  if (process.platform === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', u], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
  }
}

// --------------------------------------------------------------- provider half
/**
 * Load the vendored provider bundle and let it register itself.
 *
 * The vendored code is dsh-workbuddy-connect (MIT) with only its relative import
 * rewritten. It brings its own `inject`, loopback shim, credential decryption and
 * catalog refresh — reimplementing that would have meant carrying the whole
 * kernel-adapter surface ourselves.
 */

// ---------------------------------------------------------------------------
// Electron 二进制自动探测（2026-10-14 v1.9.5）
//
// 与 vendor 的 `inspectWindowsElectronCandidate` **规则完全一致** ——
// 只有同时满足以下全部条件才算合格候选，避免选到 RepairApp.exe 之类的无关程序：
//   ① 文件名（大小写不敏感）等于期望的 exeBasename
//   ② 是普通文件且可执行
//   ③ 同目录存在 `version` 文件，且内容匹配 /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
//   ④ 同目录 `resources/` 里有 `app.asar`
// ---------------------------------------------------------------------------

/** vendor 的版本正则（逐字照抄，保持一致） */
const ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** 判断一个路径是不是「合规的 Electron 应用目录」并返回 exe 绝对路径；不合格返回 null */
function validateElectronCandidate(exePath, exeBasename) {
  try {
    const fs = require('node:fs');
    const pathMod = require('node:path');
    if (!exePath) return null;
    if (pathMod.basename(exePath).toLowerCase() !== String(exeBasename).toLowerCase()) return null;
    const st = fs.statSync(exePath);
    if (!st.isFile()) return null;
    try { fs.accessSync(exePath, fs.constants.X_OK); } catch (e) { return null; }
    const root = pathMod.dirname(exePath);
    const ver = fs.readFileSync(pathMod.join(root, 'version'), 'utf8').trim();
    if (!ELECTRON_VERSION_PATTERN.test(ver)) return null;
    if (!fs.readdirSync(pathMod.join(root, 'resources')).includes('app.asar')) return null;
    return exePath;
  } catch (e) { return null; }
}

/**
 * 从注册表卸载项的 DisplayIcon 里找 exe。
 * 与 vendor 的三条根 + DisplayName 正则 + DisplayIcon 去 `,N` 后缀的规则一致。
 */
function findElectronFromRegistry(displayNamePattern, exeBasename) {
  const pathMod = require('node:path');
  const fsMod = require('node:fs');
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let out = '';
    try {
      // 🔴 2026-10-14 v1.9.5 关键修正（真凶，查了很久）：
      //
      // 问题：**含中文的安装路径在读取注册表时会变成乱码**
      //   实测 `<盘>:\workbuddy<中文>\...` → `<盘>:\workbuddy???.???\...`（U+FFFD 替换符 77 个）
      //   → statSync ENOENT → 候选被拒 → 国际版探测失败 →
      //     模型列表无 workbuddy-ai 分组、积分余额也取不到。
      //
      // 根因：本机**系统代码页是 936（GBK）**，而注册表里该值是以 UTF-8 存储的。
      //   · `{ encoding: 'utf8' }` —— Node 按 UTF-8 解但底层经过了 console 代码页，中文坏的
      //   · `Buffer.toString('utf8')` —— 同样坏（实测 U+FFFD 77 个）
      //   · 这解释了"独立脚本跑却正常"的诡异现象（不同的 stdio 管道配置）
      //
      // ✅ 正解：**先用 `chcp 65001` 把 reg.exe 的输出代码页切成 UTF-8**，
      //    再按 UTF-8 解码。这样中英文路径都能正确读出。
      //    兜底：若 chcp 方案失败（老系统/受限环境），退回直接调 reg.exe；
      //    再兜底：解码后若仍含 U+FFFD，改用 GBK 再解一次并取"更像有效路径"的那个。
      const cp = require('node:child_process');
      const regExe = pathMod.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
      let buf = null;
      // 顺序：① 先试「直接调 reg.exe + 按需 GBK 兜底」（最稳、无引号/转义风险）
      //       ② 若解出来仍是乱码，再用 chcp 65001 强制 UTF-8 重试
      try {
        buf = cp.execFileSync(regExe, ['query', root, '/s'],
          { maxBuffer: 8 * 1024 * 1024, timeout: 6000, windowsHide: true });
        out = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        if (/\uFFFD/.test(out)) {
          // UTF-8 解出替换字符 → 试 GBK（本机系统代码页 936）
          try {
            const gbk = Buffer.isBuffer(buf) ? new TextDecoder('gbk').decode(buf) : null;
            if (gbk && !/\uFFFD/.test(gbk)) out = gbk;
          } catch (e2) { /* 保留 UTF-8 结果 */ }
        }
      } catch (e1) {
        out = '';
      }
      // ② 仍然不可用（空 或 有替换字符）→ 用 chcp 65001 强制 UTF-8 重试
      if (!out || /\uFFFD/.test(out)) {
        try {
          const cmdExe = process.env.ComSpec || 'cmd.exe';
          const line = 'chcp 65001 >nul & "' + regExe + '" query "' + root + '" /s';
          const b2 = cp.execFileSync(cmdExe, ['/d', '/c', line],
            { maxBuffer: 8 * 1024 * 1024, timeout: 8000, windowsHide: true });
          const s2 = Buffer.isBuffer(b2) ? b2.toString('utf8') : String(b2);
          if (s2 && !/\uFFFD/.test(s2)) out = s2;
        } catch (e2) { /* 保留前面的结果 */ }
      }
      if (!out) continue;
    } catch (e) { continue; }

    // 解析：按 HKEY 段分块，每块收集 DisplayName / DisplayIcon，
    // **全部读完再统一判定**（字段顺序不固定，见下方注释）
    const blocks = [];
    let cur = null;
    for (const line of String(out).split(/\r?\n/u)) {
      const keyM = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line);
      if (keyM) { cur = {}; blocks.push(cur); continue; }
      if (!cur) continue;
      const vM = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line);
      if (!vM) continue;
      if (vM[1].toLowerCase() === 'displayname') cur.displayName = vM[2];
      else cur.displayIcon = vM[2];
      // 🔴 2026-10-14 v1.9.5 修正：**绝不能在这里就判定**。
      // 注册表里字段顺序不固定 —— 实测 `WorkBuddy AI 5.7.6` 那块是：
      //   DisplayName → UninstallString → QuietUninstallString → DisplayVersion → DisplayIcon
      // 即 **DisplayIcon 出现在 DisplayName 之后 4 行**。
      // 若在拿到 DisplayName 时立刻检查，此时 displayIcon 还是 undefined，
      // 就永远不会匹配（这正是"国际版探测失败"的真因）。
      // ✅ 正解：把每个块收集起来，等所有行读完再统一判定（与 vendor 的
      //    parseWindowsRegistryOutput 做法一致）。
    }
    // 该根读完后，统一判定所有块
    for (const entry of blocks) {
      if (entry.displayName === undefined || entry.displayIcon === undefined) continue;
      if (!displayNamePattern.test(String(entry.displayName).trim())) continue;
      const cand = stripIconIndex(String(entry.displayIcon));
      const ok = validateElectronCandidate(cand, exeBasename);
      if (ok) return ok;
    }
  }
  return null;
}

/** 去掉 Windows DisplayIcon 值尾部的图标索引（`"X.exe",0` 或 `X.exe,0` → `X.exe`） */
function stripIconIndex(value) {
  const raw = String(value || '').trim();
  let p;
  if (raw.startsWith('"')) {
    const close = raw.indexOf('"', 1);
    if (close < 0) return null;
    const suffix = raw.slice(close + 1).trim();
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return null;
    p = raw.slice(1, close);
  } else {
    // 🔴 2026-10-14 v1.9.5 修正（真凶）：
    // 原写法 `/^(.*?)(?:,\d+)?$/` 是**懒惰匹配**：`(.*?)` 会尽量短、
    // 而 `(?:,\d+)?` 是可选的 → 正则引擎选择"让 `.*?` 吃到末尾、可选组不匹配"，
    // 于是 `,0` **根本没被剥掉** → 后续 statSync 拿到 `X.exe,0` → ENOENT。
    // 实测证据：捕获值 `<盘>:\...\WorkBuddyAI.exe,0`（含 `,0` 后缀未剥离）。
    // ✅ 正解：用**贪婪** `.*` 配一个**非可选**的尾部组；无后缀时另一分支兜底。
    const m = /^(.*),\d+$/u.exec(raw);
    p = m ? m[1].trim() : raw.trim();
  }
  return p || null;
}

/**
 * 自动探测两个 variant 的 Electron 二进制并写入 process.env。
 *
 * **只填空缺**：已存在的非空环境变量一律尊重，不覆盖（避免打断用户显式配置）。
 * 返回一个诊断对象（供日志/自检用）。
 */
function autoDetectElectronBin() {
  const log = [];
  const targets = [
    {
      env: 'WORKBUDDY_ELECTRON_BIN',
      exeBasename: 'workbuddy.exe',
      // 国内版 DisplayName 形如 `WorkBuddy 5.7.7`
      namePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      dirHints: ['WorkBuddy'],
    },
    {
      env: 'WORKBUDDY_AI_ELECTRON_BIN',
      exeBasename: 'workbuddyai.exe',
      // 国际版 DisplayName 形如 `WorkBuddy AI 5.7.6`（**注意与国内版正则必须区分开**）
      namePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      dirHints: ['WorkBuddy AI', 'WorkBuddyAI'],
    },
  ];
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const LOCALAPPDATA = process.env.LOCALAPPDATA || '';

  for (const t of targets) {
    const existing = process.env[t.env];
    if (existing && String(existing).trim() !== '' && fs.existsSync(String(existing).trim())) {
      log.push(t.env + ': 已存在且有效，尊重用户配置 → ' + existing);
      continue;
    }
    let found = null;
    // ① 默认安装位置
    for (const h of t.dirHints) {
      const cand = pathMod.join(LOCALAPPDATA, 'Programs', h, t.exeBasename);
      const v = validateElectronCandidate(cand, t.exeBasename);
      if (v) { found = v; break; }
    }
    // ② 注册表
    if (!found) {
      try { found = findElectronFromRegistry(t.namePattern, t.exeBasename); } catch (e) { /* continue */ }
    }
    // ③ 全盘常见位置扫描（覆盖装在别的盘 / 中文目录名）
    if (!found) {
      const drives = ['C', 'D', 'E', 'F', 'G'];
      const subdirs = ['', 'Program Files', 'Program Files (x86)'];
      const leafs = [];
      for (const h of t.dirHints) {
        leafs.push(h + '\\' + t.exeBasename);
        // 也支持 "父目录\子目录\exe" 这种两层结构
        leafs.push(h + '\\' + (t.exeBasename === 'workbuddyai.exe' ? 'WorkBuddyAI' : 'WorkBuddy') + '\\' + t.exeBasename);
      }
      outer:
      for (const d of drives) {
        for (const s of subdirs) {
          const base = s ? `${d}:\\${s}` : `${d}:\\`;
          for (const leaf of leafs) {
            const v = validateElectronCandidate(base + leaf, t.exeBasename);
            if (v) { found = v; break outer; }
          }
        }
      }
    }
    if (found) {
      process.env[t.env] = found;
      log.push(t.env + ': 自动探测成功 → ' + found + '（已注入 process.env，本次启动即生效）');
    } else {
      log.push(t.env + ': 未探测到合规的 ' + t.exeBasename);
    }
  }
  return log;
}

async function startProvider(ctx) {
  try {
    // -------------------------------------------------------------------------
    // 🔴 2026-10-14 v1.9.5：**自己探测并写入 process.env**，实现零配置。
    //
    // 问题（用户实测）：国际版 provider 报 `electron-binary-not-found` →
    // 模型列表没有 workbuddy-ai 分组、也取不到积分余额。
    //
    // 查证结论：
    //   · vendor 解凭据/注册 provider 都需要**该 variant 自己的 Electron 二进制**
    //   · 它读 `process.env[product.envVar]`（国内 WORKBUDDY_ELECTRON_BIN /
    //     国际 WORKBUDDY_AI_ELECTRON_BIN），**且 Config 里没有 electronPath 字段**
    //     → 环境变量是唯一注入途径
    //   · 但用户设了 User 级环境变量后**仍不生效**：因为 Windows 环境变量只对
    //     **新启动的进程**生效，而 DSH 继承自**已在运行的 explorer**（旧环境块）
    //   · 更糟的是：provider 的注册表自动发现**在本机也失败了**
    //     （注册表里明明有 `WorkBuddy AI 5.7.6` / DisplayIcon 指向正确 exe，
    //       用真 vendor 代码在 shell 里能通过检查，但在 DSH 进程内不行）
    //
    // ✅ 解法：Node 的 `process.env` 是**可写**的，而 vendor 在那个进程里读它。
    //    所以插件在加载 vendor 之前，自己把 exe 探测出来写进 process.env —— 
    //    等价于"替用户设好了环境变量"，**且立刻生效、不需要重启任何东西**。
    //
    // 探测顺序（与 vendor 的发现规则一致，确保不会选错）：
    //   ① 已存在的环境变量（尊重用户显式配置）
    //   ② 注册表卸载项的 DisplayIcon（遍历三条根）
    //   ③ 常见安装位置扫描（含中文目录名这种用户自定义路径）
    // 每个候选都要**通过布局校验**（exe + version 文件 + resources\app.asar），
    // 校验逻辑与 vendor 的 inspectWindowsElectronCandidate 完全一致。
    // -------------------------------------------------------------------------
    try {
      autoDetectElectronBin();
    } catch (e) {
      try { ctx.logger.warn('[next-ui-diagnostic] electron auto-detect failed: ' + ((e && e.message) || e)); }
      catch (e2) { /* ignore */ }
    }

    const vendor = await import('./vendor/connect-index.js');
    // Pass the REAL cordis context, not a derived object.
    //
    // An earlier revision used Object.create(ctx) to "isolate" the vendor. That
    // broke it: cordis's context is a callable proxy whose methods (inject, get,
    // effect, emit, logger…) live on the proxy itself, and a plain derivative
    // exposes none of them — the vendor then died on `ctx.inject is not a
    // function`. Both halves can share one context safely; their service needs
    // (webServer/llm/settings) are all injected by this plugin's own `inject`.
    const vendorCtx = ctx;
    // Keep the plugin's own routes working: the vendor registers its status/probe
    // routes on the SAME webServer, which is fine, but we must not let it replace
    // our /dsh-workbuddy-hub routes — different prefixes, so no clash.
    if (typeof vendor.apply !== 'function') {
      return { ok: false, reason: 'vendored bundle exports no apply()' };
    }

    // 🔴 MUST pass a config object.
    // The vendored apply() reads `config.authFile` / `config.authFileAI` while
    // building its per-variant runtimes, so calling it with no second argument
    // throws "Cannot read properties of undefined (reading 'authFile')".
    // In its original home cordis fills this from the Schemastery `Config`
    // schema; because we invoke apply() directly we have to do that ourselves.
    let cfg = {};
    try {
      if (typeof vendor.Config === 'function') cfg = vendor.Config({}) || {};
    } catch (e) {
      cfg = {};
    }

    vendor.apply(vendorCtx, cfg);

    // 🔴 Do NOT report success just because apply() did not throw.
    // The vendored code catches its own registration failure (it logs
    // "provider registration failed" and returns), so a missing `llm` service
    // produces a silent no-op. It also registers ASYNCHRONOUSLY, so give it a
    // few seconds before concluding, then verify against the real registry.
    const ids = ['workbuddy', 'workbuddy-ai'];
    let lastSeen = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        const llm = (ctx.get && ctx.get('llm')) || ctx.llm;
        if (llm && typeof llm.listProviders === 'function') {
          const found = llm.listProviders();
          const flat = Array.isArray(found)
            ? found.map((p) => (typeof p === 'string' ? p : (p && (p.id || p.provider)) || ''))
            : Object.keys(found || {});
          lastSeen = ids.filter((id) => flat.includes(id));
          if (lastSeen.length) break;
        } else if (llm) {
          // service is reachable but not enumerable: accept it as present
          lastSeen = ['<llm present, not enumerable>'];
          break;
        }
      } catch (e) { /* best-effort verification */ }
    }

    const ok = lastSeen.length > 0;
    return {
      ok,
      version: vendor.WORKBUDDY_CONNECT_VERSION || 'vendored',
      ...(ok ? { registered: lastSeen } : {
        reason: 'apply() ran but the LLM registry never reported our provider ids — '
          + 'the vendored half likely failed internally (check that `llm` is injected)',
      }),
    };
  } catch (e) {
    return { ok: false, reason: 'vendor load failed: ' + (e && e.message) };
  }
}

export function apply(ctx) {
  // ---- provider (转接) ----
  let providerState = { ok: false, reason: 'not started' };
  // startProvider is async; ctx.effect must stay synchronous, so it is kicked off
  // and its outcome is folded into /state + /health for visibility.
  startProvider(ctx).then((r) => {
    providerState = r;
    if (ctx.logger && ctx.logger.info) {
      ctx.logger.info(`[next-ui-diagnostic] workbuddy-hub provider ${r.ok ? 'registered' : 'FAILED: ' + r.reason}`);
    }
  });
  ctx.effect(() => () => { /* provider cleanup is owned by the vendored bundle */ }, 'dsh-workbuddy-hub: provider');

  // ---- 首次迁移：把 WorkDaddy 的账号与索引导入自有目录（幂等，只读 WD 侧） ----
  // 这是"卸载 WorkDaddy 后仍可用"的前提：此后账号凭据由 hub 自己持有。
  let migration = { migrated: false, reason: 'not-run' };
  try {
    migration = migrateFromWorkDaddy(false);
    if (ctx.logger && ctx.logger.info) {
      ctx.logger.info(`[next-ui-diagnostic] hub owned-data ${migration.migrated ? 'migrated' : 'unchanged'}`
        + ` (accounts=${migration.accounts}, indexed=${migration.indexed}, reason=${migration.reason})`);
    }
  } catch (e) {
    if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[next-ui-diagnostic] hub migration failed: ' + (e && e.message));
  }

  // ---- 定时自动签到（语义 = WorkDaddy 的 daily-account-checkin：启动时 + 每 60 分钟） ----
const stopCheckin = startCheckinScheduler(ctx);

  // ---- 限流主动探测（每 10 分钟一轮；撞到 429 自动登记，可用则清除记录） ----
  const stopProbe = startRateLimitProbe(ctx);
  ctx.effect(() => () => { try { stopProbe(); } catch (e) { /* ignore */ } }, 'dsh-workbuddy-hub: rate-limit probe');
  ctx.effect(() => () => { try { stopCheckin(); } catch (e) { /* ignore */ } }, 'dsh-workbuddy-hub: checkin schedule');

  // ---- ledger + control routes ----
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async function (req, res) {
      const url = String(req.url || '').split('?')[0];
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };

      if (url === ROUTE_PREFIX + '/state' || url === ROUTE_PREFIX + '/') {
        const model = (() => {
          try {
            const q = String(req.url || '').split('?')[1] || '';
            const m = new URLSearchParams(q).get('model');
            return m && m.trim() ? m.trim() : DEFAULT_MODEL;
          } catch (e) { return DEFAULT_MODEL; }
        })();
        try {
          const st = await buildState(model);
          st.provider = providerState;
          json(200, st);
        } catch (e) {
          json(200, { ok: false, available: false, reason: 'state build failed: ' + (e && e.message), rows: [], provider: providerState });
        }
        return;
      }

      if (url === ROUTE_PREFIX + '/board') {
        let html;
        try {
          const st = await buildState(DEFAULT_MODEL);
          st.provider = providerState;
          html = renderBoard(st);
        } catch (e) {
          html = '<!doctype html><meta charset="utf-8"><h3>board failed</h3><pre>' + esc(e && e.message) + '</pre>';
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (url === ROUTE_PREFIX + '/switch') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let body = '';
        try { body = await readBody(req); } catch (e) { body = ''; }
        let uid = '';
        let region = 'cn';
        try {
          const parsedBody = JSON.parse(body || '{}');
          uid = String(parsedBody.uid || '').trim();
          region = String(parsedBody.region || 'cn').trim().toLowerCase() === 'global' ? 'global' : 'cn';
        } catch (e) { uid = ''; }
        if (!uid) { json(400, { ok: false, error: '缺少 uid' }); return; }
        // 🔴 国际版张号走独立路径：WorkDaddy API 是**国内工具**，它不认识国际版账号，
        // 把国际版 uid 丢给它只会失败或误操作。国际版一律直接走自包含切换。
        const isGlobalSwitch = region === 'global';
        // 首选 WorkDaddy API（它会做额外的元数据同步与一致性校验）；
        // 不可用时回落到本插件自己的文件级切换，使切号不再依赖 WorkDaddy 进程。
        const token = isGlobalSwitch ? null : wdApiToken();
        let outcome = null;
        let via = '';
        if (token) {
          try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 30000);
            const res2 = await fetch(`http://127.0.0.1:${wdApiPort()}/api/switch`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-workdaddy-token': token },
              body: JSON.stringify({ uid }),
              signal: ctl.signal,
            });
            clearTimeout(timer);
            const text = await res2.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
            outcome = { status: res2.status, ok: res2.ok, data: parsed, raw: text.slice(0, 400) };
            via = 'workdaddy-api';
          } catch (e) {
            outcome = null;   // fall through to the self-contained path
          }
        }
        if (!outcome) {
          // ---- self-contained switch (no WorkDaddy process required) ----
          try {
            const r = selfContainedSwitch(uid, { region });
            outcome = { status: 200, ok: true, data: r, raw: '' };
            via = 'builtin';
          } catch (e) {
            json(500, {
              ok: false,
              uid,
              region,
              via: 'none',
              error: '切号失败：' + (e && e.message),
            });
            return;
          }
        }

        let mirror = 'skipped';
        // 🔴 国际版不做「镜像到 DSH」：那个镜像逻辑针对国内版的
        // WORKBUDDY_AUTH_FILE / workbuddy-desktop.info；国际版 provider 读的是
        // AI_VARIANT 自己的路径，镜像到国内路径反而会写错文件。
        if (!isGlobalSwitch) {
          try { mirror = mirrorCredentialToDsh(); } catch (e) { mirror = 'failed: ' + (e && e.message); }
        } else {
          mirror = 'not-applicable (global variant reads its own path)';
        }
        json(outcome.ok ? 200 : 502, {
          ok: outcome.ok,
          uid,
          region,
          via,
          workdaddy: outcome,
          credentialMirror: mirror,
          hint: outcome.ok
            ? (via === 'builtin'
              ? (isGlobalSwitch
                ? '已用内置切号逻辑切换到该国际版账号（写入 workbuddy-desktop-ai.info）。请重启国际版 WorkBuddy AI 生效。'
                : '已用内置切号逻辑切换到该账号，并把凭据同步给 DSH。')
              : '已切换到该账号，并把凭据同步给 DSH 正在读的路径。')
            : '拒绝切换，详情见响应字段。',
        });
        return;
      }

      if (url === ROUTE_PREFIX + '/open') {
        const port = (() => {
          try { return ctx.get && ctx.get('webServer') && ctx.get('webServer').port; } catch (e) { return null; }
        })() || (() => { try { return ctx.webServer && ctx.webServer.port; } catch (e) { return null; } })();
        if (!port) { json(500, { ok: false, error: 'webServer port unavailable' }); return; }
        const openUrl = 'http://127.0.0.1:' + port + ROUTE_PREFIX + '/board';
        let launched = false, how = '';
        try {
          if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', openUrl], { detached: true, stdio: 'ignore' }).unref();
            how = 'cmd start';
          } else if (process.platform === 'darwin') {
            spawn('open', [openUrl], { detached: true, stdio: 'ignore' }).unref();
            how = 'open';
          } else {
            spawn('xdg-open', [openUrl], { detached: true, stdio: 'ignore' }).unref();
            how = 'xdg-open';
          }
          launched = true;
        } catch (e) { how = 'failed: ' + (e && e.message); }
        json(launched ? 200 : 500, { ok: launched, url: openUrl, via: how });
        return;
      }

      // ------------------------------------------------ seamless login (新增)
      // 🔴 2026-10-14 v1.9.0：国际版（WorkBuddy AI）账号导入。
      //
      // 方案 A（用户选定）：国际版 App 已经登录时，**直接读它的凭据入库**，
      // 立刻能在台账看到、可切号、可签到。不需要国际版 OAuth 端点，
      // 因此不依赖任何猜测（实测 AI_VARIANT 可读 workbuddy-desktop-ai.info）。
      //
      // 纯读国际版 App 的登录文件，**不改动它**（与国内版「无感登录」同样的安全边界）。
      if (url === ROUTE_PREFIX + '/global/import') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        try {
          const r = await importGlobalAccount();
          json(r.ok ? 200 : 400, Object.assign({ region: 'global' }, r, {
            hint: r.ok
              ? '已把国际版当前登录账号导入台账（国际版 App 的登录状态未被改动）。'
              : '请先在国际版 WorkBuddy AI 桌面端登录一次，再点「导入国际版账号」。',
          }));
        } catch (e) {
          json(500, { ok: false, error: '导入国际版账号失败：' + ((e && e.message) || e) });
        }
        return;
      }

      // 国际版账号状态（供 UI 显示"国际版 App 是否已登录 / 已导入几个"）
      if (url === ROUTE_PREFIX + '/global/status') {
        try {
          const index = loadOwnedIndexAI();
          json(200, {
            ok: true,
            region: 'global',
            appSignedIn: existsSync(LIVE_AUTH_PATH_AI),
            authPath: LIVE_AUTH_PATH_AI,
            accounts: listOwnedAccountsAI().length,
            index: Object.keys(index).map((uid) => ({
              uid,
              nickname: maskNickname(String(index[uid].nickname || '')),
              phone: maskPhone(String(index[uid].phone || '')),
              domain: String(index[uid].domain || ''),
            })),
          });
        } catch (e) {
          json(500, { ok: false, error: '读取国际版状态失败：' + ((e && e.message) || e) });
        }
        return;
      }

      // 方式一：无感登录（免退出）。实现与 WorkDaddy 的 /api/oauth/* 等价，
      // 但完全由本插件承担 —— 纯 HTTP + 写 accounts/<uid>.info，不碰当前登录文件。
      //
      // 🔴 v1.9.1：支持 `?region=cn|global`。
      // **不传 region 时等价于 cn（国内），行为与以往逐字一致** —— 这是硬约束，
      // 因为用户明确要求"不能拆东墙补西墙"。
      if (url === ROUTE_PREFIX + '/login/start') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let region = 'cn';
        try {
          const q = String(req.url || '').split('?')[1] || '';
          const rq = new URLSearchParams(q).get('region');
          if (String(rq || '').toLowerCase() === 'global') region = 'global';
        } catch (e) { region = 'cn'; }
        try {
          const r = await oauthStart(region);
          let opened = false, openError = '';
          try { openInBrowser(r.verificationUri); opened = true; }
          catch (e) { openError = e && e.message; }
          json(200, Object.assign({ ok: true, opened }, openError ? { openError } : {}, r, {
            hint: region === 'global'
              ? '请在浏览器完成国际版（workbuddy.ai）扫码授权；本插件会自动轮询并入库（不改动当前登录）。'
              : '请在浏览器完成扫码授权；本插件会自动轮询并入库（不改动当前登录）。',
          }));
        } catch (e) {
          json(502, { ok: false, error: '发起无感登录失败：' + (e && e.message), region });
        }
        return;
      }

      if (url === ROUTE_PREFIX + '/login/poll') {
        let loginId = '';
        try { loginId = new URLSearchParams(String(req.url || '').split('?')[1] || '').get('loginId') || ''; } catch (e) { /* ignore */ }
        if (!loginId) { json(400, { ok: false, error: '缺少 loginId' }); return; }
        try {
          const r = await oauthPollOnce(loginId);
          json(200, Object.assign({ ok: true }, r));
        } catch (e) {
          json(502, { ok: false, error: '轮询失败：' + (e && e.message) });
        }
        return;
      }

      // 方式二：假退出登录 —— 转发给 WorkDaddy（它依赖 CDP 注入，重写不值当）
      if (url === ROUTE_PREFIX + '/login/logout') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        const token = wdApiToken();
        if (!token) { json(500, { ok: false, error: '假退出登录需要 WorkDaddy 支持，当前未安装' }); return; }
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 90000);
          const r2 = await fetch(`http://127.0.0.1:${wdApiPort()}/api/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-workdaddy-token': token },
            signal: ctl.signal,
          });
          clearTimeout(timer);
          const text = await r2.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          json(r2.ok ? 200 : 502, {
            ok: r2.ok,
            via: 'workdaddy',
            workdaddy: { status: r2.status, data: parsed, raw: text.slice(0, 300) },
            hint: r2.ok
              ? '已退出并重启 WorkBuddy（token 仍保留在账号备份里），请在应用登录页扫码登录新账号。'
              : '切换被拒绝，详情见响应字段。',
          });
        } catch (e) {
          json(502, { ok: false, error: '假退出登录失败：' + (e && e.message) });
        }
        return;
      }

      // 在系统浏览器打开任意 http(s) 链接（登录授权页等）
      if (url === ROUTE_PREFIX + '/open-url') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let b = '';
        try { b = await readBody(req); } catch (e) { b = ''; }
        let u = '';
        try { u = String((JSON.parse(b || '{}')).url || ''); } catch (e) { u = ''; }
        try { openInBrowser(u); json(200, { ok: true }); }
        catch (e) { json(400, { ok: false, error: e && e.message }); }
        return;
      }

      // ----------------------------------------------------------- check-in
      // 自实现签到（不依赖 WorkDaddy）：逐账号解密凭据 → 调官方签到 API → 落台账
      if (url === ROUTE_PREFIX + '/checkin') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let body = '';
        try { body = await readBody(req); } catch (e) { body = ''; }
        let uids = [];
        try {
          const b = JSON.parse(body || '{}');
          if (Array.isArray(b.uids)) uids = b.uids.map((x) => String(x));
          else if (b.uid) uids = [String(b.uid)];
        } catch (e) { /* all accounts */ }
        try {
          const r = await runCheckin(uids);
          json(200, r);
        } catch (e) {
          json(500, { ok: false, error: '签到执行失败：' + (e && e.message) });
        }
        return;
      }

      if (url === ROUTE_PREFIX + '/checkin/state') {
        json(200, {
          ok: true,
          ledger: loadCheckinLedger(),
          today: localDate(new Date()),
          schedule: {
            enabled: !!checkinTimer,
            intervalMinutes: CHECKIN_INTERVAL_MS / 60000,
            lastRun: lastCheckinRun,
          },
        });
        return;
      }

      // 安装自检：给「首次安装不知道为何没模型」的用户一个明确答案
      if (url === ROUTE_PREFIX + '/selfcheck') {
        json(200, { ok: true, selfCheck: runInstallSelfCheck() });
        return;
      }

      // ---------------------------------------------- rate-limit ledger
      /**
       * 手动/自动登记一次限流。
       *
       * 这是"让 CD 登记真正闭环"的关键入口：当 DSH 因为 429 报错时，把**报错原文**
       * POST 到这里即可自动解析账号与解禁时间并入库（无需再手敲命令行）。
       * body: { text?, uid?, model?, status? }
       */
      if (url === ROUTE_PREFIX + '/ledger/record') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let body = '';
        try { body = await readBody(req); } catch (e) { body = ''; }
        let b = {};
        try { b = JSON.parse(body || '{}'); } catch (e) { b = {}; }
        const text = String(b.text || b.rawText || '');
        const model = String(b.model || DEFAULT_MODEL);
        let uid = String(b.uid || '').trim();
        // 未给 uid 时默认记到「当前登录账号」——429 总是发生在正在用的号上
        if (!uid) { try { uid = currentUid() || ''; } catch (e) { uid = ''; } }
        if (!uid) { json(400, { ok: false, error: '无法确定 uid（未提供且读不到当前登录账号）' }); return; }
        const rec = recordRateLimit(uid, model, b.status || 429, text, b.source || 'api');
        json(rec.ok ? 200 : 500, Object.assign({ ok: rec.ok, model }, rec));
        return;
      }

      // 手动触发一轮限流探测（不必等定时器）
      if (url === ROUTE_PREFIX + '/ledger/probe') {
        if (req.method !== 'POST') { json(405, { ok: false, error: 'POST required' }); return; }
        let body = '';
        try { body = await readBody(req); } catch (e) { body = ''; }
        let b = {};
        try { b = JSON.parse(body || '{}'); } catch (e) { b = {}; }
        try {
          const r = await runRateLimitProbe(b.model || DEFAULT_MODEL);
          json(200, r);
        } catch (e) {
          json(500, { ok: false, error: '探测失败：' + (e && e.message) });
        }
        return;
      }

      // 列出 / 清理台账（便于排查与手动纠正）
      if (url === ROUTE_PREFIX + '/ledger') {
        if (req.method === 'POST' || /[?&]clear=1/.test(url)) {
          try {
            const fs = require('node:fs');
            const doc = loadLedger();
            const now = Date.now();
            const kept = (doc.records || []).filter((r) => r && Number(r.resetAt) > now);
            fs.writeFileSync(LEDGER_PATH, JSON.stringify({ version: 1, updatedAt: now, records: kept }, null, 2) + '\n', 'utf8');
            json(200, { ok: true, removed: (doc.records || []).length - kept.length, kept: kept.length });
          } catch (e) { json(500, { ok: false, error: (e && e.message) || 'clear failed' }); }
          return;
        }
        const now = Date.now();
        const doc = loadLedger();
        const records = (doc.records || []).map((r) => ({
          uid: String(r.uid || '').slice(0, 8),
          model: r.model,
          resetAt: r.resetAt,
          cooling: Number(r.resetAt) > now,
          source: r.source,
          observedAt: r.observedAt,
        }));
json(200, {
          ok: true,
          records,
          coolingCount: records.filter((r) => r.cooling).length,
          probe: { enabled: !!probeTimer, intervalMinutes: PROBE_INTERVAL_MS / 60000, lastRun: lastProbeRun },
        });
        return;
      }

      if (url === ROUTE_PREFIX + '/health') {
        json(200, {
          ok: true,
          plugin: name,
          provider: providerState,
          ownedData: {
            dir: OWNED_DIR,
            accounts: listOwnedAccounts().length,
            independent: ownedModeActive(),
          },
          selfCheck: runInstallSelfCheck(),
        });
        return;
      }

      json(404, {
        error: 'not found',
        routes: [ROUTE_PREFIX + '/state', ROUTE_PREFIX + '/board', ROUTE_PREFIX + '/switch',
          ROUTE_PREFIX + '/login/start', ROUTE_PREFIX + '/login/poll', ROUTE_PREFIX + '/login/logout',
          ROUTE_PREFIX + '/global/import', ROUTE_PREFIX + '/global/status',
          ROUTE_PREFIX + '/open', ROUTE_PREFIX + '/open-url', ROUTE_PREFIX + '/health'],
      });
    },
  });

  ctx.effect(() => () => dispose(), 'dsh-workbuddy-hub: routes');
  if (ctx.logger && ctx.logger.info) ctx.logger.info('dsh-workbuddy-hub: ready at ' + ROUTE_PREFIX);
}
