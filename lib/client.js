window.__ModuleLoader__.load({
  id: "dsh-workbuddy-hub",
  factory: function (require) {
  var module = { exports: {} };
  var exports = module.exports;

  // ---------------------------------------------------------------------------
  // WorkBuddyBall — draggable floating ball + slide-in drawer for the WorkBuddy
  // multi-account ledger (phone / daily credits / flash cooldown / next to use).
  //
  // Hard-won rules this file obeys (dsh-config plugin-development SKILL.md):
  //   * 7.14  — NO iframe: the desktop shell blocks sub-frames, and a failed
  //             iframe still fires `load` (silent blank). We render native DOM
  //             and fetch ROOT-RELATIVE paths only.
  //   * 7.6.3 — the ball must be position:fixed with a static, pointer-events
  //             none container, else Electron offsets/blocks it.
  //   * 7.15  — never hardcode colours: use --dsw-alias-* tokens with neutral
  //             grey fallbacks, so light and dark themes both stay readable.
  //   * 7.10.3— intercept mousedown on our own interactive elements so the
  //             host's outside-close / blur gates never swallow the click.
  // ---------------------------------------------------------------------------

  var HOST = "/dsh-workbuddy-hub";
  var BALL_SIZE = 54;
  var POS_KEY = "dsh-workbuddy-hub.pos.v1";
  var OPEN_KEY = "dsh-workbuddy-hub.open.v1";
  var POLL_MS = 30000;
  var MODEL = "deepseek-v4.1-flash";
  /**
   * Star 直达目标。仓库尚未创建时点击会走到 404，因此按钮在 REPO_READY
   * 为 false 时仍可用，但提示会说明"仓库尚未发布"，避免被误判成插件故障。
   * 发布后把 REPO_READY 改成 true 即可。
   */
  var REPO_URL = "https://github.com/loyalchiiina/dsh-workbuddy-hub";
  var REPO_READY = true;

  // WorkDaddy mark (the app the ledger data comes from), inlined so the ball
  // never depends on a network or file read for its icon.
  var ICON_SVG =
    '<svg viewBox="0 0 36 36" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M20.9906 0.749905C21.2671 0.501943 21.2839 0.492544 21.4868 0.480364C21.8155 0.456367 22.1168 0.613756 22.6293 1.08032C23.8268 2.16857 25.4945 4.40663 26.5313 6.31727L26.9319 7.05801L27.497 7.33954C28.0431 7.61551 28.9398 8.18131 29.314 8.48483C29.4833 8.62479 29.5069 8.62785 29.683 8.55938C30.4771 8.25011 31.6152 8.66001 32.6186 9.62266C33.5218 10.4883 34.3864 11.9675 34.7179 13.202C34.7663 13.4007 34.8304 13.8282 34.8538 14.1463C34.9294 15.2633 34.571 16.1556 33.8812 16.5594C33.7407 16.6406 33.7313 16.6629 33.7352 17.0136C33.767 18.6863 33.316 20.3563 32.4104 21.9845C31.3878 23.8129 29.567 25.7049 27.1028 27.4868C25.7795 28.4498 22.6486 30.2737 21.2331 30.914C17.8423 32.4406 15.124 33.0265 12.7628 32.7372C11.3545 32.5665 9.76077 32.0165 8.81752 31.3784C8.56924 31.2068 8.52956 31.1962 8.33994 31.2504C7.33017 31.5405 6.00784 30.9439 4.88436 29.6968C4.43627 29.1982 3.71256 27.9746 3.47813 27.3197C2.93596 25.7871 3.04369 24.4039 3.76587 23.5779C3.95253 23.3651 3.95911 23.356 3.91833 22.9982C3.85104 22.4127 3.82028 21.5464 3.85099 20.987L3.87519 20.4645L3.09052 19.0761C1.87585 16.9147 1.10489 15.0997 0.807219 13.7131C0.650067 12.9527 0.659309 12.6151 0.852335 12.3655C0.970002 12.2148 1.35547 12.0584 1.81974 11.9727C2.98906 11.7675 5.53887 11.9539 8.37556 12.4547L8.67086 12.5052L9.31816 11.933C10.3933 10.9807 11.1076 10.4465 12.4243 9.62549C13.7967 8.76684 15.3456 8.06062 17.0898 7.50131L17.6491 7.32161L17.9568 6.51473C19.0582 3.60726 20.1864 1.46295 20.9906 0.749905ZM11.7647 15.649C10.5199 16.3677 9.89712 16.7273 9.43978 17.13C7.58778 18.7608 6.89553 21.3443 7.68401 23.6826C7.87871 24.26 8.23798 24.8824 8.95645 26.1268C9.67512 27.3716 10.0347 27.9944 10.4374 28.4517C12.0682 30.3037 14.6517 30.996 16.9901 30.2075C17.5675 30.0128 18.1903 29.6532 19.4351 28.9346L26.5959 24.8003C27.8403 24.0818 28.4626 23.7224 28.9199 23.3198C30.7719 21.689 31.4642 19.1055 30.6757 16.7671C30.481 16.1897 30.1215 15.5669 29.4028 14.3221C28.6843 13.0777 28.3249 12.4554 27.9223 11.9981C26.2915 10.1461 23.708 9.45382 21.3696 10.2423C20.7923 10.437 20.1699 10.7963 18.9255 11.5147L11.7647 15.649Z" fill="currentColor"/>' +
    '<rect x="12.4551" y="20.6523" width="2.82872" height="5.87502" rx="1.41436" transform="rotate(-30 12.4551 20.6523)" fill="currentColor"/>' +
    '<rect x="20.0869" y="16.2461" width="2.82872" height="5.87502" rx="1.41436" transform="rotate(-30 20.0869 16.2461)" fill="currentColor"/>' +
    '</svg>';

  // Host design tokens (SKILL 7.15): semantic aliases, neutral grey fallbacks.
  var T = {
    text:      "var(--dsw-alias-label-primary, #1f2328)",
    textDim:   "var(--dsw-alias-label-secondary, #6a737d)",
    textTiny:  "var(--dsw-alias-label-tertiary, #8b949e)",
    bgCard:    "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))",
    bgInput:   "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))",
    border:    "var(--dsw-alias-border-l3, rgba(127,127,127,.38))",
    brand:     "var(--dsw-alias-brand-primary, #1f6feb)",
    accentFg:  "var(--dsw-alias-label-primary-foreground, #fff)",
    // amber, readable in BOTH themes: state-warn alone does not invert (SKILL 7.15.3)
    textTone:  "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 72%, var(--dsw-alias-label-primary, #1f2328))"
  };

  function css(el, obj) { for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) el.style[k] = obj[k]; } }
  function txt(s) { return String(s === undefined || s === null ? "" : s); }
  function pad(n, w) { var s = txt(n); return s.length >= w ? s : " ".repeat(w - s.length) + s; }
  /**
   * 手机号脱敏：保留前 3（运营商段）+ 后 3，其余全打码。
   * 用户 2026-10-11 要求：后四位再隐藏一位。
   */
  function maskPhone(p) {
    p = txt(p);
    if (p.length >= 11) return p.slice(0, 3) + "****" + p.slice(-4, -1) + "*";
    if (p.length >= 7) return p.slice(0, 3) + "****" + p.slice(-2, -1) + "*";
    return p;
  }
  /**
   * 昵称脱敏（🔴 隐私硬要求）。
   * 微信昵称常含真名/手机号/可识别信息，抽屉里一律只留首尾字。
   * 纯数字形态的昵称（用户直接拿手机号当昵称）按手机号规则处理。
   */
  function maskNick(n) {
    var s = txt(n).trim();
    if (!s) return "";
    if (/^\d{7,}$/.test(s)) return maskPhone(s);
    var chars = Array.from(s);
    if (chars.length <= 2) return s;
    return chars[0] + "…" + chars[chars.length - 1];
  }
  function shortUid(u) { return txt(u).slice(0, 8); }
  function fmtTime(ms) {
    if (!ms) return "-";
    var d = new Date(Number(ms));
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fmtLeft(ms, now) {
    var diff = Number(ms) - (now || Date.now());
    if (diff <= 0) return "已解禁";
    var s = Math.floor(diff / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 24) return Math.floor(h / 24) + "天" + (h % 24) + "小时";
    if (h > 0) return h + "小时" + m + "分";
    return m + "分" + (s % 60) + "秒";
  }

  // ---- persisted geometry ---------------------------------------------------
  function readPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (raw) { var p = JSON.parse(raw); if (p && typeof p.x === "number") return p; }
    } catch (e) { /* ignore */ }
    return { x: Math.max(12, (window.innerWidth || 1200) - BALL_SIZE - 26), y: 132 };
  }
  function savePos(x, y) { try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) })); } catch (e) { /* ignore */ } }
  function clamp(x, y) {
    var w = window.innerWidth || 1200, h = window.innerHeight || 800;
    return { x: Math.min(Math.max(4, x), Math.max(4, w - BALL_SIZE - 4)), y: Math.min(Math.max(4, y), Math.max(4, h - BALL_SIZE - 4)) };
  }

  // ---- state ---------------------------------------------------------------
  var hostEl = null, ballEl = null, drawerEl = null, listEl = null, headEl = null, footEl = null, toastEl = null, refreshBtn = null;
  var state = { loading: true, data: null, error: "" };
  var timer = null;
  var open = false;
  var lastFetchAt = 0;
  var fetching = false;
  var switching = false;
  var loginPolling = false;
  var checkinRunning = false;

  function isOpen() { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch (e) { return false; } }
  function setOpen(v) { open = !!v; try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch (e) { /* ignore */ } }

  /**
   * Pull /state and re-render.
   *
   * `announce` is set only for a user-initiated refresh: it shows a spinner on
   * the button and a toast on completion. Without that feedback a manual refresh
   * looks like a no-op, because the numbers usually do not change between two
   * clicks seconds apart — the earlier version had no feedback at all and the
   * user reasonably reported "the button does nothing".
   */
  function fetchState(announce) {
    // Dedupe BACKGROUND polls only. A user-initiated refresh must never be
    // dropped: the first guard returned early whenever a poll happened to be in
    // flight, so clicking 刷新 during the 30s poll did literally nothing.
    if (fetching && !announce) return Promise.resolve();
    fetching = true;
    state.loading = true;
    if (announce && refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "刷新中…";
    }
    // 调度信息与主数据**分开请求**：一个失败不能清空另一个（SKILL 7.14.5）
    fetch(HOST + "/checkin/state", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (cs) { state.checkin = cs || null; if (open) render(); })
      .catch(function () { /* 调度信息拿不到不影响主界面 */ });
    // ROOT-RELATIVE ONLY (SKILL 7.14.4): an absolute loopback URL is CSP-blocked.
    return fetch(HOST + "/state?model=" + encodeURIComponent(MODEL), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.data = d;
        state.error = "";
        state.loading = false;
        lastFetchAt = Date.now();
        render();
        if (announce) {
          var n = d && d.rows ? d.rows.length : 0;
          toast("已刷新 · " + timeOf(lastFetchAt) + " · " + n + " 个账号" + (d && d.available ? "" : "（账号数据不可用）"));
        }
      })
      .catch(function (e) {
        state.error = "读取失败：" + (e && e.message ? e.message : e);
        state.loading = false;
        render();
        if (announce) toast("刷新失败：" + (e && e.message ? e.message : e));
      })
      .then(function () {
        fetching = false;
        if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "刷新"; }
      });
  }

  function timeOf(ms) {
    var d = new Date(Number(ms) || Date.now());
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function summaryText() {
    var d = state.data;
    if (!d) return state.error ? "读取失败" : "读取中";
    if (!d.available) return "无本地数据";
    return d.usableCount + "/" + d.rows.length + " 可用";
  }
  function badgeCount() {
    var d = state.data;
    if (!d || !d.coolingCount) return 0;
    return d.coolingCount;
  }

  // ---- rendering -----------------------------------------------------------
  function buildBall() {
    ballEl = document.createElement("div");
    ballEl.setAttribute("data-workbuddy-ball", "1");
    css(ballEl, {
      position: "fixed", zIndex: "2147483000",
      // REQUIRED: the container is pointer-events:none (SKILL 7.6.3), and that
      // property INHERITS — without an explicit auto here the ball is visible
      // but every mouse event passes straight through it.
      pointerEvents: "auto",
      width: BALL_SIZE + "px", height: BALL_SIZE + "px",
      borderRadius: "50%", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--dsw-alias-bg-layer-1, #2b2f36)",
      border: "1px solid " + T.border,
      boxShadow: "0 3px 14px rgba(0,0,0,.34)",
      color: "var(--dsw-alias-label-primary, #e6e8ec)",
      userSelect: "none", touchAction: "none",
      transition: "transform .12s ease"
    });
    ballEl.title = "Workhoney 多账号台账（拖动可移动，点击展开）";

    var icon = document.createElement("div");
    css(icon, { width: "28px", height: "28px", display: "block", pointerEvents: "none" });
    icon.innerHTML = ICON_SVG;
    ballEl.appendChild(icon);

    // count badge: number of accounts currently in cooldown
    var badge = document.createElement("div");
    badge.setAttribute("data-wb-badge", "1");
    css(badge, {
      position: "absolute", top: "-3px", right: "-3px", minWidth: "19px", height: "19px",
      borderRadius: "10px", fontSize: "11px", lineHeight: "19px", textAlign: "center",
      padding: "0 5px", fontWeight: "600", display: "none",
      background: "var(--dsw-alias-state-error-primary, #d64545)", color: "#fff",
      pointerEvents: "none", boxSizing: "border-box"
    });
    ballEl.appendChild(badge);

    var p = clamp(readPos().x, readPos().y);
    css(ballEl, { left: p.x + "px", top: p.y + "px" });

    // drag vs click: threshold keeps a shaky click from becoming a move
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function onDown(ev) {
      var pt = ev.touches ? ev.touches[0] : ev;
      dragging = true; moved = false;
      sx = pt.clientX; sy = pt.clientY;
      var r = ballEl.getBoundingClientRect();
      ox = r.left; oy = r.top;
      // stop the host's outside-close / blur gates from eating our interaction
      ev.preventDefault();
      ev.stopPropagation();
    }
    function onMove(ev) {
      if (!dragging) return;
      var pt = ev.touches ? ev.touches[0] : ev;
      var dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      var q = clamp(ox + dx, oy + dy);
      css(ballEl, { left: q.x + "px", top: q.y + "px" });
      if (open && drawerEl) placeDrawer(q);
      ev.preventDefault();
    }
    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        var r = ballEl.getBoundingClientRect();
        savePos(r.left, r.top);
        if (open && drawerEl) placeDrawer({ x: r.left, y: r.top });
      } else {
        toggleDrawer();
      }
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    }

    ballEl.addEventListener("mousedown", onDown);
    ballEl.addEventListener("touchstart", onDown, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);

    return ballEl;
  }

  function placeDrawer(ballPos) {
    if (!drawerEl) return;
    var w = Math.min(560, Math.max(320, (window.innerWidth || 1200) - 40));
    var h = Math.min(600, Math.max(280, (window.innerHeight || 800) - 90));
    css(drawerEl, { width: w + "px", maxHeight: h + "px" });
    var wantLeft = ballPos.x + BALL_SIZE + 12;
    if (wantLeft + w > (window.innerWidth || 1200) - 12) wantLeft = Math.max(12, ballPos.x - w - 12);
    var wantTop = Math.min(Math.max(12, ballPos.y), Math.max(12, (window.innerHeight || 800) - h - 12));
    css(drawerEl, { left: wantLeft + "px", top: wantTop + "px" });
  }

  function buildDrawer() {
    drawerEl = document.createElement("div");
    drawerEl.setAttribute("data-workbuddy-drawer", "1");
    css(drawerEl, {
      position: "fixed", zIndex: "2147482999", display: "none",
      pointerEvents: "auto",   // same reason as the ball: undo the container's none
      background: "var(--dsw-alias-bg-layer-1, #1b1e24)",
      border: "1px solid " + T.border, borderRadius: "12px",
      boxShadow: "0 10px 34px rgba(0,0,0,.42)",
      color: T.text, overflow: "hidden", flexDirection: "column",
      font: '13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    });

    // header
    headEl = document.createElement("div");
    css(headEl, {
      padding: "11px 14px", borderBottom: "1px solid " + T.border,
      // 5 controls next to the title need room to wrap on a narrow drawer
      display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", flexShrink: "0"
    });
    var hIcon = document.createElement("div");
    css(hIcon, { width: "19px", height: "19px", color: T.brand, flexShrink: "0" });
    hIcon.innerHTML = ICON_SVG;
    headEl.appendChild(hIcon);
    var hTitle = document.createElement("div");
    // flexBasis + minWidth keeps the title on its own row when the buttons wrap
    css(hTitle, { fontWeight: "600", fontSize: "13.5px", flex: "1 1 auto", minWidth: "96px" });
    hTitle.textContent = "Workhoney";
    headEl.appendChild(hTitle);
    var hBtns = document.createElement("div");
    css(hBtns, { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginLeft: "auto" });
    // 🔴 2026-10-14 v1.9.1（用户反馈）：
    // 标题栏**只保留国内登录**。国际版登录按钮**移到国际版分组内**
    // （见 renderGlobalGroup）—— 分组语义更清晰，也避免误点。
    //   · 登录国内 → workbuddy.cn（原逻辑，一字未改）
    //   · 登录国际 → 在「国际版 · WorkBuddy AI」分组里，走 workbuddy.ai
    //     （实测国际站登录页在未登录态下配色极浅、近乎全白，看起来像白屏，
    //      所以国际版**首选「导入国际版账号」**，扫码登录只作备用路径）
    var btnLogin = mkBtn("＋ 登录国内账号", function (ev) { stopEvt(ev); startSeamlessLogin("cn"); });
    btnLogin.title = "打开国内站 workbuddy.cn 扫码登录，登录后自动入库（不退出当前账号）";
    var btnCheckin = mkBtn("签到", function (ev) { stopEvt(ev); runCheckin(btnCheckin); });
    btnCheckin.title = "对所有已备份账号签到（逐个解密凭据调官方接口，无需第三方工具）";
    var btnBoard = mkBtn("网页版", function (ev) { stopEvt(ev); openWebBoard(); });
    var btnRefresh = mkBtn("刷新", function (ev) { stopEvt(ev); fetchState(true); });
    refreshBtn = btnRefresh;
    var btnStar = mkBtn("★ Star", function (ev) { stopEvt(ev); openRepo(); });
    btnStar.title = REPO_READY ? ("给这个插件点个 Star：" + REPO_URL) : ("仓库尚未发布：" + REPO_URL);
    css(btnStar, { color: T.textTone });
    var btnClose = mkBtn("×", function (ev) { stopEvt(ev); setOpen(false); render(); });
    css(btnClose, { fontSize: "16px", lineHeight: "1", padding: "3px 9px" });
    hBtns.appendChild(btnLogin);
    hBtns.appendChild(btnCheckin);
    hBtns.appendChild(btnBoard);
    hBtns.appendChild(btnRefresh);
    hBtns.appendChild(btnStar);
    hBtns.appendChild(btnClose);
    headEl.appendChild(hBtns);
    drawerEl.appendChild(headEl);

    // body
    listEl = document.createElement("div");
    css(listEl, { padding: "11px 14px", overflowY: "auto", flex: "1" });
    drawerEl.appendChild(listEl);

    // footer
    footEl = document.createElement("div");
    css(footEl, { padding: "9px 14px", borderTop: "1px solid " + T.border, color: T.textTiny, fontSize: "11.5px", flexShrink: "0" });
    drawerEl.appendChild(footEl);

    // Keep the host from treating a click inside our drawer as "clicked outside"
    // (which would slam the drawer shut) — but do it in the BUBBLE phase.
    //
    // An earlier revision registered these with capture=true. That is wrong:
    // a capture-phase stopPropagation on the ROOT runs BEFORE the event ever
    // reaches the target, so every button inside the drawer (the × close in
    // particular) stopped receiving its click. The reference implementation
    // (dsh-lobsterai-daddy) only ever stops propagation on the specific
    // element that needs it, never on the whole panel in capture.
    ["mousedown", "click", "pointerdown"].forEach(function (evt) {
      drawerEl.addEventListener(evt, function (e) { e.stopPropagation(); }, false);
    });

    return drawerEl;
  }

  /**
   * 方式一：无感登录（免退出）。
   *
   * Asks the host for a state + authorisation URL, opens it in the SYSTEM browser
   * (the host spawns it — window.open is blocked under dsh-app://), then polls
   * until the user finishes scanning. On success the new account is written to
   * accounts/<uid>.info and the list refreshes; the CURRENT sign-in is untouched,
   * so other accounts keep working.
   */
  /**
   * 发起无感登录（不退出当前账号，浏览器扫码后自动入库）。
   *
   * 🔴 2026-10-14 v1.9.1（用户反馈「登录新账号弹出的却是 workbuddy.ai，
   * 国内版没法登录」）：
   *
   * 查证结论：插件请求的端点与拿回的 authUrl **都是 workbuddy.cn**（未被我改过），
   * 但国内登录页会把人导向国际站 → 用户在国内站上完不成国内账号登录。
   *
   * 修法：**拆成两个按钮，各走各的端点**。
   *   · 登录国内账号 → POST /login/start（不传 region，宿主默认走 workbuddy.cn）
   *   · 登录国际账号 → POST /login/start?region=global（走 workbuddy.ai）
   * 国内那条路**一字未改**，不拆东墙补西墙。
   *
   * @param {'cn'|'global'} region
   */
  function startSeamlessLogin(region) {
    if (loginPolling) { toast("登录流程进行中，请先在浏览器完成扫码"); return; }
    var isGlobal = region === "global";
    toast(isGlobal ? "正在申请国际版登录链接…" : "正在申请登录链接…");
    fetch(HOST + "/login/start" + (isGlobal ? "?region=global" : ""), {
      method: "POST", credentials: "same-origin"
    })
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (out) {
        var d = out.d || {};
        if (!d.ok) { toast("发起登录失败：" + (d.error || ("HTTP " + out.s))); return; }
        toast(isGlobal
          ? "已打开浏览器（国际版 workbuddy.ai），请扫码授权（10 分钟内有效）"
          : "已打开浏览器（国内版 workbuddy.cn），请扫码授权（10 分钟内有效）", true);
        pollLogin(d.loginId, Date.now() + (d.expiresIn || 600) * 1000);
      })
      .catch(function (e) { toast("发起登录失败：" + (e && e.message ? e.message : e)); });
  }

  /** poll the host for the authorisation result until done/timeout */
  function pollLogin(loginId, deadline) {
    loginPolling = true;
    var stop = false;
    function once() {
      if (stop) return;
      if (Date.now() > deadline) {
        stop = true; loginPolling = false;
        toast("登录超时，请重新点击「登录新账号」");
        return;
      }
      fetch(HOST + "/login/poll?loginId=" + encodeURIComponent(loginId), { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.done) {
            stop = true; loginPolling = false;
            if (d.error) { toast("登录未完成：" + d.error); return; }
            var res = d.result || {};
            toast("已登录并入库：" + (maskNick(res.nickname) || maskPhone(res.phone) || shortUid(res.uid) || "新账号"), true);
            fetchState(true);
            return;
          }
          setTimeout(once, 3000);
        })
        .catch(function () { setTimeout(once, 4000); });
    }
    once();
  }

  /**
   * 打开 GitHub 仓库（Star 直达）。
   *
   * window.open / <a target=_blank> are silently swallowed under dsh-app://
   * (SKILL 7.14), so the reliable route is the HOST's /open-url endpoint, which
   * spawns the real browser. An anchor attempt is still made first because it is
   * free and works when the shell happens to allow it.
   */
  function openRepo() {
    if (!REPO_READY) {
      toast("仓库尚未发布；发布后此按钮直达 GitHub：" + REPO_URL, true);
      return;
    }
    try {
      var a = document.createElement("a");
      a.href = REPO_URL;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (e) { /* ignore */ } }, 0);
    } catch (e) { /* fall through to the host route */ }
    fetch(HOST + "/open-url", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: REPO_URL }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) toast("已在浏览器打开：" + REPO_URL);
        else toast("无法自动打开，请手动访问：" + REPO_URL, true);
      })
      .catch(function () { toast("无法自动打开，请手动访问：" + REPO_URL, true); });
  }

  /**
   * 一键签到：交给宿主对所有已备份账号逐一签到。
   *
   * 宿主负责解密每个账号的凭据并调用官方签到接口（因此不依赖 WorkDaddy），
   * 客户端只负责触发、显示进度与结果。
   */
  function runCheckin(btn) {
    if (checkinRunning) { toast("签到进行中，请稍候…"); return; }
    checkinRunning = true;
    var prev = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "签到中…"; }
    toast("正在为所有账号签到…", true);
    fetch(HOST + "/checkin", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok && d.error) { toast("签到失败：" + (d && d.error ? d.error : "未知错误"), true); return; }
        var ok = d.okCount || 0;
        var total = d.total || 0;
        var failed = (d.results || []).filter(function (x) { return !x.ok; });
        var already = (d.results || []).filter(function (x) { return x.ok && x.already; }).length;
        var msg = "签到完成：" + ok + "/" + total + " 成功";
        if (already) msg += "（其中 " + already + " 个今日已签到）";
        if (failed.length) msg += "，失败 " + failed.length + "：" + failed.slice(0, 3).map(function (x) {
          return shortUid(x.uid) + " " + (x.error || x.message || x.code || "");
        }).join("；");
        toast(msg, true);
        fetchState(true);
      })
      .catch(function (e) { toast("签到失败：" + (e && e.message ? e.message : e)); })
      .then(function () {
        checkinRunning = false;
        if (btn) { btn.disabled = false; btn.textContent = prev || "签到"; }
      });
  }

  function stopEvt(e) { if (e) { e.preventDefault(); e.stopPropagation(); } }

  /**
   * Open the full web board in the system browser.
   *
   * window.open() / <a target=_blank> are silently swallowed under dsh-app://,
   * so the reliable route is the HOST: POST /open makes the host spawn the
   * browser. We still try the anchor route first (it renders identically when
   * the shell happens to allow it), then fall back to the host, and finally
   * tell the user the URL so nothing is left to guesswork.
   */
  function openWebBoard() {
    var fallbackUrl = HOST + "/board";
    function viaAnchor() {
      try {
        var a = document.createElement("a");
        a.href = fallbackUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { a.remove(); } catch (e) { /* ignore */ } }, 0);
        return true;
      } catch (e) { return false; }
    }
    viaAnchor();
    // Ask the host to launch the real browser too; harmless if the anchor worked.
    fetch(HOST + "/open", { method: "POST", credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) toast("已在浏览器打开网页版：" + d.url);
        else toast("无法自动打开，请手动访问：" + fallbackUrl);
      })
      .catch(function () { toast("无法自动打开，请手动访问：" + fallbackUrl); });
  }

  /**
   * Ask the host to switch the WorkDaddy/WorkBuddy account, then re-read state.
   *
   * The ball is a mapping onto WorkDaddy, not a second implementation: the host
   * forwards the uid to WorkDaddy's own POST /api/switch and mirrors the new
   * credential to whatever path DSH reads.
   */
  /**
   * 切号。
   *
   * @param {object} r  账号行（含 uid / phone / nickname）
   * @param {HTMLElement} btn 触发按钮（用于忙态反馈）
   * @param {'cn'|'global'} [region] 默认 'cn' —— **不传时行为与以往一致**。
   *   国际版传 'global'，宿主会写入 workbuddy-desktop-ai.info（国际版登录位），
   *   不碰国内那个登录文件。
   */
  function switchToAccount(r, btn, region) {
    if (!r || !r.uid) return;
    var isGlobal = region === "global";
    var label = (r.phone ? maskPhone(r.phone) : shortUid(r.uid)) + (r.nickname ? " " + maskNick(r.nickname) : "");
    if (switching) { toast("正在切换中，请稍候…"); return; }
    switching = true;
    var prev = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "切换中…"; }
    toast("正在切到 " + label + (isGlobal ? "（国际版）" : "") + " …");
    fetch(HOST + "/switch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: r.uid, region: isGlobal ? "global" : "cn" }),
    })
      .then(function (res) { return res.json().then(function (d) { return { status: res.status, d: d }; }); })
      .then(function (out) {
        var d = out.d || {};
        if (d.ok) {
          toast(isGlobal
            ? ("已切到国际版 " + label + "（写入 workbuddy-desktop-ai.info，重启国际版 App 生效）")
            : ("已切到 " + label + "（凭据同步：" + (d.credentialMirror || "?") + "）"));
          return fetchState().then(function () { /* state refresh renders the new current */ });
        }
        toast("切换失败：" + (d.error || (d.workdaddy && d.workdaddy.raw) || ("HTTP " + out.status)));
      })
      .catch(function (e) { toast("切换失败：" + (e && e.message ? e.message : e)); })
      .then(function () {
        switching = false;
        if (btn) { btn.disabled = false; btn.textContent = prev || "切到此账号"; }
      });
  }

  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        css(toastEl, {
          position: "fixed", left: "50%", bottom: "26px", transform: "translateX(-50%)",
          zIndex: "2147483001", maxWidth: "min(620px, 86vw)",
          background: "var(--dsw-alias-bg-layer-1, #22262e)",
          border: "1px solid " + T.border, borderRadius: "9px",
          color: T.text, padding: "10px 15px", fontSize: "12.5px",
          boxShadow: "0 8px 26px rgba(0,0,0,.4)", pointerEvents: "none",
          wordBreak: "break-all", transition: "opacity .25s", opacity: "0"
        });
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      if (toastEl._t) clearTimeout(toastEl._t);
      toastEl._t = setTimeout(function () { try { toastEl.style.opacity = "0"; } catch (e) { /* ignore */ } }, 4200);
    } catch (e) { /* ignore */ }
  }

  function mkBtn(label, onClick) {
    var b = document.createElement("button");
    b.textContent = label;
    css(b, {
      background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))",
      border: "1px solid " + T.border, color: T.text, borderRadius: "7px",
      padding: "4px 10px", fontSize: "12px", cursor: "pointer", font: "inherit",
      transition: "opacity .15s"
    });
    b.addEventListener("click", onClick);
    b.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    return b;
  }

  function chip(text, kind) {
    var s = document.createElement("span");
    s.textContent = text;
    var bg = "rgba(127,127,127,.16)", fg = T.text, bd = T.border;
    if (kind === "ok") { bg = "color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 22%, transparent)"; fg = T.text; }
    if (kind === "bad") { bg = "color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 24%, transparent)"; fg = T.text; }
    css(s, {
      display: "inline-block", padding: "1px 8px", borderRadius: "20px",
      fontSize: "11.5px", background: bg, color: fg, border: "1px solid " + bd,
      whiteSpace: "nowrap"
    });
    return s;
  }

  function row(label, value, valueColor) {
    var r = document.createElement("div");
    css(r, { display: "flex", justifyContent: "space-between", gap: "10px", padding: "3px 0" });
    var l = document.createElement("span");
    l.textContent = label;
    css(l, { color: T.textDim, flexShrink: "0" });
    var v = document.createElement("span");
    v.textContent = value;
    css(v, { color: valueColor || T.text, textAlign: "right", wordBreak: "break-all" });
    r.appendChild(l); r.appendChild(v);
    return r;
  }

  function card() {
    var c = document.createElement("div");
    css(c, {
      background: T.bgCard, border: "1px solid " + T.border,
      borderRadius: "9px", padding: "9px 11px", marginBottom: "8px"
    });
    return c;
  }

  /** 分组小标题（带一条分隔线），用于「国内版 / 国际版」两组的分界 */
  function groupHeader(text, sub) {
    var wrap = document.createElement("div");
    css(wrap, {
      marginTop: "16px", marginBottom: "8px", paddingTop: "11px",
      borderTop: "1px solid " + T.border
    });
    var t = document.createElement("div");
    t.textContent = text;
    css(t, { fontWeight: "650", fontSize: "13px", color: T.text });
    wrap.appendChild(t);
    if (sub) {
      var s = document.createElement("div");
      s.textContent = sub;
      css(s, { color: T.textTiny, fontSize: "11.5px", marginTop: "2px" });
      wrap.appendChild(s);
    }
    return wrap;
  }

  /**
   * 国际版（WorkBuddy AI）分组。
   *
   * 与国内版的关键差异（照 global-vs-cn.md）：
   *   · 独立 App（WorkBuddyAI.exe）、独立凭据（workbuddy-desktop-ai.info）
   *   · 独立 provider（workbuddy-ai）、独立账号库（workbuddy-data/ai/）
   *   · 无 WorkDaddy 体系 → 没有冷却台账 / 实时额度 / 今日用量
   *
   * 首版落地「导入已登录账号」（用户选定方案 A）：国际版 App 已登录时，
   * 一键把它的账号导入台账，随后可切号。
   */
  function renderGlobalGroup(listEl, d) {
    var rows = d.rowsAI || [];
    var signedIn = d.globalAppSignedIn === true;
    var head = groupHeader(
      "国际版 · WorkBuddy AI",
      "workbuddy.ai" + (signedIn ? " · 桌面端已登录" : " · 桌面端未登录")
        + " · " + rows.length + " 个账号"
    );
    listEl.appendChild(head);

    // 导入按钮（无论有没有账号都显示：可重复导入以刷新凭据）
    var actRow = document.createElement("div");
    css(actRow, { display: "flex", gap: "7px", alignItems: "center", marginBottom: "8px" });
    var impBtn = mkBtn(signedIn ? "导入国际版账号（刷新凭据）" : "导入国际版账号", function (ev) {
      stopEvt(ev);
      impBtn.disabled = true;
      var prev = impBtn.textContent;
      impBtn.textContent = "导入中…";
      fetch(HOST + "/global/import", { method: "POST", credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (out) {
          var j = out.j || {};
          if (j.ok) {
            toast("已导入国际版账号：" + (maskNick(j.nickname) || shortUid(j.uid) || "新账号"), true);
            fetchState(true);
          } else {
            toast("导入失败：" + (j.reason || j.error || ("HTTP " + out.s)));
          }
        })
        .catch(function (e) { toast("导入失败：" + (e && e.message ? e.message : e)); })
        .then(function () { impBtn.disabled = false; impBtn.textContent = prev; });
    });
    actRow.appendChild(impBtn);
    // 🔴 v1.9.1：国际版登录按钮**放在这个分组内**（从标题栏挪来）。
    // 「导入」只能拿到**已经登录**的账号；想新登一个国际版账号才需要走扫码。
    //
    // ⚠️ 实测告知（2026-10-14）：国际站登录页在**未登录态下配色极浅、近乎全白**，
    // 打开后看起来像"白屏/没打开"。这是腾讯国际站页面自身的问题（已验证与
    // VPN 代理无关：走/不走代理资源都是 200）。所以：
    //   · 首选路径 = 在国际版 App 里登录 → 回来点「导入国际版账号」
    //   · 扫码登录只作备用
    var loginBtnAI = mkBtn("＋ 登录国际账号", function (ev) {
      stopEvt(ev);
      startSeamlessLogin("global");
    });
    loginBtnAI.title = "打开国际站 workbuddy.ai 扫码登录。"
      + "注意：该页面未登录态下配色很浅、可能看起来像白屏（腾讯站点自身行为，非插件问题）；"
      + "更稳妥的做法是直接在国际版 App 里登录，然后点左边的「导入国际版账号」。";
    css(loginBtnAI, { color: T.brand });
    actRow.appendChild(loginBtnAI);
    listEl.appendChild(actRow);

    // 未登录时的明确提示（不留空、不假装有数据）
    if (!signedIn) {
      var na = card();
      var t1 = document.createElement("div");
      t1.textContent = "未检测到国际版 WorkBuddy AI 的登录状态";
      css(t1, { fontWeight: "600" });
      na.appendChild(t1);
      var t2 = document.createElement("div");
      t2.textContent = "请先打开国际版 WorkBuddy AI 桌面端登录一次，再点上面的「导入国际版账号」。";
      css(t2, { color: T.textDim, fontSize: "12px", marginTop: "4px" });
      na.appendChild(t2);
      listEl.appendChild(na);
      return;
    }

    if (!rows.length) {
      var empty = card();
      var e1 = document.createElement("div");
      e1.textContent = "桌面端已登录，但还没导入到台账";
      css(e1, { fontWeight: "600" });
      empty.appendChild(e1);
      var e2 = document.createElement("div");
      e2.textContent = "点「导入国际版账号」即可把当前登录账号加入（不会改动国际版 App 的登录状态）。";
      css(e2, { color: T.textDim, fontSize: "12px", marginTop: "4px" });
      empty.appendChild(e2);
      listEl.appendChild(empty);
      return;
    }

    rows.forEach(function (r, i) {
      var c = card();
      if (r.isCurrent) css(c, { borderColor: "var(--dsw-alias-state-success-primary, #22c55e)" });

      var top = document.createElement("div");
      css(top, { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginBottom: "5px" });
      var idx = document.createElement("span");
      idx.textContent = String(i + 1);
      css(idx, { color: T.textTiny, minWidth: "14px", fontWeight: "600" });
      top.appendChild(idx);
      var who = document.createElement("span");
      who.textContent = r.phone ? maskPhone(r.phone) : shortUid(r.uid);
      css(who, { fontWeight: "600" });
      top.appendChild(who);
      if (r.nickname) {
        var nk = document.createElement("span");
        nk.textContent = maskNick(r.nickname);
        css(nk, { color: T.textDim, fontSize: "12px" });
        top.appendChild(nk);
      }
      if (r.isCurrent) top.appendChild(chip("DSH当前", "ok"));
      top.appendChild(chip(r.authValid === false ? "登录失效" : "可用", r.authValid === false ? "bad" : "ok"));
      c.appendChild(top);

      if (r.checkin) {
        c.appendChild(row("今日签到",
          r.checkin.ok ? (r.checkin.already ? "已签到" : "已签到 ✓") : "签到失败",
          r.checkin.ok ? undefined : T.textDim));
      } else {
        c.appendChild(row("今日签到", "未签到", T.textDim));
      }
      // 🔴 v1.9.4（用户反馈「国际版没显示积分余额」）：
      // 国际版**能取额度** —— vendor 的 billingBase 按 credential.domain 自动分流：
      //   www.workbuddy.ai → GLOBAL_BASE；workbuddy.cn / codebuddy.cn → CN 账单域名。
      // 之前取不到的真因是缺 WORKBUDDY_AI_ELECTRON_BIN（解密凭据需要国际版自己的 Electron）。
      // 取不到时显示具体原因，不假装有数（SKILL §7.20）。
      if (r.creditsRealtime !== null && r.creditsRealtime !== undefined) {
        c.appendChild(row("实时额度",
          String(r.creditsRealtime)
            + (r.creditsTotal ? " / " + r.creditsTotal : "")
            + (r.creditsPlanCount ? "（" + r.creditsPlanCount + " 个套餐）" : "")));
      } else if (r.creditsRealtimeError) {
        c.appendChild(row("实时额度", "未取到：" + r.creditsRealtimeError, T.textDim));
      } else {
        c.appendChild(row("实时额度", "未取到", T.textDim));
      }
      if (r.domain) c.appendChild(row("站点", r.domain, T.textDim));

      // 🔴 2026-10-14 v1.9.3（用户反馈「显示两个账号也不能切换」）：
      // 上一版**忘了给国际版行加切号按钮** —— 只渲染了信息，所以"切不了"。
      // 现在补上，并明确传 region:'global'，让宿主写入国际版登录位
      // （workbuddy-desktop-ai.info）而不是国内那个。
      if (!r.isCurrent) {
        var actRow2 = document.createElement("div");
        css(actRow2, { marginTop: "7px", display: "flex", gap: "7px", alignItems: "center" });
        var swBtn2 = mkBtn("切到此账号", function (ev) {
          stopEvt(ev);
          switchToAccount(r, swBtn2, "global");
        });
        swBtn2.title = "把国际版 App 的登录状态切到这个账号（写入 workbuddy-desktop-ai.info，不影响国内版）";
        actRow2.appendChild(swBtn2);
        c.appendChild(actRow2);
      }

      listEl.appendChild(c);
    });
  }

  function render() {
    if (!ballEl) return;
    if (refreshBtn) refreshBtn.style.opacity = refreshBtn.disabled ? "0.55" : "1";

    // badge
    var badge = ballEl.querySelector('[data-wb-badge]');
    var bc = badgeCount();
    if (badge) {
      badge.style.display = bc > 0 ? "block" : "none";
      badge.textContent = String(bc);
    }
var bcTitle = badgeCount();
    ballEl.title = "Workhoney：" + summaryText()
      + (bcTitle > 0 ? ("　⚠ " + bcTitle + " 个账号限流中") : "")
      + "（拖动可移动，点击展开）";

    // drawer visibility
    if (drawerEl) {
      if (open) {
        drawerEl.style.display = "flex";
        var r = ballEl.getBoundingClientRect();
        placeDrawer({ x: r.left, y: r.top });
      } else {
        drawerEl.style.display = "none";
      }
    }
    if (!listEl || !open) return;

    listEl.innerHTML = "";

    var d = state.data;
    if (state.error) {
      var e1 = card();
      e1.appendChild(row("错误", state.error, T.text));
      listEl.appendChild(e1);
      return;
    }
    if (!d) {
      var l1 = card();
      l1.appendChild(row("状态", "读取中…"));
      listEl.appendChild(l1);
      return;
    }
    if (!d.available) {
      var na = card();
      var t1 = document.createElement("div");
      t1.textContent = "多账号信息不可用";
      css(t1, { fontWeight: "600", marginBottom: "5px" });
      na.appendChild(t1);
      var t2 = document.createElement("div");
      t2.textContent = d.reason || "未检测到本地账号数据。";
      css(t2, { color: T.textDim, fontSize: "12px" });
      na.appendChild(t2);
      var t3 = document.createElement("div");
      t3.textContent = "提示：切号与模型使用不受影响，只是看不到账号/积分汇总。";
      css(t3, { color: T.textDim, fontSize: "12px", marginTop: "6px" });
      na.appendChild(t3);
      listEl.appendChild(na);
      return;
    }

    // summary
    var sum = card();
    var s1 = document.createElement("div");
    css(s1, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });
    var big = document.createElement("span");
    big.textContent = d.usableCount + " / " + d.rows.length;
    css(big, { fontSize: "20px", fontWeight: "650" });
    s1.appendChild(big);
    s1.appendChild(chip("可用账号", "ok"));
    if (d.coolingCount > 0) s1.appendChild(chip(d.coolingCount + " 个限流中", "bad"));
    sum.appendChild(s1);
    sum.appendChild(row("目标模型", d.model));
    // 实时额度合计（原「今日总用量」的数据源已随 WorkDaddy 卸载消失，改用上游实时值）
    if (d.realtimeOkCount !== undefined) {
      sum.appendChild(row("实时总额度", String(d.totalRealtime || 0) + "  （" + d.realtimeOkCount + "/" + (d.rows ? d.rows.length : 0) + " 个账号取到）"));
    }
    if (d.next) {
      sum.appendChild(row("建议下一个用", (d.next.phone ? maskPhone(d.next.phone) : shortUid(d.next.uid)) + (d.next.nickname ? " · " + maskNick(d.next.nickname) : "") + "  (剩 " + d.next.credits + ")"));
    }
    if (d.current) {
      sum.appendChild(row("DSH 当前账号", (d.current.phone ? maskPhone(d.current.phone) : shortUid(d.current.uid)) + (d.current.nickname ? " · " + maskNick(d.current.nickname) : "")));
    }
    // explicit freshness line: lets the user verify that "刷新" actually did something
    sum.appendChild(row("数据更新于", timeOf(d.generatedAt) + (lastFetchAt ? "（本页 " + timeOf(lastFetchAt) + " 拉取）" : "")));
    // 定时签到状态（与 WorkDaddy 的 daily-account-checkin 同规则）
    var cs = state.checkin;
    if (cs && cs.schedule) {
      var last = cs.schedule.lastRun;
      var lr = last ? (timeOf(last.at) + " · " + last.okCount + "/" + last.total + " 成功") : "尚未运行";
      sum.appendChild(row("自动签到", "每 " + cs.schedule.intervalMinutes + " 分钟 · 上次 " + lr));
    }
    listEl.appendChild(sum);

    // accounts
    // 🔴 2026-10-14 v1.9.0：加「国内版」分组标题 —— 用户要求国内/国际**分成两组**。
    // 国内版用 WorkDaddy 体系（冷却台账 / 实时额度 / 今日用量），国际版没有，
    // 因此两组不仅数据来源不同，能展示的字段也不同，必须分开呈现才不误导。
    listEl.appendChild(groupHeader(
      "国内版 · WorkBuddy",
      "workbuddy.cn / codebuddy.cn · " + (d.rows ? d.rows.length : 0) + " 个账号"
    ));
    var head = document.createElement("div");
    head.textContent = "账号顺序（可用 → 积分最早过期 → 今日用得少）";
    css(head, { color: T.textDim, fontSize: "11.5px", margin: "4px 0 6px" });
    listEl.appendChild(head);

    d.rows.forEach(function (r, i) {
      var c = card();
      if (r.cooling) css(c, { opacity: "0.62" });
      if (r.isCurrent) css(c, { borderColor: "var(--dsw-alias-state-success-primary, #22c55e)" });

      var top = document.createElement("div");
      css(top, { display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginBottom: "5px" });
      var idx = document.createElement("span");
      idx.textContent = String(i + 1);
      css(idx, { color: T.textTiny, minWidth: "14px", fontWeight: "600" });
      top.appendChild(idx);
      var who = document.createElement("span");
      who.textContent = r.phone ? maskPhone(r.phone) : shortUid(r.uid);
      css(who, { fontWeight: "600" });
      top.appendChild(who);
      if (r.nickname) {
        var nk = document.createElement("span");
        nk.textContent = maskNick(r.nickname);
        css(nk, { color: T.textDim, fontSize: "12px" });
        top.appendChild(nk);
      }
      if (r.isCurrent) top.appendChild(chip("DSH当前", "ok"));
      if (r.cooling) top.appendChild(chip("限流 " + fmtLeft(r.resetAt, d.generatedAt), "bad"));
      else top.appendChild(chip("可用", "ok"));
      // sign-in health + check-in state, straight from WorkDaddy
      if (r.authValid === false) top.appendChild(chip("登录失效", "bad"));
      if (r.checkin) {
        top.appendChild(chip(r.checkin.ok ? (r.checkin.already ? "已签到" : "已签到✓") : "签到失败",
          r.checkin.ok ? "ok" : "bad"));
      }
      c.appendChild(top);

      var grid = document.createElement("div");
      css(grid, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 14px" });
      grid.appendChild(row("剩余积分", String(r.credits)));
      /**
       * 实时额度（上游权威数据，2026-10-11 替换掉了拿不到的「今日用量/请求数」）。
       * 原数据源是 WorkDaddy 的用量库，卸载后已删除，且上游没有用量查询端点；
       * 但上游提供逐套餐的额度接口，信息更准确，因此改用它。
       */
      var rt = (r.creditsRealtime === null || r.creditsRealtime === undefined) ? null : r.creditsRealtime;
      var rtText = rt === null
        ? "未取到"
        : (rt + (r.creditsTotal ? " / " + r.creditsTotal : "") + (r.creditsExpiringCount ? "  ⚠" + r.creditsExpiringCount + " 个快到期" : ""));
      grid.appendChild(row("实时额度", rtText, rt === null ? T.textDim : null));
      if (r.creditsPlanCount) grid.appendChild(row("套餐数", String(r.creditsPlanCount) + " 个"));
      grid.appendChild(row("积分最早过期", r.soonestExpiry ? fmtTime(r.soonestExpiry) : "-"));
      if (r.creditSchedule && r.creditSchedule.length > 1) {
        grid.appendChild(row("积分段数", r.creditSchedule.length + " 段"));
        grid.appendChild(row("下个过期", r.creditSchedule[0].expiresAt ? fmtTime(r.creditSchedule[0].expiresAt) : "-"));
      }
      if (r.tokenExpiresAt) grid.appendChild(row("登录令牌到期", fmtTime(r.tokenExpiresAt)));
      c.appendChild(grid);

      // ---- credit expiry schedule (the part that silently wastes credits) ----
      if (r.creditSchedule && r.creditSchedule.length) {
        var exp = document.createElement("div");
        css(exp, { marginTop: "6px" });
        var expHead = document.createElement("div");
        expHead.textContent = "积分有效期（先过期先花）";
        css(expHead, { color: T.textDim, fontSize: "11.5px", marginBottom: "3px" });
        exp.appendChild(expHead);
        var soonDays = 3;
        r.creditSchedule.slice(0, 6).forEach(function (s) {
          var line = document.createElement("div");
          var when = s.expiresAt ? fmtTime(s.expiresAt) : "无期限";
          var urgent = s.expiresAt && (s.expiresAt - Date.now()) < soonDays * 86400000;
          line.textContent = "· " + when + "  剩 " + s.remaining + (urgent ? "  ⚠ 即将过期" : "");
          css(line, { color: urgent ? T.textTone : T.textTiny, fontSize: "11.5px", lineHeight: "1.65" });
          exp.appendChild(line);
        });
        if (r.creditSchedule.length > 6) {
          var more = document.createElement("div");
          more.textContent = "· …还有 " + (r.creditSchedule.length - 6) + " 段";
          css(more, { color: T.textTiny, fontSize: "11.5px" });
          exp.appendChild(more);
        }
        c.appendChild(exp);
      }

      // 实时额度取不到时给出可执行提示（取代旧的"用量未同步"——那个数据源已随
      // WorkDaddy 卸载消失，现改由上游实时额度接口提供，见 lib/index.js fetchRealtimeCredits）
      if (r.creditsRealtime === null || r.creditsRealtime === undefined) {
        var hint = document.createElement("div");
        hint.textContent = "实时额度未取到"
          + (r.creditsRealtimeError ? "：" + r.creditsRealtimeError : "")
          + "（需要该账号凭据可解密且网络可达）";
        css(hint, { color: T.textTiny, fontSize: "11px", marginTop: "4px" });
        c.appendChild(hint);
      }
      if (r.creditsExpiringCount > 0) {
        var warn = document.createElement("div");
        warn.textContent = "⚠ 有 " + r.creditsExpiringCount + " 个套餐 3 天内到期，建议优先使用";
        css(warn, { color: T.textTone, fontSize: "11px", marginTop: "4px" });
        c.appendChild(warn);
      }

      // ---- switch action: the ball is a WorkDaddy mapping ----
      if (!r.isCurrent) {
        var actRow = document.createElement("div");
        css(actRow, { marginTop: "7px", display: "flex", gap: "7px", alignItems: "center" });
        var swBtn = mkBtn("切到此账号", function (ev) {
          stopEvt(ev);
          switchToAccount(r, swBtn);
        });
        actRow.appendChild(swBtn);
        c.appendChild(actRow);
      }

      var models = Object.keys(r.modelsToday || {});
      if (models.length) {
        var ms = document.createElement("div");
        ms.textContent = models.map(function (m) { return m + " " + r.modelsToday[m]; }).join("　");
        css(ms, { color: T.textTiny, fontSize: "11.5px", marginTop: "4px" });
        c.appendChild(ms);
      }
      listEl.appendChild(c);
    });

    // cooldown queue
    if (d.coolingRows && d.coolingRows.length) {
      var qh = document.createElement("div");
      qh.textContent = "冷却队列（按解禁先后）";
      css(qh, { color: T.textDim, fontSize: "11.5px", margin: "10px 0 6px" });
      listEl.appendChild(qh);
      d.coolingRows.forEach(function (r) {
        var c = card();
        c.appendChild(row(r.phone ? maskPhone(r.phone) : shortUid(r.uid), fmtTime(r.resetAt) + "（还需 " + fmtLeft(r.resetAt, Date.now()) + "）", T.textDim));
        listEl.appendChild(c);
      });
    }

    // =====================================================================
    // 国际版（WorkBuddy AI / workbuddy.ai）分组 —— 2026-10-14 v1.9.0
    //
    // 用户明确要求「分成两组」。国际版与国内版**物理隔离**：
    // 不同 App、不同凭据文件、不同账号库、不同 provider。
    // 所以这里是一整块独立渲染，不与国内卡片混排。
    // 数据来自宿主的 rowsAI / globalAccountCount / globalAppSignedIn。
    // =====================================================================
    renderGlobalGroup(listEl, d);

    footEl.textContent = "更新 " + fmtTime(d.generatedAt)
      + (lastFetchAt ? " · 本页拉取 " + timeOf(lastFetchAt) : "")
      + " · 每 30 秒自动刷新 · 数据源 本地账号库（只读）";
  }

  function toggleDrawer() {
    setOpen(!open);
    render();
    if (open) fetchState();
  }

  function mount() {
    if (document.querySelector('[data-workbuddy-ball]')) return; // singleton guard
    hostEl = document.createElement("div");
    // SKILL 7.6.3: a static, click-through container keeps position:fixed children
    // anchored to the viewport in Electron.
    css(hostEl, { position: "static", pointerEvents: "none", zIndex: "2147483000" });
    hostEl.appendChild(buildBall());
    hostEl.appendChild(buildDrawer());
    document.body.appendChild(hostEl);

    open = isOpen();
    render();
    fetchState();
  /**
   * 🔴 后台也要刷新（2026-10-11 用户实测："重启后没显示提醒"）。
   *
   * 原来只有抽屉打开时才拉数据 —— 后果是悬浮球上的限流角标永远停留在
   * "上次开抽屉那一刻"的状态。而限流是**后台探测**发现的（每 10 分钟一轮），
   * 用户抽屉关着时根本看不到。
   *
   * 现在：抽屉打开时保持 30 秒；关闭时降频到 2 分钟（够及时又不浪费请求）。
   */
  timer = setInterval(function () {
    if (open) { fetchState(); return; }
    // 后台低频刷新：只为更新球上的"可用数 + 限流角标"
    if (Date.now() - lastFetchAt >= 120000) fetchState();
  }, POLL_MS);
    window.addEventListener("resize", function () {
      var p = clamp(readPos().x, readPos().y);
      css(ballEl, { left: p.x + "px", top: p.y + "px" });
      if (open && drawerEl) { var r = ballEl.getBoundingClientRect(); placeDrawer({ x: r.left, y: r.top }); }
    });
  }

  function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = ballEl = drawerEl = listEl = headEl = footEl = null;
  }

  exports.inject = [];
  exports.apply = function () {
    // Mount unconditionally — do NOT branch on the ctx shape. An earlier
    // revision returned early when ctx.effect existed, so the ball never
    // mounted in a real cordis runtime (caught by the DOM-stub probe).
    function boot() {
      try { mount(); } catch (e) { reportDiag("mount:ERROR " + (e && e.message)); }
    }
    reportDiag("apply:called readyState=" + document.readyState);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  };
  exports.dispose = dispose;

  // Diagnostics must land on a channel the host actually forwards; a custom
  // prefix is dropped by the log whitelist (SKILL 7.10.5).
  function reportDiag(msg) {
    try { console.info("[next-ui-diagnostic] workbuddy-ball " + msg); } catch (e) { /* ignore */ }
  }

  return module.exports;
  }
});
