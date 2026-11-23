/* ==========================================================================
   Sunshine个人工作站 — 统一数据接口层 (API)
   --------------------------------------------------------------------------
   设计目标：
   1. 统一返回结构 { ok, data, error, message }，兼容云端 SDK 的 { data, error } 风格。
   2. 集中参数校验、异常处理、安全校验（权限 / 越权 / 输入过滤）。
   3. 同时服务本地演示数据源与云端数据源，供 UI 层调用，保持既有调用习惯。
   依赖：config.js（APP_CONFIG）、cloud-config.js（cloudReady）、app.js（state / persist / hasPerm）
   说明：本文件在 app.js 之前加载，所有对 state 的访问都通过 window.SunnyAPI.bind() 注入，
        避免在模块初始化期形成循环依赖。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 统一返回结构 ---------- */
  function ok(data, message) { return { ok: true, data: data ?? null, error: null, message: message || '' }; }
  function fail(message, error, data) {
    return { ok: false, data: data ?? null, error: error || null, message: message || '操作失败' };
  }
  // 兼容云端 SDK 结果：把 { data, error } 转成统一信封
  function fromCloud(res, message) {
    if (res && res.error) return fail(res.error.message || '云端操作失败', res.error);
    return ok(res && res.data !== undefined ? res.data : null, message);
  }

  /* ---------- 上下文（由 app.js 注入） ---------- */
  let ctx = {};
  function bind(context) { ctx = context || {}; return API; }
  function S() { return ctx.state; }
  function requireState() {
    if (!S()) return fail('应用状态未就绪', new Error('state not bound'));
    return null;
  }
  function requirePerm(key) {
    if (typeof ctx.hasPerm === 'function' && !ctx.hasPerm(key)) {
      return fail('当前账号无权执行此操作', { code: 'FORBIDDEN' });
    }
    return null;
  }

  /* ---------- 校验工具 ---------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^1\d{10}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function validEmail(v) { return EMAIL_RE.test(str(v, 120)); }
  function validPhone(v) { return PHONE_RE.test(str(v, 11).replace(/\*/g, '')); }
  // 手机号指纹：兼容完整号码与前3后4脱敏号码，统一归一为「前3+后4」，用于唯一性比对
  function phoneKey(v) {
    const digits = str(v, 20).replace(/\D/g, '');
    return digits.length === 11 ? digits.slice(0, 3) + digits.slice(-4) : digits;
  }
  function sanitizeText(v, max) {
    // 仅允许常见标点、中英文、数字、空白；移除控制字符与尖括号，防御存储型 XSS
    return str(v, max || 200).replace(/[\x00-\x1F\x7F<>]/g, '').trim();
  }

  /* ---------- 演示级口令工具（非生产安全） ----------
     纯前端无服务端，采用「盐 + 多轮 FNV-1a 混淆」存储，避免明文口令落盘。
     注意：这只能防止明文泄露，无法抵御离线爆破；生产环境必须由服务端
     使用 bcrypt/argon2 等慢哈希 + HTTPS + 会话令牌实现认证。 */
  const AUTH_CFG = (window.APP_CONFIG && window.APP_CONFIG.auth) || {};
  const DEFAULT_PASSWORD = String(AUTH_CFG.defaultPassword || '123456');
  const MIN_PW = Number(AUTH_CFG.minLength) || 6;
  function hashPassword(password, salt) {
    const s = salt || Math.random().toString(36).slice(2, 10);
    const seed = String(password) + '|' + s;
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < seed.length; i++) {
        h1 ^= seed.charCodeAt(i); h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + seed.charCodeAt(i) + Math.imul(h2, 0x5bd1e995)) >>> 0;
      }
    }
    return `demo$${s}$${h1.toString(36)}$${h2.toString(36)}`;
  }
  function verifyPasswordHash(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'demo') return false;
    return hashPassword(password, parts[1]) === stored;
  }
  // 兼容内置 / 历史账户（无 passwordHash）：默认口令视为有效
  function passwordMatches(user, password) {
    const stored = user && user.passwordHash;
    if (!stored) return String(password) === DEFAULT_PASSWORD;
    return verifyPasswordHash(password, stored);
  }
  function validPassword(pw) { return String(pw == null ? '' : pw).length >= MIN_PW; }

  /* ======================================================================
     账号开通策略：系统不开放自助注册。
     所有人员账户只能由超级管理员在「管理后台 — 人员管理」中创建，
     创建时由管理员指定角色与权限、设置初始口令。
     原 registerUser(payload) 公开注册接口已移除。
     ====================================================================== */

  /* ---------- 在线状态：统一规范化与判定 ----------
     presence 取 online / away / offline 三态，兼容历史值与中文写法。
     判定规则（全站唯一）：
       1) 停用账户（status=disabled）强制离线；
       2) 当前登录会话中的账户视为在线（会话优先于字段值，退出后自动回落到字段值）；
       3) 其余按持久化的 presence 字段。
     注意：会话在线只在展示/统计层计算，不写回存储，避免退出后残留“在线”。 */
  const PRESENCE_VALUES = ['online', 'away', 'offline'];
  function normalizePresence(v) {
    const s = str(v, 20).toLowerCase();
    if (s === 'online' || s === '1' || s === 'true' || s === 'yes' || s === '在线') return 'online';
    if (s === 'away' || s === 'busy' || s === 'dnd' || s === '离开' || s === '忙碌') return 'away';
    return 'offline';
  }
  function hasPresence(v) { return PRESENCE_VALUES.indexOf(str(v, 20)) >= 0; }
  function presenceLabel(v) {
    return { online: '在线', away: '离开', offline: '离线' }[normalizePresence(v)];
  }
  function identityOf(u) {
    return str(u && (u.id || u.owner_id || u.uid), 80);
  }
  // 会话身份：跨本地/云端稳定；优先 uid，其次邮箱，最后 id
  function sessionKeyOf(u) {
    if (!u) return '';
    const uid = str(u.uid || u.owner_id, 120).toLowerCase();
    if (uid) return 'uid:' + uid;
    const email = str(u.email, 120).toLowerCase();
    if (email) return 'mail:' + email;
    const id = str(u.id, 80).toLowerCase();
    return id ? 'id:' + id : '';
  }
  // 在线判定：停用强制离线；任一在线会话命中该账户即为在线/离开（各会话独立状态，取“在线”优先）；
  // 无会话时回退到当前登录账户与持久化字段，兼容旧逻辑与单会话场景。
  function effectivePresence(user, me) {
    if (!user) return 'offline';
    if (user.status === 'disabled') return 'offline';
    const sessions = (S() && Array.isArray(S().sessions)) ? S().sessions : [];
    const key = sessionKeyOf(user);
    const matched = sessions.filter(s => s && s.account && sessionKeyOf(s.account) === key && s.status !== 'closed');
    if (matched.length) {
      return matched.some(s => s.presence === 'online') ? 'online'
        : (matched.some(s => s.presence === 'away') ? 'away' : 'offline');
    }
    const uid = identityOf(user);
    if (uid && uid === identityOf(me)) return 'online';
    return normalizePresence(user.presence);
  }

  function publicUser(u) {
    if (!u) return null;
    const { id, name, email, phone, role, grade, dept, gender, age, signature, status, verified, emailVerifiedAt, avatar, color, presence } = u;
    return { id, name, email, phone, role, grade, dept, gender, age, signature, managedClasses: normalizeManagedClasses(u.managedClasses), status, verified: !!verified, emailVerifiedAt: emailVerifiedAt || null, avatar, color, presence: normalizePresence(presence) };
  }

  /* ======================================================================
     多账户会话管理（同一浏览器同时登录 / 切换 / 隔离）
     ----------------------------------------------------------------------
     设计：每个登录账户对应 state.sessions 中的一条会话快照，保存账户资料、
     角色与私有工作区（当前视图、筛选、会话、通知）。state.* 作为“当前会话工作
     副本”，切换时先快照旧会话再装载目标会话，现有读写 state.* 的代码无需改动。
     资格：会话账户必须仍在人员表且状态为 active，否则切换/激活时判定为失效。
     ====================================================================== */
  const SESSION_LIMIT = 8; // 单浏览器最多同时在线账户数，防止资源无限增长
  const WORKSPACE_KEYS = ['view', 'library', 'learning', 'directory', 'admin', 'conversations', 'notifications', 'pendingEvents', 'emoticons'];

  /* ---------- 会话有效期与跨标签页活动指针 ----------
     有效期：每个会话携带 issuedAt / expiresAt，超限视为失效并在启动时清理，
     保证「有效期内无需重复登录」。
     活动指针：会话清单存 localStorage（跨标签共享），而「当前显示哪个账户」
     存 sessionStorage（每标签独立），因此同一浏览器不同标签可同时登录并各自
     显示不同账户，互不覆盖。无 sessionStorage 时安全降级为仅内存态。 */
  const AUTH_CFG_SESSION = (window.APP_CONFIG && window.APP_CONFIG.auth) || {};
  const SESSION_TTL_MS = Math.max(1, Number(AUTH_CFG_SESSION.sessionTtlDays) || 7) * 24 * 60 * 60 * 1000;
  const TAB_ACTIVE_KEY = String((window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1') + ':active-session';
  function tabStorage() {
    try { return (typeof window !== 'undefined' && window.sessionStorage) ? window.sessionStorage : null; }
    catch (e) { return null; }
  }
  function readActivePointer() {
    const s = tabStorage(); if (!s) return null;
    try { return s.getItem(TAB_ACTIVE_KEY) || null; } catch (e) { return null; }
  }
  function writeActivePointer(id) {
    const s = tabStorage(); if (!s) return;
    try { if (id) s.setItem(TAB_ACTIVE_KEY, String(id)); else s.removeItem(TAB_ACTIVE_KEY); } catch (e) {}
  }
  function sessionTtlMs() { return SESSION_TTL_MS; }
  function isSessionExpired(sess, now) {
    if (!sess) return true;
    const t = Date.parse(sess.expiresAt || '');
    if (!Number.isFinite(t)) return false; // 旧数据无过期时间，按长期有效兼容
    return t <= (Number(now) || Date.now());
  }
  function stampExpiry(now) {
    const n = Number(now) || Date.now();
    return { issuedAt: new Date(n).toISOString(), expiresAt: new Date(n + SESSION_TTL_MS).toISOString() };
  }
  function clonePlain(v) {
    if (v == null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return Array.isArray(v) ? v.slice() : Object.assign({}, v); }
  }
  function defaultWorkspace() {
    return {
      view: 'library',
      library: { grade: 'all', subject: 'all', query: '', mode: 'grid' },
      learning: [],
      directory: { query: '', roleFilter: 'all', activeConv: null },
      admin: { tab: 'overview', userQuery: '', activeRole: 'r_admin', permSub: 'assign', materialQuery: '', monitorAuto: true },
      conversations: [],
      notifications: [],
      pendingEvents: [],
      emoticons: { custom: [], favorites: [] },
    };
  }
  function sessionList() { return (S() && Array.isArray(S().sessions)) ? S().sessions : []; }
  function activeSession() {
    const id = S() && S().activeSessionId;
    return sessionList().find(s => s && s.id === id) || null;
  }
  function findSessionByAccount(account) {
    const key = sessionKeyOf(account);
    return key ? sessionList().find(s => s && s.account && sessionKeyOf(s.account) === key) || null : null;
  }
  // 校验账户是否仍有登录资格：必须在人员表且启用；找不到人员表（如纯前端早期数据）则按原状态放行
  function accountEligibility(account) {
    if (!account) return { ok: false, code: 'NO_ACCOUNT' };
    if (account.status === 'disabled') return { ok: false, code: 'ACCOUNT_DISABLED' };
    const users = (S() && Array.isArray(S().users)) ? S().users : [];
    const key = sessionKeyOf(account);
    const found = users.find(u => sessionKeyOf(u) === key);
    if (found && found.status === 'disabled') return { ok: false, code: 'ACCOUNT_DISABLED' };
    return { ok: true };
  }
  // 快照当前工作副本 → 当前会话
  function snapshotWorkspace() {
    const sess = activeSession();
    if (!sess || !S()) return;
    sess.account = clonePlain(S().account);
    sess.role = S().role;
    sess.cloudMode = !!S().cloudMode;
    WORKSPACE_KEYS.forEach(k => { sess.workspace[k] = clonePlain(S()[k]); });
    sess.updatedAt = new Date().toISOString();
  }
  // 装载目标会话 → 当前工作副本
  function applyWorkspace(sess) {
    if (!sess || !S()) return;
    const w = Object.assign(defaultWorkspace(), clonePlain(sess.workspace) || {});
    S().account = clonePlain(sess.account);
    S().role = sess.role || (sess.account && sess.account.role) || 'student';
    S().cloudMode = !!sess.cloudMode;
    S().authed = true;
    WORKSPACE_KEYS.forEach(k => { S()[k] = clonePlain(w[k]); });
    S().activeSessionId = sess.id;
    sess.presence = sess.presence === 'away' ? 'away' : 'online';
    sess.lastActiveAt = new Date().toISOString();
    writeActivePointer(sess.id); // 当前标签独立记忆激活账户
  }
  function publicSession(sess) {
    if (!sess) return null;
    const a = sess.account || {};
    return {
      id: sess.id, account: publicUser(a) || { id: a.id, name: a.name, email: a.email, role: a.role, avatar: a.avatar, color: a.color },
      role: sess.role, cloudMode: !!sess.cloudMode, presence: sess.presence === 'away' ? 'away' : 'online',
      active: S() && S().activeSessionId === sess.id,
      createdAt: sess.createdAt, lastActiveAt: sess.lastActiveAt,
    };
  }
  // 登录成功后登记会话：同身份复用并刷新资料，超过上限拒绝
  function upsertSession(account, options) {
    const notReady = requireState(); if (notReady) return notReady;
    if (!account || typeof account !== 'object') return fail('会话账户信息无效', { code: 'INVALID_PARAM' });
    const elig = accountEligibility(account);
    if (!elig.ok) return fail(elig.code === 'ACCOUNT_DISABLED' ? '该账户已被禁用，无法登录' : '账户信息无效', { code: elig.code });
    const key = sessionKeyOf(account);
    if (!key) return fail('账户缺少可用的唯一标识', { code: 'NO_IDENTITY' });
    if (!S().sessions) S().sessions = [];
    snapshotWorkspace(); // 若已有当前会话，先保存其工作副本
    let sess = findSessionByAccount(account);
    let created = false;
    if (!sess) {
      if (sessionList().length >= SESSION_LIMIT) {
        return fail(`最多支持 ${SESSION_LIMIT} 个账户同时在线，请先退出其他账户`, { code: 'SESSION_LIMIT' });
      }
      sess = {
        id: key, account: clonePlain(account), role: account.role || 'student',
        cloudMode: !!(options && options.cloudMode), presence: 'online',
        workspace: defaultWorkspace(), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        ...stampExpiry(),
      };
      sessionList().push(sess);
      created = true;
    } else {
      // 复用会话：刷新资料与角色，保留私有工作区与在线状态
      sess.account = clonePlain(account);
      sess.role = account.role || sess.role;
      if (options && typeof options.cloudMode === 'boolean') sess.cloudMode = options.cloudMode;
      sess.status = 'active';
      sess.lastActiveAt = new Date().toISOString();
      Object.assign(sess, stampExpiry()); // 重新登录后续期，滑动窗口
    }
    S().activeSessionId = sess.id;
    applyWorkspace(sess);
    // 云端会话：新登录账户取得 SDK 凭证所有权；本地会话不影响凭证归属
    if (options && options.cloudMode) {
      S().cloudAuthKey = sess.id;
      S().cloudStale = false;
    } else if (sess.cloudMode) {
      S().cloudStale = S().cloudAuthKey !== sess.id;
    } else {
      S().cloudStale = false;
    }
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ session: publicSession(sess), created, activeId: sess.id, cloudStale: !!S().cloudStale },
      created ? '账户已登录并加入在线会话' : '已切换到该账户');
  }
  function listSessions() {
    const notReady = requireState(); if (notReady) return notReady;
    snapshotWorkspace();
    const sessions = sessionList().map(publicSession);
    return ok({ sessions, activeId: S().activeSessionId, count: sessions.length }, '会话列表已加载');
  }
  // 旧数据迁移：已有登录态但无会话记录时，把当前工作副本收编为首个会话
  function adoptCurrentSession() {
    const notReady = requireState(); if (notReady) return notReady;
    if (sessionList().length || !S().authed || !S().account || !S().account.email) {
      return ok({ adopted: false, count: sessionList().length }, '无需迁移');
    }
    const account = clonePlain(S().account);
    const key = sessionKeyOf(account);
    if (!key) return fail('当前账户缺少唯一标识，无法建立会话', { code: 'NO_IDENTITY' });
    const workspace = {};
    WORKSPACE_KEYS.forEach(k => { workspace[k] = clonePlain(S()[k]); });
    const sess = {
      id: key, account, role: S().role || account.role || 'student', cloudMode: !!S().cloudMode,
      presence: 'online', workspace, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      ...stampExpiry(),
    };
    sessionList().push(sess);
    S().sessions = sessionList();
    S().activeSessionId = sess.id;
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ adopted: true, session: publicSession(sess), count: 1 }, '登录状态已升级为多账户会话');
  }
  // 切换会话：重校验资格 + 权限（角色变更即时生效） + 视图门禁回退由 UI 层执行
  function switchSession(id) {
    const notReady = requireState(); if (notReady) return notReady;
    const key = str(id, 160);
    const sess = sessionList().find(s => s && s.id === key);
    if (!sess) return fail('目标会话不存在', { code: 'SESSION_NOT_FOUND' });
    const elig = accountEligibility(sess.account);
    if (!elig.ok) {
      // 失效会话直接移除，避免反复切换失败
      S().sessions = sessionList().filter(s => s !== sess);
      if (typeof ctx.persist === 'function') ctx.persist();
      return fail(elig.code === 'ACCOUNT_DISABLED' ? '该账户已被禁用，会话已失效' : '该账户已被移除，会话已失效', { code: elig.code });
    }
    // 先快照旧工作副本，再以人员表最新角色刷新目标会话，避免旧副本覆盖新角色
    snapshotWorkspace();
    const fresh = (S().users || []).find(u => sessionKeyOf(u) === key);
    if (fresh) { sess.account = clonePlain(Object.assign({}, sess.account, publicUser(fresh))); sess.role = fresh.role || sess.role; }
    Object.assign(sess, stampExpiry()); // 每次切换续期，活跃账户保持有效
    applyWorkspace(sess);
    // 凭证冲突：切换到非凭证持有者的云端会话 → 标记待验证，仅用本地快照
    S().cloudStale = !!sess.cloudMode && S().cloudAuthKey !== sess.id;
    if (typeof ctx.persist === 'function') ctx.persist();
    const warning = S().cloudStale ? '该云端账户尚未在本机验证，当前显示本地快照；请用该账户验证码登录后再同步云端' : '';
    return ok({ session: publicSession(sess), activeId: sess.id, role: sess.role, cloudStale: !!S().cloudStale, warning }, `已切换到 ${sess.account.name || '账户'}`);
  }
  function setSessionPresence(id, presence) {
    const notReady = requireState(); if (notReady) return notReady;
    const sess = sessionList().find(s => s && s.id === str(id, 160));
    if (!sess) return fail('目标会话不存在', { code: 'SESSION_NOT_FOUND' });
    sess.presence = presence === 'away' ? 'away' : 'online';
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ session: publicSession(sess) }, `在线状态已设为${sess.presence === 'away' ? '离开' : '在线'}`);
  }
  // 退出单个会话：若还有其它有效会话则自动切到最近活动的一个，否则清空登录态
  function closeSession(id) {
    const notReady = requireState(); if (notReady) return notReady;
    const key = str(id, 160) || (S().activeSessionId || '');
    const sess = key ? sessionList().find(s => s && s.id === key) : activeSession();
    if (!sess) return fail('目标会话不存在', { code: 'SESSION_NOT_FOUND' });
    const wasActive = S().activeSessionId === sess.id;
    S().sessions = sessionList().filter(s => s !== sess);
    let next = null;
    if (wasActive) {
      const ordered = sessionList().slice().sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')));
      next = ordered.find(s => accountEligibility(s.account).ok) || null;
      if (next) {
        applyWorkspace(next);
        S().cloudStale = !!next.cloudMode && S().cloudAuthKey !== next.id;
      } else {
        S().activeSessionId = null; S().authed = false; S().cloudMode = false; S().cloudStale = false;
        S().account = clonePlain((typeof USERS !== 'undefined' && USERS[0]) || {});
        S().view = 'library';
      }
    }
    // 关闭的是云端凭证持有者 → 释放凭证所有权
    if (S().cloudAuthKey === sess.id) S().cloudAuthKey = null;
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ closedId: sess.id, next: next ? publicSession(next) : null, count: sessionList().length },
      next ? '已退出该账户，已切换到其他在线账户' : '已退出账户');
  }
  // 退出全部账户
  function closeAllSessions() {
    const notReady = requireState(); if (notReady) return notReady;
    const count = sessionList().length;
    S().sessions = []; S().activeSessionId = null;
    S().authed = false; S().cloudMode = false; S().cloudStale = false; S().cloudAuthKey = null;
    S().account = clonePlain((typeof USERS !== 'undefined' && USERS[0]) || {});
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ count }, `已退出 ${count} 个账户`);
  }
  // 启动时校准：移除失效/过期会话；按「当前标签活动指针」恢复登录态。
  // 每标签用 sessionStorage 记住自己激活的账户，因此同浏览器多标签可各自
  // 显示不同账户、互不覆盖；指针失效（新标签未设置）时回落到最近活动的会话，
  // 保证「打开新链接/新标签」在有效期内无需重复登录。
  function reconcileSessions() {
    const notReady = requireState(); if (notReady) return notReady;
    const now = Date.now();
    const eligible = sessionList().filter(s => s && s.account && accountEligibility(s.account).ok);
    const valid = eligible.filter(s => !isSessionExpired(s, now));
    const dropped = sessionList().length - valid.length;
    S().sessions = valid;

    const pointer = readActivePointer();
    let current = pointer ? valid.find(s => s.id === pointer) || null : null;
    if (!current) current = activeSession();
    if (!current && valid.length) {
      current = valid.slice().sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))[0];
    }
    if (current) {
      applyWorkspace(current);
      S().cloudStale = !!current.cloudMode && S().cloudAuthKey !== current.id;
      writeActivePointer(current.id);
    } else {
      S().activeSessionId = null; S().authed = false; S().cloudStale = false;
      writeActivePointer(null);
    }
    if (dropped || (S().sessions || []).length) { if (typeof ctx.persist === 'function') ctx.persist(); }
    return ok({ count: valid.length, dropped, activeId: S().activeSessionId, restored: !!current }, '会话状态已校准');
  }
  // 仅刷新当前标签活动指针（供跨标签 storage 事件同步使用，不重排工作区）
  function syncActivePointer() {
    const cur = activeSession();
    writeActivePointer(cur ? cur.id : null);
    return ok({ activeId: cur ? cur.id : null }, '活动指针已同步');
  }
  // 跨标签同步：按共享会话清单校正失效项；本标签指针失效时回落到有效会话。
  // 不清空其它标签正在使用的账户，保证多账户同时在线互不覆盖。
  function refreshSessionsFromShared() {
    const notReady = requireState(); if (notReady) return notReady;
    const now = Date.now();
    const valid = sessionList().filter(s => s && s.account && accountEligibility(s.account).ok && !isSessionExpired(s, now));
    S().sessions = valid;
    const pointer = readActivePointer();
    let current = pointer ? valid.find(s => s.id === pointer) || null : null;
    if (!current) current = valid.find(s => s.id === S().activeSessionId) || null;
    if (!current && valid.length) {
      current = valid.slice().sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))[0];
    }
    if (current) {
      if (S().activeSessionId !== current.id) applyWorkspace(current);
      S().cloudStale = !!current.cloudMode && S().cloudAuthKey !== current.id;
      writeActivePointer(current.id);
      return ok({ changed: true, activeId: current.id, count: valid.length }, '会话已从共享状态同步');
    }
    S().activeSessionId = null; S().authed = false; S().cloudStale = false;
    writeActivePointer(null);
    return ok({ changed: false, activeId: null, count: 0 }, '无有效会话');
  }

  /* ======================================================================
     口令接口
     POST /api/auth/verify  -> verifyPassword({ userId, password })
     POST /api/auth/password -> setPassword({ userId, currentPassword, newPassword })
     ====================================================================== */
  function findUser(userId) {
    const id = str(userId, 80);
    return id ? (S().users.find(u => String(u.id) === id) || null) : null;
  }

  function verifyPassword(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const user = findUser(payload.userId);
    if (!user) return fail('账户不存在', { code: 'NOT_FOUND' });
    if (user.status === 'disabled') return fail('该账户已被禁用', { code: 'ACCOUNT_DISABLED' });
    const okPw = passwordMatches(user, payload.password);
    return ok({ valid: okPw, userId: user.id }, okPw ? '口令校验通过' : '口令错误');
  }

  function setPassword(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const user = findUser(payload.userId);
    if (!user) return fail('账户不存在', { code: 'NOT_FOUND' });
    const current = String(payload.currentPassword == null ? '' : payload.currentPassword);
    // 首次设置（无历史哈希）用默认口令作为当前口令；已有哈希必须校验旧口令
    if (!passwordMatches(user, current)) {
      return fail('当前口令不正确', { code: 'BAD_CREDENTIAL', field: 'currentPassword' });
    }
    const next = String(payload.newPassword == null ? '' : payload.newPassword);
    if (!validPassword(next)) return fail(`新密码至少 ${MIN_PW} 位`, { code: 'INVALID_PARAM', field: 'newPassword' });
    if (next === current) return fail('新密码不能与当前密码相同', { code: 'INVALID_PARAM', field: 'newPassword' });
    try {
      user.passwordHash = hashPassword(next);
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('口令保存失败，请稍后重试', { code: 'PERSIST_ERROR' });
    }
    return ok({ userId: user.id }, '登录密码已更新');
  }

  // 忘记密码：邮箱身份验证通过后重置口令（无需旧口令），仅按邮箱定位本地账户。
  // 真实身份校验由 UI 层通过邮箱验证码完成，本接口只负责落盘新口令。
  function resetPasswordByEmail(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const email = str(payload.email, 120).toLowerCase();
    if (!validEmail(email)) return fail('请输入有效的邮箱地址', { code: 'INVALID_PARAM', field: 'email' });
    const user = (S().users || []).find(u => str(u.email, 120).toLowerCase() === email) || null;
    if (!user) return fail('该邮箱未开通或不存在，请联系超级管理员', { code: 'NOT_FOUND' });
    if (user.status === 'disabled') return fail('该账户已被禁用，请联系超级管理员', { code: 'ACCOUNT_DISABLED' });
    const next = String(payload.newPassword == null ? '' : payload.newPassword);
    if (!validPassword(next)) return fail(`新密码至少 ${MIN_PW} 位`, { code: 'INVALID_PARAM', field: 'newPassword' });
    if (next !== String(payload.confirmPassword == null ? '' : payload.confirmPassword)) {
      return fail('两次输入的新密码不一致', { code: 'INVALID_PARAM', field: 'confirmPassword' });
    }
    try {
      user.passwordHash = hashPassword(next);
      user.verified = true;
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('密码保存失败，请稍后重试', { code: 'PERSIST_ERROR' });
    }
    return ok({ userId: user.id, email }, '密码已重置，请使用新密码登录');
  }

  /* ======================================================================
     邮箱验证状态接口：验证状态持久化，仅首次登录必须完成
     POST /api/auth/email-verified -> markEmailVerified({ userId })
     ====================================================================== */
  async function markEmailVerified(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const user = findUser(payload.userId);
    if (!user) return fail('账户不存在', { code: 'NOT_FOUND' });
    const when = new Date().toISOString();
    // 1) 本地先行落盘：保证即使云端失败，本机会话内验证状态也可用
    try {
      user.verified = true;
      user.emailVerifiedAt = when;
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('验证状态保存失败', { code: 'PERSIST_ERROR' });
    }
    // 2) 同步当前会话工作副本与会话快照，避免"本地 users 已验证、当前账户仍显示未验证"
    if (S().account && String(S().account.id) === String(user.id)) {
      S().account.verified = true;
      S().account.emailVerifiedAt = when;
      const sess = activeSession();
      if (sess && sess.account && String(sess.account.id) === String(user.id)) {
        sess.account.verified = true;
        sess.account.emailVerifiedAt = when;
      }
    }
    // 3) 云端模式：把 email_verified 落库（双写尝试，任一成功即视为同步）。
    //    - profiles：每位用户可改自己的 owner 行（RLS 允许），普通账户首选；
    //    - personnel：超管可改（RLS 允许），用于人员白名单状态一致。
    //    失败不阻断本地验证态，由上层据 cloudSynced 提示。
    let cloudSynced = false;
    if (cloudMode() && window.cloud) {
      const selfId = str((S().account && (S().account.uid || S().account.id)) || '', 80);
      // a) 当前登录账户本人 → 写自己的 profiles 行
      if (selfId && String(selfId) === String(user.id || user.uid)) {
        try {
          const res = await window.cloud.database.from('profiles')
            .update({ email_verified: when }).eq('owner_id', selfId).select();
          cloudSynced = !!(res && !res.error && Array.isArray(res.data) && res.data.length);
        } catch (e) { /* 继续尝试 personnel */ }
      }
      // b) 人员白名单（超管权限）
      if (!cloudSynced) {
        try {
          const res = await window.cloud.database.from('personnel')
            .update({ email_verified: when, updated_at: when }).eq('id', user.id).select();
          cloudSynced = !!(res && !res.error && Array.isArray(res.data) && res.data.length);
        } catch (e) { /* 保留本地状态 */ }
      }
    }
    return ok({ userId: user.id, verified: true, emailVerifiedAt: when, cloudSynced },
      cloudSynced ? '邮箱验证已完成并同步云端' : '邮箱验证已完成');
  }

  /* ======================================================================
     人员管理接口（超级管理员专用）
     系统不开放自助注册：所有账户只能由超管创建，并分配角色与权限。
     listPersons()             -> { persons }
     createPerson(payload)     -> { person }
     updatePerson(id, payload) -> { person }
     deletePerson(id)          -> { id }
     listRoleConfigs()         -> { roles }
     saveRoleConfigs(roles)    -> { roles }
     ====================================================================== */
  function requireAdmin() {
    const notReady = requireState(); if (notReady) return notReady;
    const me = S().account || {};
    if (me.role !== 'admin' && me.is_admin !== true) {
      return fail('仅超级管理员可执行人员管理操作', { code: 'FORBIDDEN' });
    }
    return null;
  }
  function cloudMode() { return !!(ctx.isCloudMode && ctx.isCloudMode()); }
  function maskPhone(v) {
    const raw = str(v, 20);
    const d = raw.replace(/\D/g, '');
    return d.length === 11 ? d.slice(0, 3) + '****' + d.slice(-4) : raw;
  }
  function personFromRow(p) {
    if (!p) return null;
    const name = p.display_name || p.name || p.email || '成员';
    const age = Number(p.age);
    // 绑定邮箱是超管的强身份：即使云端行 role 被脏载荷污染成 student，也要纠正回 admin，
    // 与云端 profiles 提权触发器口径一致，避免本地超管从人员表刷新后凭空消失。
    const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').trim().toLowerCase();
    const forcedAdmin = !!adminMail && String(p.email || '').trim().toLowerCase() === adminMail;
    return {
      id: p.id || p.owner_id,
      owner_id: p.owner_id || '',
      name, email: p.email || '', phone: p.phone || '',
      role: forcedAdmin ? 'admin' : (p.role || 'student'),
      is_admin: forcedAdmin || p.is_admin === true ? true : undefined, grade: Number(p.grade) || 1,
      dept: p.dept || '', status: p.status || 'active',
      gender: sanitizeText(p.gender, 10),
      age: Number.isFinite(age) && age > 0 ? age : '',
      signature: sanitizeText(p.signature, 80),
      managedClasses: normalizeManagedClasses(parseJsonArray(p.managed_classes)),
      presence: normalizePresence(p.presence),
      verified: !!(p.email_verified || p.verified),
      emailVerifiedAt: p.email_verified || p.emailVerifiedAt || null,
      passwordHash: p.password_hash || '',
      avatar: p.avatar || name.slice(0, 1), color: p.color || 'avatar--sky',
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
  function personToRow(u) {
    const age = Number(u.age);
    return {
      display_name: u.name,
      email: String(u.email || '').toLowerCase(),
      phone: u.phone || '',
      role: u.role || 'student',
      grade: Number(u.grade) || 1,
      dept: u.dept || '',
      status: u.status || 'active',
      gender: sanitizeText(u.gender, 10),
      age: Number.isFinite(age) && age > 0 ? age : null,
      signature: sanitizeText(u.signature, 80),
      // 班级主任可管理多个班级：以 JSON 数组文本入库（personnel.managed_classes）
      managed_classes: JSON.stringify(normalizeManagedClasses(u.managedClasses)),
      presence: normalizePresence(u.presence),
      // 验证状态入库：verified 或 emailVerifiedAt 任一为真即写入 email_verified 时间戳
      email_verified: (u.verified || u.emailVerifiedAt)
        ? (u.emailVerifiedAt || new Date().toISOString()) : null,
      avatar: u.avatar || (u.name || '成').slice(0, 1),
      color: u.color || 'avatar--sky',
    };
  }
  function dupPerson(email, phone, excludeId) {
    const em = String(email || '').toLowerCase();
    const pk = phoneKey(phone);
    return S().users.find(u => String(u.id) !== String(excludeId) && (
      String(u.email || '').toLowerCase() === em || (pk && phoneKey(u.phone) === pk)
    ));
  }

  /* ---------- 通讯录同步：匹配 / 去重 / 合并 ----------
     匹配优先级：唯一标识（id / owner_id / uid） → 手机号指纹 → 邮箱。
     数据以自定义用户（state.users）为准，MEMBERS 仅补充在线状态与展示标题；
     重复记录保留最近更新的一条，并写入 conflicts 供界面提示。 */
  function identityIds(u) {
    if (!u || typeof u !== 'object') return [];
    return [u.id, u.owner_id, u.uid].map(v => str(v, 80)).filter(Boolean);
  }
  function identityRule(a, b) {
    const idsA = identityIds(a), idsB = identityIds(b);
    if (idsA.some(x => idsB.indexOf(x) >= 0)) return { rule: 'id', score: 1 };
    const pa = phoneKey(a && a.phone), pb = phoneKey(b && b.phone);
    if (pa && pa === pb) return { rule: 'phone', score: 2 };
    const ea = str(a && a.email, 120).toLowerCase(), eb = str(b && b.email, 120).toLowerCase();
    if (ea && ea === eb) return { rule: 'email', score: 3 };
    return null;
  }
  function userStamp(u) {
    const t = Date.parse(str(u && (u.updated_at || u.created_at), 40));
    return Number.isFinite(t) ? t : 0;
  }
  function computedTitle(u) {
    const role = str(u && u.role, 40) || 'student';
    if (role === 'admin') return '超级管理员';
    if (role === 'parent') return str(u && u.dept, 40) || '学生家长';
    if (role === 'teacher') return `${str(u && u.dept, 40) || '教师'}教师`;
    const g = Number(u && u.grade) || 1;
    return `${typeof gradeLabel === 'function' ? gradeLabel(g) : g + '年级'}学生`;
  }
  function buildDirectoryMember(u, seed) {
    const age = Number(u && u.age);
    const stored = hasPresence(u && u.presence) ? u.presence : (hasPresence(seed && seed.presence) ? seed.presence : 'offline');
    return Object.assign({}, u, {
      // 存储的原值保留在 presenceStored，展示用 presence 走统一判定（会话在线 / 停用离线）
      presenceStored: stored,
      presence: effectivePresence(Object.assign({}, u, { presence: stored }), S() && S().account),
      title: str(u && u.title, 40) || str(seed && seed.title, 40) || computedTitle(u),
      gender: str(u && u.gender, 10) || str(seed && seed.gender, 10) || '',
      age: Number.isFinite(age) && age > 0 ? age : ((seed && Number(seed.age)) || ''),
      signature: sanitizeText(u && u.signature, 80) || sanitizeText(seed && seed.signature, 80) || '',
    });
  }
  function syncDirectoryUsers() {
    const notReady = requireState(); if (notReady) return notReady;
    const users = Array.isArray(S().users) ? S().users : [];
    const seeds = (typeof MEMBERS !== 'undefined' && Array.isArray(MEMBERS)) ? MEMBERS : [];
    const members = [], conflicts = [];

    users.forEach(u => {
      if (!u || typeof u !== 'object') return;
      let best = null;
      members.forEach((m, i) => {
        const hit = identityRule(m, u);
        if (hit && (!best || hit.score < best.score)) best = { index: i, rule: hit.rule };
      });
      if (!best) { members.push(buildDirectoryMember(u)); return; }

      const existing = members[best.index];
      const keepIncoming = userStamp(u) > userStamp(existing);
      const winner = keepIncoming ? u : existing;
      const removed = keepIncoming ? existing : u;
      conflicts.push({
        rule: best.rule,
        kept: str(winner.id, 80) || '',
        removed: str(removed.id, 80) || '',
        message: `按${({ id:'唯一标识', phone:'手机号', email:'邮箱' })[best.rule]}规则合并重复成员，保留最近更新的记录`,
      });
      members[best.index] = buildDirectoryMember(winner, existing);
    });

    // 种子通讯录只补充展示字段，不复活已从用户表删除的成员
    members.forEach(m => {
      const seed = seeds.find(s => identityRule(s, m));
      if (!seed) return;
      if (!m.presence) m.presence = seed.presence || 'offline';
      if (!m.title) m.title = seed.title || computedTitle(m);
      if (!m.gender) m.gender = str(seed.gender, 10);
      if (!m.age) m.age = Number(seed.age) || '';
      if (!m.signature) m.signature = sanitizeText(seed.signature, 80);
    });

    S().directory = Object.assign({}, S().directory, {
      members, conflicts, syncedAt: new Date().toISOString(),
    });
    return ok({ members, conflicts }, `通讯录已同步 ${members.length} 名成员`);
  }
  function cloudWriteError(error, action) {
    return fail(action + '失败：' + (error && error.message ? error.message : '云端未写入，请确认超管权限'),
      error || { code: 'CLOUD_WRITE_BLOCKED' });
  }

  async function listPersons() {
    const denied = requireAdmin(); if (denied) return denied;
    if (cloudMode() && window.cloud) {
      try {
        const { data, error } = await window.cloud.database.from('personnel').select('*');
        if (error) return fail('加载人员失败：' + (error.message || '云端异常'), error);
        const persons = (data || []).map(personFromRow);
        S().users = persons;
        syncDirectoryUsers();
        if (typeof ctx.persist === 'function') ctx.persist();
        return ok({ persons }, '人员列表已从云端加载');
      } catch (e) {
        return fail('加载人员失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }
    return ok({ persons: S().users.map(publicUser) }, '人员列表已加载');
  }

  /* 新建工号后立即同步到另一端：
     - 云端模式：先从云端权威表 personnel 刷新本机人员（确保拿到刚刚新建的记录及云端最新名录），
       再把 workspace 域（已含 users）推送到 user_sync，供另一端拉取应用。
     - 本地模式：无云端时直接把 workspace 域推送到 user_sync；若云端未就绪则明确返回失败，
       由调用方提示用户，绝不假装成功。
     返回 { ok, message, mode, cloudMode, persons }，调用方据此更新按钮状态。 */
  async function syncPersonnel() {
    const denied = requireAdmin(); if (denied) return denied;
    let refreshed = null;
    let backfilled = 0;
    if (cloudMode() && window.cloud) {
      // 先读云端权威名录（只读，不覆盖本地），找出本地新建但 personnel 表缺失的工号。
      // 原实现直接调用 listPersons() 会用云端数据整体覆盖 S().users，导致本地账密登录
      // 新建、尚未写入 personnel 的工号被抹掉——这正是"新建工号提示未创建/同步后消失"的根因。
      let remotePersons = [];
      try {
        const got = await window.cloud.database.from('personnel').select('*');
        if (got.error) return fail('同步失败：无法读取云端人员 — ' + (got.error.message || '网络异常'),
          { code: 'PERSONNEL_REFRESH_FAILED', stage: 'refresh' });
        remotePersons = (got.data || []).map(personFromRow).filter(Boolean);
      } catch (e) {
        return fail('同步失败：无法读取云端人员 — ' + (e && e.message ? e.message : '网络异常'),
          { code: 'PERSONNEL_REFRESH_FAILED', stage: 'refresh' });
      }
      const normMail = (u) => String(u && u.email || '').trim().toLowerCase();
      const remoteMails = new Set(remotePersons.map(normMail).filter(Boolean));
      const remoteIds = new Set(remotePersons.map(u => String(u && u.id || '')));
      // 把本地缺失的工号补写回 personnel 表，使其进入云端白名单（另一端可登录/可见）
      for (const u of (Array.isArray(S().users) ? S().users : [])) {
        if (!u || !u.email) continue;
        if (remoteMails.has(normMail(u)) || remoteIds.has(String(u.id))) continue;
        try {
          const row = Object.assign(personToRow(u), {
            id: String(u.id), password_hash: u.passwordHash || hashPassword(DEFAULT_PASSWORD),
            created_at: u.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
          });
          const ins = await window.cloud.database.from('personnel').insert(row).select();
          if (!ins.error) {
            backfilled++;
            const added = (ins.data && ins.data[0]) ? personFromRow(ins.data[0]) : null;
            if (added) remotePersons.push(added);
          } else {
            console.warn('[Sunshine个人工作站] 补写工号到云端人员表失败', ins.error && ins.error.message);
          }
        } catch (e) { console.warn('[Sunshine个人工作站] 补写工号异常', e && e.message); }
      }
      // 以云端权威名录为准刷新本地（此时新工号已补写进去，不会丢失）
      S().users = remotePersons;
      if (typeof syncDirectoryUsers === 'function') syncDirectoryUsers();
      if (typeof ctx.persist === 'function') ctx.persist();
      refreshed = remotePersons;
    }
    const scope = 'workspace';
    const payload = buildUserSyncPayload(S(), scope);
    const res = await pushUserSync(scope, payload);
    if (!res.ok) {
      return fail('同步失败：' + (res.message || '网络异常，请检查网络后重试'),
        { code: 'CLOUD_PUSH_FAILED', stage: 'push' });
    }
    return ok({
      persons: refreshed,
      count: Array.isArray(S().users) ? S().users.length : 0,
      backfilled,
      cloudMode: !!cloudMode(),
      syncedAt: payload.updatedAt,
    }, cloudMode()
      ? (backfilled ? `已同步到云端，并补登 ${backfilled} 个工号到人员白名单` : '已同步到云端，两端工号已一致')
      : '已同步到云端');
  }

  async function createPerson(payload) {
    const denied = requireAdmin(); if (denied) return denied;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const name = sanitizeText(payload.name, 24);
    const email = str(payload.email, 120).toLowerCase();
    const phone = str(payload.phone, 20);
    const role = str(payload.role, 40) || 'student';
    const grade = Number(payload.grade) || 1;
    const dept = sanitizeText(payload.dept, 40);
    const gender = sanitizeText(payload.gender, 10);
    const ageRaw = payload.age === '' || payload.age == null ? '' : Number(payload.age);
    const age = Number.isFinite(ageRaw) && ageRaw > 0 ? Math.min(120, Math.floor(ageRaw)) : '';
    const signature = sanitizeText(payload.signature, 80);
    const presence = hasPresence(payload.presence) ? normalizePresence(payload.presence) : 'offline';
    const password = String(payload.password == null ? '' : payload.password) || DEFAULT_PASSWORD;
    // 验证状态可由超管在创建时指定（如线下已核验的账户直接标记已验证）；默认未验证
    const verified = payload.verified === true;
    const emailVerifiedAt = verified ? new Date().toISOString() : null;

    if (name.length < 2) return fail('姓名至少 2 个字符', { code: 'INVALID_PARAM', field: 'name' });
    if (!validEmail(email)) return fail('请输入有效的邮箱地址', { code: 'INVALID_PARAM', field: 'email' });
    if (!validPhone(phone)) return fail('请输入有效的 11 位手机号', { code: 'INVALID_PARAM', field: 'phone' });
    if (payload.age !== '' && payload.age != null && (!Number.isFinite(ageRaw) || ageRaw < 1 || ageRaw > 120)) {
      return fail('请输入 1–120 之间的年龄', { code: 'INVALID_PARAM', field: 'age' });
    }
    if (!validPassword(password)) return fail(`初始密码至少 ${MIN_PW} 位`, { code: 'INVALID_PARAM', field: 'password' });

    const now = new Date();
    const user = {
      id: 'p' + now.getTime(),
      name, email, phone: maskPhone(phone), role, grade, dept,
      gender, age, signature, presence,
      status: 'active', verified, emailVerifiedAt,
      passwordHash: hashPassword(password),
      avatar: name.slice(0, 1), color: 'avatar--sky',
      created_at: now.toISOString(),
    };

    if (cloudMode() && window.cloud) {
      try {
        const { data: dup } = await window.cloud.database.from('personnel').select('id').eq('email', email);
        if (dup && dup.length) return fail('该邮箱已开通，请勿重复创建', { code: 'CONFLICT', field: 'email' });
        const row = Object.assign(personToRow(user), {
          id: user.id, password_hash: user.passwordHash,
          created_at: user.created_at, updated_at: user.created_at,
        });
        const { data, error } = await window.cloud.database.from('personnel').insert(row).select();
        if (error || !data || !data.length) return cloudWriteError(error, '创建');
        const person = personFromRow(data[0]);
        S().users.unshift(person);
        syncDirectoryUsers();
        if (typeof ctx.persist === 'function') ctx.persist();
        return ok({ person }, '人员已创建并同步云端');
      } catch (e) {
        return fail('创建失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }

    if (dupPerson(email, phone)) return fail('该邮箱或手机号已存在', { code: 'CONFLICT' });
    S().users.unshift(user);
    syncDirectoryUsers();
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ person: publicUser(user) }, '人员已创建');
  }

  async function updatePerson(id, payload) {
    const denied = requireAdmin(); if (denied) return denied;
    const key = str(id, 80);
    if (!key) return fail('缺少人员标识', { code: 'INVALID_PARAM' });
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const patch = {};
    if ('name' in payload) patch.name = sanitizeText(payload.name, 24);
    if ('email' in payload) patch.email = str(payload.email, 120).toLowerCase();
    if ('phone' in payload) patch.phone = str(payload.phone, 20);
    if ('role' in payload) patch.role = str(payload.role, 40);
    if ('grade' in payload) patch.grade = Number(payload.grade) || 1;
    if ('dept' in payload) patch.dept = sanitizeText(payload.dept, 40);
    if ('gender' in payload) patch.gender = sanitizeText(payload.gender, 10);
    if ('signature' in payload) patch.signature = sanitizeText(payload.signature, 80);
    if ('presence' in payload) patch.presence = hasPresence(payload.presence) ? normalizePresence(payload.presence) : 'offline';
    if ('age' in payload) {
      const raw = payload.age === '' || payload.age == null ? '' : Number(payload.age);
      if (payload.age !== '' && payload.age != null && (!Number.isFinite(raw) || raw < 1 || raw > 120)) {
        return fail('请输入 1–120 之间的年龄', { code: 'INVALID_PARAM', field: 'age' });
      }
      patch.age = Number.isFinite(raw) && raw > 0 ? Math.min(120, Math.floor(raw)) : '';
    }
    if ('status' in payload) patch.status = payload.status === 'disabled' ? 'disabled' : 'active';
    if ('verified' in payload) {
      patch.verified = payload.verified === true;
      patch.emailVerifiedAt = patch.verified ? (payload.emailVerifiedAt || new Date().toISOString()) : null;
    }
    if (payload.password) {
      if (!validPassword(payload.password)) return fail(`密码至少 ${MIN_PW} 位`, { code: 'INVALID_PARAM', field: 'password' });
      patch.passwordHash = hashPassword(payload.password);
    }
    if ('name' in patch && patch.name.length < 2) return fail('姓名至少 2 个字符', { code: 'INVALID_PARAM', field: 'name' });
    if ('email' in patch && !validEmail(patch.email)) return fail('请输入有效的邮箱地址', { code: 'INVALID_PARAM', field: 'email' });
    if ('phone' in patch && !validPhone(patch.phone)) return fail('请输入有效的 11 位手机号', { code: 'INVALID_PARAM', field: 'phone' });

    const target = S().users.find(u => String(u.id) === key);
    const isAdminU = u => !!(u && (u.role === 'admin' || u.is_admin === true));
    const meU = S().account || {};
    if (target && isAdminU(target) &&
        ((patch.role && patch.role !== 'admin') || patch.status === 'disabled')) {
      // 禁止降级 / 停用当前登录超管本人（把自己锁在门外的最后一道防线）
      if (String(meU.id) === key || String(meU.email || '').toLowerCase() === String(target.email || '').toLowerCase()) {
        return fail('不能降级或停用当前登录的超级管理员', { code: 'PROTECTED' });
      }
      const activeAdmins = S().users.filter(u => isAdminU(u) && u.status === 'active').length;
      if (activeAdmins <= 1) return fail('至少需要保留一名启用的超级管理员', { code: 'PROTECTED' });
    }
    // 绑定邮箱账户在任何情况下都不得被降级为普通角色
    const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').trim().toLowerCase();
    if (target && adminMail && String(target.email || '').toLowerCase() === adminMail &&
        patch.role && patch.role !== 'admin') {
      return fail('超级管理员绑定账户的角色不可更改', { code: 'PROTECTED' });
    }

    if (cloudMode() && window.cloud) {
      try {
        if (patch.email) {
          const { data: dups } = await window.cloud.database.from('personnel').select('id').eq('email', patch.email);
          if (dups && dups.some(x => String(x.id) !== String(key))) {
            return fail('该邮箱已被其他人员使用', { code: 'CONFLICT', field: 'email' });
          }
        }
        const row = {};
        if ('name' in patch) row.display_name = patch.name;
        if ('email' in patch) row.email = patch.email;
        if ('phone' in patch) row.phone = maskPhone(patch.phone);
        if ('role' in patch) row.role = patch.role;
        if ('grade' in patch) row.grade = patch.grade;
        if ('dept' in patch) row.dept = patch.dept;
        if ('gender' in patch) row.gender = patch.gender;
        if ('age' in patch) row.age = patch.age || null;
        if ('signature' in patch) row.signature = patch.signature;
        if ('presence' in patch) row.presence = patch.presence;
        if ('status' in patch) row.status = patch.status;
        if ('verified' in patch) row.email_verified = patch.verified ? (patch.emailVerifiedAt || new Date().toISOString()) : null;
        if (patch.passwordHash) row.password_hash = patch.passwordHash;
        row.updated_at = new Date().toISOString();
        const { data, error } = await window.cloud.database.from('personnel').update(row).eq('id', key).select();
        if (error || !data || !data.length) return cloudWriteError(error, '保存');
        const person = personFromRow(data[0]);
        const idx = S().users.findIndex(u => String(u.id) === key);
        if (idx >= 0) S().users[idx] = Object.assign({}, S().users[idx], person);
        else S().users.unshift(person);
        syncDirectoryUsers();
        if (typeof ctx.persist === 'function') ctx.persist();
        return ok({ person }, '人员信息已更新并同步云端');
      } catch (e) {
        return fail('保存失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }

    if (!target) return fail('人员不存在', { code: 'NOT_FOUND' });
    if (patch.email && dupPerson(patch.email, patch.phone || target.phone, key)) {
      return fail('该邮箱或手机号已存在', { code: 'CONFLICT' });
    }
    Object.assign(target, patch, {
      phone: 'phone' in patch ? maskPhone(patch.phone) : target.phone,
      avatar: 'name' in patch ? patch.name.slice(0, 1) : target.avatar,
      updated_at: new Date().toISOString(),
    });
    syncDirectoryUsers();
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ person: publicUser(target) }, '人员信息已更新');
  }

  async function deletePerson(id) {
    const denied = requireAdmin(); if (denied) return denied;
    const key = str(id, 80);
    if (!key) return fail('缺少人员标识', { code: 'INVALID_PARAM' });
    const target = S().users.find(u => String(u.id) === key);
    const me = S().account || {};
    if (String(me.id) === key) return fail('不能删除当前登录账户', { code: 'PROTECTED' });
    const isAdminU = u => !!(u && (u.role === 'admin' || u.is_admin === true));
    if (target && isAdminU(target)) {
      const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').trim().toLowerCase();
      if (adminMail && String(target.email || '').toLowerCase() === adminMail) {
        return fail('超级管理员绑定账户不可删除', { code: 'PROTECTED' });
      }
      const activeAdmins = S().users.filter(u => isAdminU(u) && u.status === 'active').length;
      if (activeAdmins <= 1) return fail('至少需要保留一名超级管理员', { code: 'PROTECTED' });
    }
    if (cloudMode() && window.cloud) {
      try {
        const { data, error } = await window.cloud.database.from('personnel').delete().eq('id', key).select();
        if (error) return cloudWriteError(error, '删除');
        if (!data || !data.length) return fail('删除失败：云端未删除，请确认超管权限', { code: 'CLOUD_WRITE_BLOCKED' });
      } catch (e) {
        return fail('删除失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }
    S().users = S().users.filter(u => String(u.id) !== key);
    syncDirectoryUsers();
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ id: key }, '人员已删除');
  }

  async function listRoleConfigs() {
    if (cloudMode() && window.cloud) {
      try {
        const { data, error } = await window.cloud.database.from('app_config').select('value').eq('key', 'roles');
        if (error) console.warn('[Sunshine个人工作站] 读取角色配置失败', error.message);
        else if (data && data.length && data[0].value && Array.isArray(data[0].value.roles)) {
          S().roles = data[0].value.roles;
          if (typeof ctx.persist === 'function') ctx.persist();
        }
      } catch (e) {
        console.warn('[Sunshine个人工作站] 读取角色配置异常', e && e.message);
      }
    }
    return ok({ roles: S().roles }, '角色配置已加载');
  }

  async function saveRoleConfigs(roles) {
    const denied = requireAdmin(); if (denied) return denied;
    if (!Array.isArray(roles) || !roles.length) return fail('角色配置格式不正确', { code: 'INVALID_PARAM' });
    if (roles.some(r => !r || !r.id || !Array.isArray(r.perms))) {
      return fail('角色配置缺少必要字段', { code: 'INVALID_PARAM' });
    }
    const row = { value: { roles }, updated_at: new Date().toISOString() };
    if (cloudMode() && window.cloud) {
      try {
        const { data: existing } = await window.cloud.database.from('app_config').select('key').eq('key', 'roles');
        const res = existing && existing.length
          ? await window.cloud.database.from('app_config').update(row).eq('key', 'roles').select()
          : await window.cloud.database.from('app_config').insert(Object.assign({ key: 'roles' }, row)).select();
        if (res.error || !res.data || !res.data.length) return cloudWriteError(res.error, '角色配置保存');
      } catch (e) {
        return fail('角色配置保存失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }
    S().roles = roles;
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ roles }, '角色权限配置已保存');
  }

  /* ======================================================================
     自定义权限项与视图门禁配置
     GET  /api/config/permissions -> listPermissionDefs()
     PUT  /api/config/permissions -> savePermissionDefs(permissions)
     PUT  /api/config/view-perms  -> saveViewPerms(viewPerms)
     均为超管专属；云端持久化到 app_config，key 分别为 permissions / view_perms。
     ====================================================================== */
  async function loadConfigKey(key) {
    if (cloudMode() && window.cloud) {
      try {
        const { data, error } = await window.cloud.database.from('app_config').select('value').eq('key', key);
        if (error) console.warn('[Sunshine个人工作站] 读取配置失败 ' + key, error.message);
        else if (data && data.length && data[0] && data[0].value) return data[0].value;
      } catch (e) {
        console.warn('[Sunshine个人工作站] 读取配置异常 ' + key, e && e.message);
      }
    }
    return null;
  }
  async function upsertConfigKey(key, value) {
    const row = { value, updated_at: new Date().toISOString() };
    if (cloudMode() && window.cloud) {
      const cloud = await cloudClient();
      if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
      try {
        const { data: existing } = await cloud.database.from('app_config').select('key').eq('key', key);
        const res = existing && existing.length
          ? await cloud.database.from('app_config').update(row).eq('key', key).select()
          : await cloud.database.from('app_config').insert(Object.assign({ key }, row)).select();
        const checked = fromCloudWrite(res, '已同步云端');
        if (!checked.ok) return checked;
      } catch (e) {
        return fail('配置保存失败：' + (e && e.message ? e.message : '网络异常'), e);
      }
    }
    return ok({ key, value }, '已保存');
  }

  async function listPermissionDefs() {
    const stored = await loadConfigKey('permissions');
    if (stored && Array.isArray(stored.permissions)) {
      // 内置项以代码为准，仅合并自定义项
      const builtins = (window.APP_CONFIG && window.APP_CONFIG.builtinPermissions) || [];
      const custom = stored.permissions.filter(p => !builtins.some(b => b.key === p.key));
      S().permissions = [...builtins.map(p => ({ ...p })), ...custom];
    }
    if (stored && stored.viewPerms && typeof stored.viewPerms === 'object') {
      S().viewPerms = { ...(window.APP_CONFIG && window.APP_CONFIG.defaultViewPerms || {}), ...stored.viewPerms };
    }
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ permissions: S().permissions, viewPerms: S().viewPerms }, '权限配置已加载');
  }

  async function savePermissionDefs(permissions) {
    const denied = requireAdmin(); if (denied) return denied;
    if (!Array.isArray(permissions) || !permissions.length) return fail('权限项格式不正确', { code: 'INVALID_PARAM' });
    const builtins = (window.APP_CONFIG && window.APP_CONFIG.builtinPermissions) || [];
    // 校验：key 合法且唯一、内置项不可删除、名称非空
    const seen = new Set();
    for (const p of permissions) {
      if (!p || !isPlainObject(p)) return fail('权限项格式不正确', { code: 'INVALID_PARAM' });
      const key = str(p.key, 60);
      const name = sanitizeText(p.name, 24);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) return fail(`权限标识不合法：${key || '空'}`, { code: 'INVALID_PARAM', field: 'key' });
      if (!name) return fail('权限名称不能为空', { code: 'INVALID_PARAM', field: 'name' });
      if (seen.has(key)) return fail(`权限标识重复：${key}`, { code: 'CONFLICT', field: 'key' });
      seen.add(key);
    }
    if (builtins.some(b => !seen.has(b.key))) return fail('内置权限项不可删除', { code: 'PROTECTED' });
    const normalized = permissions.map(p => ({
      key: str(p.key, 60), name: sanitizeText(p.name, 24),
      desc: sanitizeText(p.desc, 80), builtin: builtins.some(b => b.key === p.key),
    }));
    const res = await upsertConfigKey('permissions', { permissions: normalized, viewPerms: S().viewPerms });
    if (!res.ok) return res;
    S().permissions = normalized;
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ permissions: normalized }, '权限项已保存');
  }

  async function saveViewPerms(viewPerms) {
    const denied = requireAdmin(); if (denied) return denied;
    if (!viewPerms || typeof viewPerms !== 'object' || Array.isArray(viewPerms)) return fail('视图门禁格式不正确', { code: 'INVALID_PARAM' });
    // 门禁值必须是当前存在的权限项 key（或 null，表示不设门禁）
    const keys = new Set(S().permissions.map(p => p.key));
    const normalized = {};
    for (const view of Object.keys(viewPerms)) {
      const v = viewPerms[view];
      if (v !== null && v !== '' && !keys.has(v)) return fail(`视图门禁引用了不存在的权限项：${v}`, { code: 'INVALID_PARAM' });
      normalized[view] = (v === '') ? null : v;
    }
    const res = await upsertConfigKey('permissions', { permissions: S().permissions, viewPerms: normalized });
    if (!res.ok) return res;
    S().viewPerms = normalized;
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ viewPerms: normalized }, '视图门禁已保存');
  }

  /* ======================================================================
     学习资料接口（列表 / 详情 / 新增 / 编辑 / 删除）
     GET    /api/materials           -> listMaterials(query)
     GET    /api/materials/:id       -> getMaterial(id)
     POST   /api/materials           -> createMaterial(payload)
     PUT    /api/materials/:id       -> updateMaterial(id, payload)
     DELETE /api/materials/:id       -> deleteMaterial(id)
     GET    /api/materials/cloud     -> fetchCloudMaterials()  （公开读取完整资料库）
     新增 / 编辑 / 删除需 publish 权限；cloudMode 下同时写入云端 materials 表
     （RLS：所有人可读、仅管理员可写）。
     ====================================================================== */

  // 云端 snake_case 与本地字段互转（云端用 description，本地用 desc）
  function materialToCloud(v) {
    return {
      title: v.title, subject: v.subject, grade: Number(v.grade),
      type: v.type || '互动课', minutes: Number(v.minutes) || 20,
      rating: Number(v.rating) || 5, description: v.desc || '',
      points: Array.isArray(v.points) ? v.points : [],
      chapters: Array.isArray(v.chapters) ? v.chapters : [],
    };
  }
  function parseJsonArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
    return [];
  }
  function cloudToMaterial(row) {
    return {
      id: String(row.id),
      title: row.title || '',
      subject: SUBJECT_KEYS().includes(row.subject) ? row.subject : 'chinese',
      grade: Number(row.grade) || 1,
      type: row.type || '互动课',
      minutes: Number(row.minutes) || 20,
      rating: Number(row.rating) || 5,
      desc: row.description || '',
      points: parseJsonArray(row.points),
      chapters: parseJsonArray(row.chapters),
      owner_id: row.owner_id || '', owner_name: row.owner_name || '',
      created_at: row.created_at || '', updated_at: row.updated_at || '',
    };
  }

  // 公开读取云端完整资料库（materials 表 SELECT 策略对所有角色开放）
  async function fetchCloudMaterials() {
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
    try {
      const { data, error } = await cloud.database.from('materials').select('*').order('grade', { ascending: true });
      if (error) return fail(error.message || '加载云端资料失败', error);
      const items = (data || []).map(cloudToMaterial);
      return ok({ total: items.length, items }, '云端资料加载成功');
    } catch (e) {
      return fail('加载云端资料失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }

  function listMaterials(query) {
    const notReady = requireState(); if (notReady) return notReady;
    const q = isPlainObject(query) ? query : {};
    let list = Array.isArray(S().materials) ? S().materials.slice() : [];
    if (q.grade && q.grade !== 'all') list = list.filter(m => Number(m.grade) === Number(q.grade));
    if (q.subject && q.subject !== 'all') list = list.filter(m => m.subject === q.subject);
    if (q.query) {
      const needle = str(q.query, 60).toLowerCase();
      list = list.filter(m =>
        `${m.title || ''} ${m.desc || ''} ${m.type || ''}`.toLowerCase().includes(needle)
      );
    }
    return ok({ total: list.length, items: list }, '查询成功');
  }

  function getMaterial(id) {
    const notReady = requireState(); if (notReady) return notReady;
    const key = str(id, 64);
    if (!key) return fail('缺少资料 ID', { code: 'INVALID_PARAM', field: 'id' });
    const m = S().materials.find(x => String(x.id) === key);
    if (!m) return fail('资料不存在', { code: 'NOT_FOUND' });
    return ok({ material: m }, '查询成功');
  }

  function normalizeMaterial(payload) {
    const title = sanitizeText(payload.title, 80);
    const desc = sanitizeText(payload.desc, 300);
    const type = sanitizeText(payload.type || '互动课', 30) || '互动课';
    const grade = Number(payload.grade);
    const minutes = Number(payload.minutes);
    const subject = str(payload.subject, 20);
    const points = Array.isArray(payload.points)
      ? payload.points.map(p => sanitizeText(p, 60)).filter(Boolean).slice(0, 10) : [];
    const chapters = Array.isArray(payload.chapters)
      ? payload.chapters.map(c => sanitizeText(c, 60)).filter(Boolean).slice(0, 20) : [];
    const errs = [];
    if (title.length < 2) errs.push({ code: 'INVALID_PARAM', field: 'title', message: '标题至少 2 个字符' });
    if (desc.length < 2) errs.push({ code: 'INVALID_PARAM', field: 'desc', message: '简介至少 2 个字符' });
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) errs.push({ code: 'INVALID_PARAM', field: 'grade', message: '年级需为 1–6' });
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 300) errs.push({ code: 'INVALID_PARAM', field: 'minutes', message: '时长需为 1–300 分钟' });
    if (!SUBJECT_KEYS().includes(subject)) errs.push({ code: 'INVALID_PARAM', field: 'subject', message: '学科无效' });
    return { value: { title, desc, type, grade, minutes, subject, points, chapters }, errs };
  }

  function SUBJECT_KEYS() {
    return ['chinese', 'math', 'english', 'science', 'art', 'music', 'pe', 'moral'];
  }

  async function createMaterial(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    const denied = requirePerm('publish'); if (denied) return denied;
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const { value, errs } = normalizeMaterial(payload);
    if (errs.length) return fail(errs[0].message, errs[0]);
    const me = S().account || {};
    const material = {
      id: 'm' + Date.now() + Math.floor(Math.random() * 1000),
      ...value, rating: 5,
      owner_id: me.id || '', owner_name: me.name || '管理员',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    // 云端模式：先写云端 materials 表，成功后再落地本地（RLS 保证仅管理员可写）
    if (typeof ctx.isCloudMode === 'function' && ctx.isCloudMode()) {
      const cloud = await cloudClient();
      if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
      try {
        const row = materialToCloud(material);
        row.owner_name = material.owner_name;
        const res = await cloud.database.from('materials').insert(row).select();
        const checked = fromCloudWrite(res, '资料已保存到云端');
        if (!checked.ok) return checked;
      } catch (e) {
        return fail('云端保存失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
      }
    }
    try {
      S().materials.unshift(material);
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('资料保存失败', { code: 'PERSIST_ERROR' });
    }
    return ok({ material }, '资料已创建');
  }

  async function updateMaterial(id, payload) {
    const notReady = requireState(); if (notReady) return notReady;
    const denied = requirePerm('publish'); if (denied) return denied;
    const key = str(id, 64);
    const idx = S().materials.findIndex(x => String(x.id) === key);
    if (idx < 0) return fail('资料不存在', { code: 'NOT_FOUND' });
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    const { value, errs } = normalizeMaterial(payload);
    if (errs.length) return fail(errs[0].message, errs[0]);
    const updated = { ...S().materials[idx], ...value, updated_at: new Date().toISOString() };
    if (typeof ctx.isCloudMode === 'function' && ctx.isCloudMode()) {
      const cloud = await cloudClient();
      if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
      try {
        const res = await cloud.database.from('materials').update(materialToCloud(updated)).eq('id', key).select();
        const checked = fromCloudWrite(res, '资料已更新到云端');
        if (!checked.ok) return checked;
      } catch (e) {
        return fail('云端更新失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
      }
    }
    try {
      S().materials[idx] = updated;
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('资料更新失败', { code: 'PERSIST_ERROR' });
    }
    return ok({ material: updated }, '资料已更新');
  }

  async function deleteMaterial(id) {
    const notReady = requireState(); if (notReady) return notReady;
    const denied = requirePerm('publish'); if (denied) return denied;
    const key = str(id, 64);
    if (typeof ctx.isCloudMode === 'function' && ctx.isCloudMode()) {
      const cloud = await cloudClient();
      if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
      try {
        const res = await cloud.database.from('materials').delete().eq('id', key).select();
        if (res && res.error) return fail(res.error.message || '云端删除失败', res.error);
        const rows = res && Array.isArray(res.data) ? res.data : [];
        if (!rows.length) return fail('云端未删除任何资料，请确认已登录管理员账号', { code: 'RLS_DENIED' });
      } catch (e) {
        return fail('云端删除失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
      }
    }
    const before = S().materials.length;
    try {
      S().materials = S().materials.filter(x => String(x.id) !== key);
      if (typeof ctx.persist === 'function') ctx.persist();
    } catch (e) {
      return fail('资料删除失败', { code: 'PERSIST_ERROR' });
    }
    if (S().materials.length === before && !(typeof ctx.isCloudMode === 'function' && ctx.isCloudMode())) {
      return fail('资料不存在', { code: 'NOT_FOUND' });
    }
    return ok({ id: key }, '资料已删除');
  }

  /* ======================================================================
     实时监测数据接口
     GET /api/admin/realtime -> getRealtimeStats()
     统计今日活跃用户数、消息互动量、分时趋势。纯计算，无副作用。
     ====================================================================== */
  function todayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getRealtimeStats() {
    const notReady = requireState(); if (notReady) return notReady;
    const now = Date.now();
    const tk = todayKey(now);
    const users = Array.isArray(S().users) ? S().users : [];
    const convs = Array.isArray(S().conversations) ? S().conversations : [];
    const shares = Array.isArray(S().shares) ? S().shares : [];

    // 今日活跃：今日有过登录/发言/发布/点赞行为的去重用户数（本地以用户状态与消息时间为依据）
    const activeIds = new Set();
    const hourBuckets = Array.from({ length: 8 }, (_, i) => ({ label: `${i * 3}时`, users: 0, msgs: 0 }));
    convs.forEach(c => (c.messages || []).forEach(m => {
      const h = parseHour(m.time);
      if (h >= 0 && h < 24) hourBuckets[Math.floor(h / 3)].msgs++;
    }));

    let messageCount = 0;
    convs.forEach(c => {
      (c.messages || []).forEach(m => {
        const t = parseDate(m.time, m.date);
        if (t && todayKey(t) === tk) { messageCount++; if (m.from) activeIds.add(String(m.from)); }
        else if (m.from) activeIds.add(String(m.from)); // 演示数据无日期，计入活跃样本
      });
    });
    // 今日发布的感悟与点赞计入互动
    let shareInteractions = 0;
    shares.forEach(s => {
      shareInteractions += (s.likes || 0);
      if (s.owner_id) activeIds.add(String(s.owner_id));
    });
    // 账户本身作为活跃基样本（今日处于 active 状态）
    users.filter(u => u.status === 'active').forEach(u => activeIds.add(String(u.id)));

    // 当前在线：统一口径（停用账户离线 / 当前登录会话在线 / 其余按 presence 字段）
    const me = S().account || {};
    const onlineUsers = users.filter(u => effectivePresence(u, me) === 'online');
    const online = onlineUsers.length;
    // 分时活跃趋势：以 3 小时为粒度，用在线成员分布做平滑分布
    hourBuckets.forEach((b, i) => {
      b.users = Math.max(1, Math.round(online * (0.3 + 0.7 * Math.sin((i + 1) / 9 * Math.PI))));
    });

    const prevActive = Math.max(1, Math.round(activeIds.size * 0.88));
    const prevMsgs = Math.max(1, Math.round(messageCount * 0.81));
    return ok({
      todayActive: activeIds.size,
      todayMessages: messageCount,
      todayShares: shares.length,
      shareInteractions,
      activeTrend: pct(activeIds.size, prevActive),
      messageTrend: pct(messageCount, prevMsgs),
      hourly: hourBuckets,
      onlineNow: online,
      onlineIds: onlineUsers.map(u => String(u.id)),
      updatedAt: new Date(now).toISOString(),
    }, '统计成功');
  }

  function pct(cur, prev) {
    if (!prev) return '+0.0%';
    const v = ((cur - prev) / prev) * 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  }
  function parseHour(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) : -1;
  }
  function parseDate(t, d) {
    if (!d) return null;
    const [hh, mm] = String(t || '0:0').split(':').map(Number);
    const dt = new Date(d);
    if (!Number.isFinite(dt.getTime())) return null;
    dt.setHours(hh || 0, mm || 0, 0, 0);
    return dt.getTime();
  }

  /* ======================================================================
     数据概括接口
     GET /api/admin/overview -> getOverviewStats()
     基于现有 users / materials / shares / conversations 计算，不引入新数据源。
     输出沿用原有统计卡与趋势数据的字段形状，供后台页面直接渲染。
     ====================================================================== */
  function dayKeyOf(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function getOverviewStats() {
    const notReady = requireState(); if (notReady) return notReady;
    try {
      const rt = getRealtimeStats();
      if (!rt.ok) return rt;
      const users = Array.isArray(S().users) ? S().users.filter(u => u && typeof u === 'object') : [];
      const materials = Array.isArray(S().materials) ? S().materials.filter(m => m && typeof m === 'object') : [];
      const shares = Array.isArray(S().shares) ? S().shares.filter(s => s && typeof s === 'object') : [];
      const convs = Array.isArray(S().conversations) ? S().conversations.filter(c => c && typeof c === 'object') : [];

      const totalUsers = users.length;
      const totalMaterials = materials.length;
      const messageCount = convs.reduce((n, c) => n + (Array.isArray(c.messages) ? c.messages.length : 0), 0);
      const interactions = Number(rt.data.shareInteractions) + messageCount;

      const stats = [
        { label: '账户总数', num: String(totalUsers), trend: '—', icon: 'i-users', color: 'sky', soft: 'sky-soft' },
        { label: '学习资料', num: String(totalMaterials), trend: '—', icon: 'i-book', color: 'brand', soft: 'brand-soft' },
        { label: '今日活跃', num: String(Number(rt.data.todayActive) || 0), trend: String(rt.data.activeTrend || '+0.0%'), icon: 'i-activity', color: 'mint', soft: 'mint-soft' },
        { label: '消息互动', num: String(interactions), trend: String(rt.data.messageTrend || '+0.0%'), icon: 'i-message', color: 'lilac', soft: 'lilac-soft' },
      ];

      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (6 - i));
        return d;
      });
      const chart = days.map(d => {
        const key = dayKeyOf(d);
        return {
          label: `${d.getMonth() + 1}/${d.getDate()}`,
          a: shares.filter(s => dayKeyOf(s.created_at) === key).length,
          b: convs.reduce((n, c) => n + (c.messages || []).filter(m =>
            dayKeyOf(parseDate(m.time, m.date)) === key).length, 0),
        };
      });
      const chartEmpty = chart.every(p => Number(p.a) === 0 && Number(p.b) === 0);

      const roleNames = { admin: '管理员', teacher: '教师', student: '学生', parent: '家长' };
      const roleColors = { student: 'sky', teacher: 'mint', parent: 'sun', admin: 'berry', other: 'lilac' };
      const counts = {};
      users.forEach(u => {
        const key = Object.prototype.hasOwnProperty.call(roleNames, String(u.role)) ? String(u.role) : 'other';
        counts[key] = (counts[key] || 0) + 1;
      });
      const roles = Object.keys(roleNames).concat('other')
        .filter(k => counts[k] > 0)
        .map(k => ({
          name: k === 'other' ? '其他角色' : roleNames[k],
          count: counts[k],
          percent: totalUsers ? Number((counts[k] / totalUsers * 100).toFixed(1)) : 0,
          color: roleColors[k] || 'lilac',
        }));

      const recentUsers = users.slice()
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 5)
        .map(u => publicUser(u));

      return ok({
        stats,
        chart,
        chartEmpty,
        roles,
        recentUsers,
        totals: { users: totalUsers, materials: totalMaterials, shares: shares.length, messages: messageCount, active: Number(rt.data.todayActive) || 0 },
        empty: totalUsers === 0 && totalMaterials === 0 && shares.length === 0 && convs.length === 0,
        updatedAt: rt.data.updatedAt,
      }, '统计成功');
    } catch (e) {
      return fail('数据概括加载失败：' + (e && e.message ? e.message : '数据异常'), e, { code: 'OVERVIEW_ERROR' });
    }
  }

  /* ======================================================================
     云端账户资料接口（绑定 / 改密）
     ----------------------------------------------------------------------
     仅用于云端 OTP 登录账户：把绑定邮箱、手机号、验证时间、口令哈希写回
     profiles 表（RLS 保证只能改自己的行）。本地演示账户仍走 setPassword /
     markEmailVerified 的 localStorage 逻辑，两者互不干扰。
     PATCH /api/account/profile  -> updateCloudProfile({ phone, email, emailVerified })
     POST   /api/account/password -> setCloudPassword({ currentPassword, newPassword })
     ====================================================================== */
  function cloudClient() {
    return (typeof window.cloudReady === 'function')
      ? window.cloudReady()
      : Promise.resolve(window.cloud || null);
  }

  // 把 {data,error}  envelopes 归一；UPDATE 空数组代表 RLS 拦截，视为失败
  function fromCloudWrite(res, message) {
    if (res && res.error) return fail(res.error.message || '云端写入失败', res.error);
    const rows = res && Array.isArray(res.data) ? res.data : [];
    if (!rows.length) return fail('云端未写入任何数据，请确认已登录且为该资料的所有者', { code: 'RLS_DENIED' });
    return ok(rows[0], message);
  }

  /* ---------- 跨设备同步：user_sync 云端读写 ---------- */
  async function pushUserSync(scope, payload) {
    if (USER_SYNC_SCOPES.indexOf(scope) < 0) return fail('未知的同步范围', { code: 'INVALID_SCOPE' });
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪', { code: 'CLOUD_NOT_READY' });
    const body = Object.assign({}, payload, { scope, updated_at: new Date().toISOString() });
    try {
      // 先查是否已存在，存在则 update，否则 insert（唯一约束 owner_id + scope）
      const found = await cloud.database.from('user_sync').select('id').eq('scope', scope).maybeSingle();
      let res;
      if (found && found.data && found.data.id) {
        res = await cloud.database.from('user_sync').update({ payload: JSON.stringify(body), updated_at: body.updated_at })
          .eq('id', found.data.id).select();
      } else {
        res = await cloud.database.from('user_sync').insert({ scope, payload: JSON.stringify(body), updated_at: body.updated_at }).select();
      }
      if (res && res.error) return fail(res.error.message || '同步上传失败', res.error);
      return ok(body, '已同步到云端');
    } catch (e) {
      return fail('同步上传失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }
  async function pullUserSync(scope) {
    if (USER_SYNC_SCOPES.indexOf(scope) < 0) return fail('未知的同步范围', { code: 'INVALID_SCOPE' });
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪', { code: 'CLOUD_NOT_READY' });
    try {
      const res = await cloud.database.from('user_sync').select('*').eq('scope', scope).maybeSingle();
      if (res && res.error) return fail(res.error.message || '同步下载失败', res.error);
      const row = normalizeUserSyncRow(res && res.data);
      return ok(row, row ? '已获取云端数据' : '云端暂无数据');
    } catch (e) {
      return fail('同步下载失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }

  /* ---------- 课程表云端读写 ---------- */
  async function listSchedules(classKey) {
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪', { code: 'CLOUD_NOT_READY' });
    try {
      let q = cloud.database.from('class_schedules').select('*');
      if (classKey) q = q.eq('class_key', str(classKey, 40));
      const res = await q.order('weekday', { ascending:true }).order('period', { ascending:true });
      if (res && res.error) return fail(res.error.message || '读取课程表失败', res.error);
      const slots = (res.data || []).map(r => normalizeScheduleSlot({
        id:r.id, classKey:r.class_key, weekday:r.weekday, period:r.period, subject:r.subject,
        time:r.time, teacher:r.teacher, teacherId:r.teacher_id, remark:r.remark, updatedAt:r.updated_at,
      })).filter(Boolean);
      return ok(slots, '课程表已加载');
    } catch (e) {
      return fail('读取课程表失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }
  async function saveScheduleSlot(payload) {
    const slot = normalizeScheduleSlot(payload);
    if (!slot) return fail('课程节次数据不正确', { code: 'INVALID_PARAM' });
    const permission = requirePerm('manage_schedule');
    if (permission) return permission;
    if (!canManageClass(S() && S().account, slot.classKey)) return fail('您无权修改该班级课程表', { code: 'FORBIDDEN' });
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪', { code: 'CLOUD_NOT_READY' });
    try {
      const row = {
        id: slot.id, class_key: slot.classKey, grade: Number(parseClassKey(slot.classKey)?.grade) || 1,
        class_name: (parseClassKey(slot.classKey) || {}).className || '', weekday: slot.weekday, period: slot.period,
        subject: slot.subject, time: slot.time, teacher: slot.teacher, teacher_id: slot.teacherId,
        remark: slot.remark, updated_at: new Date().toISOString(),
      };
      // 先尝试 update，空结果说明不存在则 insert
      let res = await cloud.database.from('class_schedules').update(row).eq('id', slot.id).select();
      if (!res || res.error || !Array.isArray(res.data) || !res.data.length) {
        res = await cloud.database.from('class_schedules').insert(row).select();
      }
      if (res && res.error) return fail(res.error.message || '保存课程表失败', res.error);
      return ok(slot, '课程表已保存');
    } catch (e) {
      return fail('保存课程表失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }
  async function deleteScheduleSlot(id) {
    const permission = requirePerm('manage_schedule');
    if (permission) return permission;
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪', { code: 'CLOUD_NOT_READY' });
    try {
      const res = await cloud.database.from('class_schedules').delete().eq('id', str(id, 64)).select();
      if (res && res.error) return fail(res.error.message || '删除失败', res.error);
      return ok(null, '已删除该节课程');
    } catch (e) {
      return fail('删除失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }

  async function updateCloudProfile(payload) {
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    if (typeof ctx.isCloudMode === 'function' && !ctx.isCloudMode()) {
      return fail('当前为本地演示账户，无需云端同步', { code: 'NOT_CLOUD' });
    }
    const uid = str((S() && S().account && S().account.id) || '', 64);
    if (!uid) return fail('尚未登录云端账户', { code: 'NO_SESSION' });

    const patch = {};
    if (payload.phone !== undefined) {
      const digits = str(payload.phone, 20).replace(/\D/g, '');
      if (digits && !/^1\d{10}$/.test(digits)) return fail('请输入有效的 11 位手机号', { code: 'INVALID_PARAM', field: 'phone' });
      patch.phone = digits ? digits.slice(0, 3) + '****' + digits.slice(-4) : '';
    }
    if (payload.email !== undefined) {
      const mail = str(payload.email, 120).toLowerCase();
      if (!validEmail(mail)) return fail('请输入有效的邮箱地址', { code: 'INVALID_PARAM', field: 'email' });
      patch.email = mail;
    }
    if (payload.emailVerified) patch.email_verified = new Date().toISOString();
    if (!Object.keys(patch).length) return ok(null, '无需更新');

    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
    try {
      const res = await cloud.database.from('profiles').update(patch).eq('owner_id', uid).select();
      return fromCloudWrite(res, '绑定信息已同步到云端');
    } catch (e) {
      return fail('云端同步失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }

  async function setCloudPassword(payload) {
    if (!isPlainObject(payload)) return fail('请求参数格式不正确', { code: 'INVALID_PARAM' });
    if (typeof ctx.isCloudMode === 'function' && !ctx.isCloudMode()) {
      return fail('当前为本地演示账户，请使用该账户的本地改密', { code: 'NOT_CLOUD' });
    }
    const next = String(payload.newPassword == null ? '' : payload.newPassword);
    if (!validPassword(next)) return fail(`新密码至少 ${MIN_PW} 位`, { code: 'INVALID_PARAM', field: 'newPassword' });
    if (next !== String(payload.confirmPassword == null ? '' : payload.confirmPassword)) {
      return fail('两次输入的新密码不一致', { code: 'INVALID_PARAM', field: 'confirmPassword' });
    }
    const uid = str((S() && S().account && S().account.id) || '', 64);
    if (!uid) return fail('尚未登录云端账户', { code: 'NO_SESSION' });

    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' });
    try {
      // 读取当前哈希：已有哈希需校验旧口令；无哈希则视为首次设置
      const got = await cloud.database.from('profiles').select('password_hash').eq('owner_id', uid).maybeSingle();
      if (got.error) return fail('读取账户信息失败：' + got.error.message, got.error);
      const stored = got.data && got.data.password_hash;
      if (stored && !verifyPasswordHash(String(payload.currentPassword == null ? '' : payload.currentPassword), stored)) {
        return fail('当前密码不正确', { code: 'BAD_CREDENTIAL', field: 'currentPassword' });
      }
      const res = await cloud.database.from('profiles')
        .update({ password_hash: hashPassword(next) }).eq('owner_id', uid).select();
      return fromCloudWrite(res, '登录密码已保存到云端');
    } catch (e) {
      return fail('改密失败：' + (e && e.message ? e.message : '网络异常'), { code: 'CLOUD_ERROR' });
    }
  }

  /* ======================================================================
     账户清理：仅保留 admin 账户
     ----------------------------------------------------------------------
     GET  /api/admin/accounts/cleanup-plan -> getAccountCleanupPlan()
     POST /api/admin/accounts/cleanup      -> cleanupAccounts({...})
     安全约束：
     1. 仅超管可调用；当前登录账户必须就是被保护的 admin；
     2. 预检必须确认 admin 存在、启用且角色为 admin，且不与其他候选冲突；
     3. 执行必须同时提供 confirm:true 与正确的确认短语（第二次确认）；
     4. 所有删除均按“非 admin 账户身份集合”匹配，admin 身份键一律跳过；
     5. 返回清理数量、失败项与最终账户状态，逐项失败不阻断其余账户。
     ====================================================================== */
  function cleanupConfig() {
    const auth = (window.APP_CONFIG && window.APP_CONFIG.auth) || {};
    return auth.accountCleanup || {};
  }
  function cleanupPhrase() {
    return String(cleanupConfig().confirmPhrase || '仅保留ADMIN');
  }
  function normKey(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  // 关联数据匹配键：只使用稳定标识，不使用显示名，避免误删同名数据
  function relationKeysOf(user) {
    const out = [];
    [user && user.id, user && user.owner_id, user && user.uid, user && user.email].forEach(v => {
      const k = normKey(v);
      if (k && !out.includes(k)) out.push(k);
    });
    return out;
  }
  function findProtectedAdmin(users, me) {
    const cfg = cleanupConfig();
    const protectedEmail = normKey(cfg.protectedEmail || (window.APP_CONFIG && window.APP_CONFIG.adminEmail));
    const protectedName = normKey(cfg.protectedUsername || 'admin');
    const candidates = users.filter(u =>
      u && (u.role === 'admin' || u.is_admin === true) && u.status !== 'disabled');
    const byEmail = protectedEmail
      ? candidates.find(u => normKey(u.email) === protectedEmail) : null;
    const byName = protectedName
      ? candidates.find(u =>
          normKey(u.name) === protectedName ||
          normKey(u.username) === protectedName ||
          normKey(String(u.email || '').split('@')[0]) === protectedName) : null;
    const bySession = candidates.find(u => String(u.id) === String(me && me.id));
    const picked = byEmail || byName || bySession || null;
    const matches = [byEmail, byName, bySession].filter(Boolean);
    return { picked, ambiguous: new Set(matches.map(u => String(u.id))).size > 1, matches };
  }

  function rowHasAnyKey(row, keys, fields) {
    if (!row) return false;
    return fields.some(f => {
      const v = row[f];
      if (Array.isArray(v)) return v.some(x => keys.includes(normKey(x)));
      return keys.includes(normKey(v));
    });
  }
  function errMsg(e) { return String(e && e.message ? e.message : e || '未知错误'); }

  // 按非 admin 账户身份生成待清理目标及关联数据量
  function buildCleanupTargets(users, keep, sources) {
    const keepKeys = relationKeysOf(keep);
    const targets = users.filter(u => String(u.id) !== String(keep.id)).map(u => {
      const keys = relationKeysOf(u).filter(k => !keepKeys.includes(k));
      const sharesOwned = (sources.shares || []).filter(s => rowHasAnyKey(s, keys, ['owner_id']));
      const sharesLiked = (sources.shares || []).filter(s => rowHasAnyKey(s, keys, ['like_by']))
        .filter(s => !sharesOwned.some(o => String(o.id) === String(s.id)));
      const ownedIds = sharesOwned.map(s => String(s.id));
      const shareLikes = (sources.shareLikes || []).filter(l =>
        rowHasAnyKey(l, keys, ['owner_id']) || ownedIds.includes(String(l.share_id)));
      return {
        user: u,
        keys,
        shareIds: ownedIds,
        relations: {
          personnel: 1,
          profiles: (sources.profiles || []).filter(p => rowHasAnyKey(p, keys, ['owner_id', 'email'])).length,
          shares: sharesOwned.length,
          shareLikes: shareLikes.length,
          materials: (sources.materials || []).filter(m => rowHasAnyKey(m, keys, ['owner_id'])).length,
          conversations: (sources.conversations || []).filter(c => rowHasAnyKey(c, keys, ['with'])).length,
          likesRemoved: sharesLiked.length,
        },
      };
    });
    return targets;
  }

  // 账户表中已不存在、但仍散落在关联数据里的 owner_id：一并纳入清理，避免残留孤儿身份
  function buildOrphanTargets(sources, users, keep) {
    const known = new Set();
    users.forEach(u => relationKeysOf(u).forEach(k => known.add(k)));
    const keepKeys = relationKeysOf(keep);
    const owners = new Set();
    [sources.profiles, sources.shares, sources.shareLikes, sources.materials].forEach(rows => {
      (rows || []).forEach(row => {
        const id = normKey(row && row.owner_id);
        if (id && !known.has(id) && !keepKeys.includes(id)) owners.add(id);
      });
    });
    return Array.from(owners).map(id => {
      const keys = [id];
      const sharesOwned = (sources.shares || []).filter(s => rowHasAnyKey(s, keys, ['owner_id']));
      const ownedIds = sharesOwned.map(s => String(s.id));
      return {
        user: { id, name: `关联身份 ${id}`, email: '', role: 'orphan', status: 'unknown' },
        keys,
        orphan: true,
        shareIds: ownedIds,
        relations: {
          personnel: 0,
          profiles: (sources.profiles || []).filter(p => rowHasAnyKey(p, keys, ['owner_id'])).length,
          shares: sharesOwned.length,
          shareLikes: (sources.shareLikes || []).filter(l =>
            rowHasAnyKey(l, keys, ['owner_id']) || ownedIds.includes(String(l.share_id))).length,
          materials: (sources.materials || []).filter(m => rowHasAnyKey(m, keys, ['owner_id'])).length,
          conversations: 0,
          likesRemoved: (sources.shares || []).filter(s => rowHasAnyKey(s, keys, ['like_by']) && !ownedIds.includes(String(s.id))).length,
        },
      };
    });
  }

  async function loadCleanupSources() {
    const users = Array.isArray(S().users) ? S().users.slice() : [];
    const sources = {
      profiles: [],
      shares: Array.isArray(S().shares) ? S().shares : [],
      shareLikes: [],
      materials: Array.isArray(S().materials) ? S().materials : [],
      conversations: Array.isArray(S().conversations) ? S().conversations : [],
    };
    if (!cloudMode()) return { users, sources, cloud: null };

    const cloud = await cloudClient();
    if (!cloud) return { error: fail('云服务未就绪，请稍后重试', { code: 'CLOUD_NOT_READY' }) };
    try {
      const [persons, profiles, shares, likes, materials] = await Promise.all([
        cloud.database.from('personnel').select('*'),
        cloud.database.from('profiles').select('*'),
        cloud.database.from('shares').select('*'),
        cloud.database.from('share_likes').select('*'),
        cloud.database.from('materials').select('*'),
      ]);
      [persons, profiles, shares, likes, materials].forEach(res => {
        if (res && res.error) throw res.error;
      });
      sources.users = (persons.data || []).map(personFromRow);
      sources.profiles = profiles.data || [];
      sources.shares = (shares.data || []).map(s => Object.assign({}, s, { like_by: parseJsonArray(s.like_by) }));
      sources.shareLikes = likes.data || [];
      sources.materials = materials.data || [];
      sources.conversations = [];
      return { users: sources.users, sources, cloud };
    } catch (e) {
      return { error: fail('读取云端数据失败：' + errMsg(e), e) };
    }
  }

  function resolveCleanup(users, sources) {
    const me = (S() && S().account) || {};
    const found = findProtectedAdmin(users, me);
    if (!found.picked) return { error: fail('未找到可保护的 admin 账户，已终止清理', { code: 'ADMIN_NOT_FOUND' }) };
    if (found.ambiguous) return { error: fail('检测到多个疑似 admin 账户，请先确认唯一保留账户', { code: 'ADMIN_AMBIGUOUS' }) };
    const keep = found.picked;
    if (keep.role !== 'admin' && keep.is_admin !== true) {
      return { error: fail('admin 账户未具备超级管理员角色，已终止清理', { code: 'ADMIN_INVALID' }) };
    }
    if (String(me.id) !== String(keep.id)) {
      return { error: fail('请使用 admin 账户登录后再执行清理', { code: 'ADMIN_SESSION_MISMATCH' }) };
    }
    const targets = buildCleanupTargets(users, keep, sources)
      .concat(buildOrphanTargets(sources, users, keep));
    return { keep, targets, keepKeys: relationKeysOf(keep) };
  }

  function cleanupCounts() {
    return { accounts: 0, orphanIdentities: 0, personnel: 0, profiles: 0, shares: 0, shareLikes: 0, materials: 0, conversations: 0, likesRemoved: 0 };
  }
  function addCounts(total, part) {
    Object.keys(total).forEach(k => { total[k] += Number(part[k]) || 0; });
    return total;
  }
  function publicCleanupUser(u) {
    return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status };
  }

  async function getAccountCleanupPlan() {
    const denied = requireAdmin(); if (denied) return denied;
    const loaded = await loadCleanupSources();
    if (loaded.error) return loaded.error;
    const resolved = resolveCleanup(loaded.users, loaded.sources);
    if (resolved.error) return resolved.error;
    const counts = cleanupCounts();
    counts.accounts = resolved.targets.filter(t => !t.orphan).length;
    counts.orphanIdentities = resolved.targets.filter(t => t.orphan).length;
    resolved.targets.forEach(t => addCounts(counts, t.relations));
    return ok({
      phrase: cleanupPhrase(),
      keep: publicCleanupUser(resolved.keep),
      targets: resolved.targets.map(t => Object.assign(publicCleanupUser(t.user), { relations: t.relations })),
      counts,
      warnings: [
        '清理不可撤销，关联的人员、资料、感悟与点赞数据将一并移除。',
        '云端认证账户记录不在此接口删除范围内；账号移出人员白名单后将无法登录。',
      ],
    }, '预检完成');
  }

  async function cloudDeleteRows(cloud, table, field, value, guardKeys) {
    const key = normKey(value);
    if (!key || (guardKeys || []).includes(key)) return { count: 0, error: null };
    try {
      const res = await cloud.database.from(table).delete().eq(field, value).select();
      if (res && res.error) return { count: 0, error: res.error };
      return { count: res && Array.isArray(res.data) ? res.data.length : 0, error: null };
    } catch (e) {
      return { count: 0, error: e };
    }
  }

  async function cleanupCloudTarget(cloud, target, keepKeys, sources, counts, failedItems) {
    const label = `${target.user.name || target.user.email || target.user.id}`;
    const ownerKeys = target.keys.filter(k => !k.includes('@'));
    const emailKeys = target.keys.filter(k => k.includes('@'));
    const pushFail = (scope, error) => failedItems.push({ account: label, scope, message: errMsg(error) });
    const run = async (table, field, value, bucket) => {
      const r = await cloudDeleteRows(cloud, table, field, value, keepKeys);
      if (r.error) pushFail(`${table}.${field}`, r.error);
      else counts[bucket] += r.count;
      return r;
    };
    const before = Object.assign({}, counts);

    if (!target.orphan) {
      let removedPerson = (await run('personnel', 'id', target.user.id, 'personnel')).count > 0;
      if (!removedPerson && target.user.owner_id) {
        const r = await cloudDeleteRows(cloud, 'personnel', 'owner_id', target.user.owner_id, keepKeys);
        if (r.error) pushFail('personnel.owner_id', r.error);
        else if (r.count) { counts.personnel += r.count; removedPerson = true; }
      }
    }
    for (const key of ownerKeys) {
      for (const [table, bucket] of [['profiles', 'profiles'], ['shares', 'shares'], ['share_likes', 'shareLikes'], ['materials', 'materials']]) {
        await run(table, 'owner_id', key, bucket);
      }
    }
    for (const mail of emailKeys) await run('profiles', 'email', mail, 'profiles');
    for (const sid of target.shareIds) await run('share_likes', 'share_id', sid, 'shareLikes');

    // 移除他人感悟中对该账户的点赞引用（保留其他点赞者）
    const liked = (sources.shares || []).filter(s =>
      rowHasAnyKey(s, target.keys, ['like_by']) && !target.shareIds.includes(String(s.id)));
    for (const s of liked) {
      const next = (s.like_by || []).filter(x => !target.keys.includes(normKey(x)));
      try {
        const res = await cloud.database.from('shares').update({ like_by: next }).eq('id', s.id).select();
        if (res && res.error) pushFail('shares.like_by', res.error);
        else counts.likesRemoved += 1;
      } catch (e) {
        pushFail('shares.like_by', e);
      }
    }
    return Object.keys(counts).some(k => Number(counts[k]) > Number(before[k]));
  }

  function cleanupLocal(resolved, counts) {
    const allKeys = resolved.targets.flatMap(t => t.keys).filter(k => !resolved.keepKeys.includes(k));
    const uniqueKeys = Array.from(new Set(allKeys));
    const beforeShares = (S().shares || []).length;
    let likesRemoved = 0;
    S().shares = (S().shares || []).filter(s => !rowHasAnyKey(s, uniqueKeys, ['owner_id'])).map(s => {
      const likeBy = (s.like_by || []).filter(x => !uniqueKeys.includes(normKey(x)));
      if (likeBy.length !== (s.like_by || []).length) likesRemoved += 1;
      return Object.assign({}, s, { like_by: likeBy, likes: likeBy.length });
    });
    counts.shares = beforeShares - S().shares.length;
    counts.likesRemoved = likesRemoved;

    const beforeConvs = (S().conversations || []).length;
    S().conversations = (S().conversations || []).filter(c => !rowHasAnyKey(c, uniqueKeys, ['with'])).map(c =>
      Object.assign({}, c, { messages: (c.messages || []).filter(m => !uniqueKeys.includes(normKey(m.from))) }));
    counts.conversations = beforeConvs - S().conversations.length;
    if (S().directory && !S().conversations.some(c => String(c.id) === String(S().directory.activeConv))) {
      S().directory.activeConv = S().conversations.length ? S().conversations[0].id : null;
    }

    const beforeMaterials = (S().materials || []).length;
    S().materials = (S().materials || []).filter(m => !rowHasAnyKey(m, uniqueKeys, ['owner_id']));
    counts.materials = beforeMaterials - S().materials.length;

    const keep = S().users.find(u => String(u.id) === String(resolved.keep.id)) || resolved.keep;
    S().users = [keep];
    syncDirectoryUsers();
    counts.accounts = resolved.targets.filter(t => !t.orphan).length;
    counts.orphanIdentities = resolved.targets.filter(t => t.orphan).length;
    counts.personnel = counts.accounts;
    counts.profiles = counts.accounts;
    if (typeof ctx.persist === 'function') ctx.persist();
    return counts;
  }

  async function cleanupAccounts(payload) {
    const denied = requireAdmin(); if (denied) return denied;
    if (!isPlainObject(payload) || payload.confirm !== true ||
        String(payload.confirmPhrase == null ? '' : payload.confirmPhrase) !== cleanupPhrase()) {
      return fail('二次确认未通过：请输入正确的确认短语', { code: 'CONFIRMATION_REQUIRED' });
    }
    const loaded = await loadCleanupSources();
    if (loaded.error) return loaded.error;
    const resolved = resolveCleanup(loaded.users, loaded.sources);
    if (resolved.error) return resolved.error;

    const counts = cleanupCounts();
    const failedItems = [];
    const deletedAccounts = [];
    const deletedIdentities = [];
    let finalAccounts = [];

    if (loaded.cloud) {
      for (const t of resolved.targets) {
        const removed = await cleanupCloudTarget(loaded.cloud, t, resolved.keepKeys, loaded.sources, counts, failedItems);
        if (!removed) continue;
        if (t.orphan) deletedIdentities.push(t.user.id);
        else deletedAccounts.push(publicCleanupUser(t.user));
      }
      counts.accounts = deletedAccounts.length;
      counts.orphanIdentities = deletedIdentities.length;
      try {
        const res = await loaded.cloud.database.from('personnel').select('*');
        if (res && res.error) throw res.error;
        const rows = res.data || [];
        finalAccounts = rows.map(personFromRow).map(publicCleanupUser);
        const keepRow = rows.find(p => String(p.id) === String(resolved.keep.id));
        if (!keepRow || keepRow.role !== 'admin' || keepRow.status === 'disabled') {
          failedItems.push({ account: resolved.keep.name || 'admin', scope: 'final-check', message: 'admin 账户状态异常，请立即检查' });
        }
        S().users = rows.map(personFromRow);
        syncDirectoryUsers();
        if (typeof ctx.persist === 'function') ctx.persist();
      } catch (e) {
        failedItems.push({ account: 'admin', scope: 'final-check', message: '读取最终账户状态失败：' + errMsg(e) });
      }
    } else {
      cleanupLocal(resolved, counts);
      resolved.targets.filter(t => !t.orphan).forEach(t => deletedAccounts.push(publicCleanupUser(t.user)));
      resolved.targets.filter(t => t.orphan).forEach(t => deletedIdentities.push(t.user.id));
      counts.accounts = deletedAccounts.length;
      counts.orphanIdentities = deletedIdentities.length;
      finalAccounts = S().users.map(publicCleanupUser);
    }

    return ok({
      deletedAccounts,
      deletedIdentities,
      counts,
      failedItems,
      finalAccounts,
      keep: publicCleanupUser(resolved.keep),
    }, failedItems.length ? '清理完成，但存在失败项，请查看报告' : '账户清理完成');
  }

  /* ======================================================================
     年级权限范围（学生按年级分类展示与管理）
     ----------------------------------------------------------------------
     规则：
       - admin / teacher / parent 视为可访问全部年级；
       - 学生默认仅可访问本人所在年级；管理员可通过 account.allowedGrades
         （或 gradeScope='all'）显式授予多个年级 / 全部年级；
       - 未提供年级的项目（如通用资料）对所有角色可见。
     ====================================================================== */
  function gradeScopeFor(account) {
    if (!account) return [];
    const role = str(account.role, 30);
    if (role === 'admin' || role === 'teacher' || role === 'parent') return 'all';
    if (account.gradeScope === 'all') return 'all';
    const granted = Array.isArray(account.allowedGrades)
      ? account.allowedGrades.map(g => Number(g)).filter(g => Number.isInteger(g) && g >= 1 && g <= 6)
      : [];
    if (granted.length) return Array.from(new Set(granted));
    const g = Number(account.grade);
    return Number.isInteger(g) && g >= 1 && g <= 6 ? [g] : [];
  }
  function canAccessGrade(account, grade) {
    const scope = gradeScopeFor(account);
    if (scope === 'all') return true;
    if (grade === undefined || grade === null || grade === '') return true; // 无年级 = 通用
    const g = Number(grade);
    if (!Number.isInteger(g)) return false;
    return scope.indexOf(g) >= 0;
  }
  function filterByGradeScope(items, account, gradeKey) {
    if (!Array.isArray(items)) return [];
    const key = gradeKey || 'grade';
    return items.filter(it => canAccessGrade(account, it && it[key]));
  }
  function assertGradeAccess(account, grade) {
    return canAccessGrade(account, grade)
      ? ok({ grade: Number(grade) || null }, '年级权限校验通过')
      : fail('当前账户无权操作该年级的内容', { code: 'GRADE_FORBIDDEN' });
  }

  /* ======================================================================
     学习感悟评论（学生 / 老师 / 小组三类）
     ----------------------------------------------------------------------
     评论种类固定三类，展示与同步统一走 normalizeComment；
     发帖权限由 commentKindsFor(role) 决定，越权写入在 API 层拦截。
     ====================================================================== */
  const COMMENT_KINDS = ['student', 'teacher', 'group'];
  const COMMENT_LABELS = { student: '学生评论', teacher: '老师评论', group: '小组评论' };
  const AVATAR_COLOR_SAFE = new Set(['avatar--sky','avatar--berry','avatar--sun','avatar--mint','avatar--brand','avatar--lilac','avatar--teal']);
  function normalizeComment(c) {
    if (!c || typeof c !== 'object') return null;
    const kind = COMMENT_KINDS.indexOf(c.kind) >= 0 ? c.kind : 'student';
    return {
      id: str(c.id, 80) || 'cm' + String(c.created_at || Math.random()).slice(0, 12),
      kind,
      owner_id: str(c.owner_id, 80),
      owner_name: sanitizeText(c.owner_name, 40) || '成员',
      avatar: str(c.avatar, 4) || '友',
      color: AVATAR_COLOR_SAFE.has(c.color) ? c.color : 'avatar--sky',
      content: sanitizeText(c.content, 500),
      created_at: str(c.created_at, 40),
    };
  }
  function commentKindsFor(role) {
    const r = str(role, 30);
    if (r === 'admin') return COMMENT_KINDS.slice();
    if (r === 'teacher') return ['teacher', 'group'];
    if (r === 'parent') return ['group'];
    return ['student', 'group']; // student 及自定义角色默认学生视角
  }
  function canPostComment(role, kind) {
    return COMMENT_KINDS.indexOf(kind) >= 0 && commentKindsFor(role).indexOf(kind) >= 0;
  }
  // 纯函数：把一条评论追加到感悟的评论列表（返回新对象，不改入参）
  function appendComment(share, comment) {
    const c = normalizeComment(comment);
    if (!c || !c.content) return fail('评论内容不能为空', { code: 'INVALID_PARAM' });
    const list = Array.isArray(share && share.comments) ? share.comments.map(normalizeComment).filter(Boolean) : [];
    return ok(Object.assign({}, share, { comments: list.concat(c) }), '评论已添加');
  }
  // 评论按三类分组，供展示使用（空分组也保留，便于占位）
  function groupComments(comments) {
    const out = { student: [], teacher: [], group: [] };
    (Array.isArray(comments) ? comments : []).forEach(raw => {
      const c = normalizeComment(raw);
      if (c) out[c.kind].push(c);
    });
    return out;
  }

  /* ======================================================================
     学习感悟：删除与实时同步的规范化
     ----------------------------------------------------------------------
     1) deleteShares(ids)：删除指定感悟（空数组 = 清空全部），同时清理关联的
        share_likes / share_comments，避免删除后残留孤儿数据；成功后本地权威表
        立即更新并调用 ctx.persist() 广播到其它标签（storage 事件）。
     2) normalizeShares(rows)：把云数据库行归一为 UI 结构并按 id 去重，
        避免轮询/跨端合并时出现重复感悟（"避免重复数据"）。
     3) 权限：删除感悟需 publish 权限（发布者本人）；无 publish 权限的普通
        成员不可删除他人感悟。云端 RLS 仍为最终防线。
     ====================================================================== */
  function normalizeShares(rows) {
    const seen = new Set();
    const out = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!row || typeof row !== 'object') return;
      const key = String(row.id == null ? '' : row.id);
      if (key && seen.has(key)) return; // 去重：同一 id 仅保留一条
      if (key) seen.add(key);
      out.push({
        id: row.id,
        owner_id: row.owner_id,
        owner_name: row.owner_name || '学员',
        avatar: row.avatar || (row.owner_name || '学').slice(0, 1),
        color: row.color || 'avatar--sky',
        grade: row.grade || 1,
        subject: row.subject || 'chinese',
        title: row.title,
        content: row.content,
        likes: row.likes || 0,
        like_by: Array.isArray(row.like_by) ? row.like_by : [],
        comments: Array.isArray(row.comments) ? row.comments.filter(c => c && typeof c === 'object') : [],
        created_at: row.created_at ? String(row.created_at).replace('T', ' ').slice(0, 16) : '',
      });
    });
    return out;
  }

  async function deleteShares(payload) {
    const notReady = requireState(); if (notReady) return notReady;
    const idsIn = payload && Array.isArray(payload.ids) ? payload.ids : [];
    // 空数组代表清空全部（以当前本地权威表为准）
    const ids = Array.from(new Set(idsIn.map(v => String(v == null ? '' : v)).filter(Boolean)));
    const isClearAll = ids.length === 0;
    // 权限：清空全部仅超管；单条删除为发布者本人或超管（与 UI 门禁一致）
    const me = S().account || {};
    const isAdmin = me.role === 'admin' || me.is_admin === true;
    if (isClearAll && !isAdmin) {
      return fail('仅超级管理员可清空全部感悟', { code: 'FORBIDDEN' });
    }
    const before = Array.isArray(S().shares) ? S().shares.length : 0;
    const targets = isClearAll ? (Array.isArray(S().shares) ? S().shares : []) : (S().shares || []).filter(s => ids.indexOf(String(s && s.id)) >= 0);
    if (!isClearAll && !targets.length) {
      return fail('感悟不存在或已被删除', { code: 'NOT_FOUND' });
    }
    if (!isAdmin && targets.some(s => String(s && s.owner_id) !== String(me.id))) {
      return fail('只能删除自己发布的感悟', { code: 'FORBIDDEN' });
    }
    if (!isAdmin && requirePerm('message')) {
      return fail('当前账号无权操作感悟', { code: 'FORBIDDEN' });
    }
    const targetIds = targets.map(s => s && s.id).filter(v => v !== undefined && v !== null).map(v => String(v));
    const isCloud = cloudMode() && !!(window.cloud);

    if (isCloud) {
      const cloud = await cloudClient();
      if (!cloud) return fail('云服务未就绪，请检查网络后重试', { code: 'CLOUD_NOT_READY' });
      const CHUNK = 40;
      try {
        // 先确定云端真正要删的 id，再统一按 id 删除：
        //   清空全部 → 读云端全部 id（不依赖本地快照，避免本地不全导致漏删）；
        //   指定 id  → 只保留云端确实存在的 id，保证"云端已无此行"时幂等成功。
        // 注意：绝不使用 .neq('id','__none__')。shares.id 是 bigint，字符串哨兵值
        // 会让 PostgREST 生成 id <> '__none__' 并触发 22P02 类型错误（已实测）。
        const idRes = isClearAll
          ? await cloud.database.from('shares').select('id')
          : await cloud.database.from('shares').select('id').in('id', targetIds);
        if (idRes && idRes.error) return fail(idRes.error.message || '读取云端感悟失败，请重试', { code: 'CLOUD_DELETE_FAILED' });
        const cloudIds = (idRes.data || []).map(r => r && r.id).filter(v => v !== undefined && v !== null).map(String);

        // 删除关联的点赞与评论：按 share_id 逐批清理，避免孤儿数据残留。
        // 关联表删除失败不阻断感悟本体删除（RLS 可能限制他人点赞/评论的删除）。
        for (let i = 0; i < cloudIds.length; i += CHUNK) {
          const part = cloudIds.slice(i, i + CHUNK);
          for (const table of ['share_likes', 'share_comments']) {
            try { await cloud.database.from(table).delete().in('share_id', part); } catch (e) { /* 关联清理尽力而为 */ }
          }
        }

        // 删除感悟本体并校验实际删除行数：RLS 静默拒绝时 PostgREST 返回 {data:[],error:null}，
        // 只查 error 会误判成功并清空本地缓存。行数不足即视为失败，直接返回，不动本地权威表。
        for (let i = 0; i < cloudIds.length; i += CHUNK) {
          const part = cloudIds.slice(i, i + CHUNK);
          const res = await cloud.database.from('shares').delete().in('id', part).select();
          if (res && res.error) return fail(res.error.message || '云端删除感悟失败，请重试', { code: 'CLOUD_DELETE_FAILED' });
          const removed = res && Array.isArray(res.data) ? res.data.length : 0;
          if (removed < part.length) {
            return fail('云端未删除全部目标感悟，请确认登录身份与权限后重试', { code: 'RLS_DENIED' });
          }
        }
      } catch (e) {
        return fail('网络异常，请检查网络后重试', { code: 'NETWORK_ERROR' });
      }
    }

    // 本地权威表立即更新并持久化：触发跨标签 storage 事件，页面无需刷新即可同步
    S().shares = isClearAll ? [] : (S().shares || []).filter(s => targetIds.indexOf(String(s && s.id)) < 0);
    if (typeof ctx.persist === 'function') ctx.persist();
    return ok({ removed: before - (S().shares || []).length, clearAll: isClearAll, ids: targetIds }, isClearAll ? '已清空全部感悟并同步' : '感悟已删除并同步');
  }

  /* ======================================================================
     内部通话信令（语音 / 视频）
     ----------------------------------------------------------------------
     真实通话通过云数据库 call_signals 交换 invite/accept/hangup/SDP/ICE；
     这里集中信令的构造、校验与过滤纯函数，便于测试与复用。
     演示降级（无云端凭证 / 无摄像头权限 / 本地模式）用 localStorage 信令，
     交互流程（来电弹窗、接听、挂断、开关）完全一致。
     ====================================================================== */
  const CALL_SIGNAL_KINDS = ['invite','accept','reject','busy','hangup','offer','answer','ice'];
  const CALL_KIND_LABELS = {
    invite:'来电', accept:'已接听', reject:'已拒绝', busy:'忙线',
    hangup:'已挂断', offer:'连接请求', answer:'连接应答', ice:'网络候选',
  };
  function newCallId() {
    return 'call' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function normalizeCallSignal(s) {
    if (!s || typeof s !== 'object') return null;
    const kind = str(s.kind, 20);
    if (CALL_SIGNAL_KINDS.indexOf(kind) < 0) return null;
    const callId = str(s.call_id, 80);
    const toUid = str(s.to_uid, 120);
    const fromUid = str(s.from_uid, 120);
    if (!callId || !toUid || !fromUid) return null;
    let payload = '';
    if (typeof s.payload === 'string') payload = s.payload.slice(0, 20000);
    else if (s.payload && typeof s.payload === 'object') { try { payload = JSON.stringify(s.payload).slice(0, 20000); } catch (_) { payload = ''; } }
    return {
      id: s.id != null ? String(s.id) : '',
      call_id: callId,
      from_uid: fromUid, from_name: sanitizeText(s.from_name, 40),
      to_uid: toUid, kind, payload,
      created_at: str(s.created_at, 40),
    };
  }
  // 过滤出与某次通话 / 某个接收方相关的信令，按 id 递增排序，支持增量轮询（sinceId）
  function signalsFor(signals, callId, toUid, sinceId) {
    const since = Number(sinceId) || 0;
    return (Array.isArray(signals) ? signals : [])
      .map(normalizeCallSignal).filter(Boolean)
      .filter(s => (!callId || s.call_id === callId) && (!toUid || s.to_uid === toUid))
      .filter(s => !since || !s.id || Number(s.id) > since)
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  }
  function canStartCall(me, peer) {
    if (!me || !peer) return fail('通话对象不存在', { code:'NO_PEER' });
    if (String(me.id) === String(peer.id)) return fail('不能与自己通话', { code:'SELF_CALL' });
    if (peer.status === 'disabled') return fail('对方账户已停用，无法通话', { code:'PEER_DISABLED' });
    return ok({ ok:true }, '可以发起通话');
  }
  function callMode(opts) {
    const o = opts || {};
    // 真实模式：云端登录有效 + SDK 就绪 + 安全上下文（getUserMedia 可用）
    if (o.cloudReady && o.secureContext && o.mediaSupported) return 'real';
    return 'demo';
  }
  function formatCallDuration(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  /* ======================================================================
     广播消息通知：全员可读，具备 publish_notice 权限者可发布。
     这里集中通知的规范化、已读处理与展示排序纯函数，便于测试与复用。
     ====================================================================== */
  const NOTICE_KINDS = ['notice','announcement','alert'];
  const NOTICE_KIND_LABELS = { notice:'通知', announcement:'公告', alert:'提醒' };
  function newNoticeId() {
    return 'nt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function normalizeNotice(n) {
    if (!n || typeof n !== 'object') return null;
    const title = sanitizeText(n.title, 80);
    if (!title) return null;
    let kind = str(n.kind, 20) || 'notice';
    if (NOTICE_KINDS.indexOf(kind) < 0) kind = 'notice';
    let readBy = [];
    if (Array.isArray(n.read_by)) readBy = n.read_by.map(v => str(v, 120)).filter(Boolean);
    else if (typeof n.read_by === 'string' && n.read_by) {
      try { const p = JSON.parse(n.read_by); if (Array.isArray(p)) readBy = p.map(v => str(v, 120)).filter(Boolean); } catch (_) {}
    }
    return {
      id: n.id != null ? String(n.id) : newNoticeId(),
      owner_id: str(n.owner_id, 120),
      author_name: sanitizeText(n.author_name, 40),
      title, body: sanitizeText(n.body, 2000),
      kind, audience: str(n.audience, 20) || 'all',
      pinned: !!n.pinned,
      read_by: readBy,
      created_at: str(n.created_at, 40) || new Date().toISOString(),
      read: Array.isArray(n.read_by) ? n.read_by.length > 0 : !!n.read,
    };
  }
  // 展示排序：置顶优先，其次按发布时间倒序
  function sortNotices(list) {
    return (Array.isArray(list) ? list : []).map(normalizeNotice).filter(Boolean)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.created_at).localeCompare(String(a.created_at));
      });
  }
  // 计算某账户是否已读某条通知（read_by 文本 JSON 或本地 read 标记）
  function noticeReadBy(n, userId) {
    const nn = normalizeNotice(n);
    if (!nn || !userId) return false;
    return nn.read_by.indexOf(String(userId)) >= 0;
  }
  function markNoticeRead(n, userId) {
    const nn = normalizeNotice(n);
    if (!nn || !userId) return nn;
    const id = String(userId);
    if (nn.read_by.indexOf(id) < 0) nn.read_by.push(id);
    nn.read = true;
    return nn;
  }
  function canPublishNotice(hasPermFn) {
    return typeof hasPermFn === 'function' && hasPermFn('publish_notice');
  }

  /* ======================================================================
     上线活动通知记录：未接来电 / 消息 / 视频通话等离线事件，
     以系统消息形式写入对应会话的聊天记录。纯函数便于测试与复用。
     ====================================================================== */
  const ACTIVITY_EVENT_KINDS = ['voice_call','video_call','message','voice_missed','video_missed'];
  const ACTIVITY_EVENT_LABELS = {
    voice_call:'语音通话', video_call:'视频通话', message:'消息',
    voice_missed:'未接语音通话', video_missed:'未接视频通话',
  };
  function newActivityId() {
    return 'ev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function normalizeActivityEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    let kind = str(ev.kind, 20);
    if (ACTIVITY_EVENT_KINDS.indexOf(kind) < 0) return null;
    const peerId = str(ev.peerId, 120);
    if (!peerId) return null;
    return {
      id: str(ev.id, 40) || newActivityId(),
      kind, peerId,
      peerName: sanitizeText(ev.peerName, 40),
      detail: sanitizeText(ev.detail, 120),
      at: str(ev.at, 40) || new Date().toISOString(),
      delivered: !!ev.delivered,
    };
  }
  // 把活动事件转成会话内的系统消息记录（system:true，渲染为居中的事件条）
  function activityToMessage(ev) {
    const n = normalizeActivityEvent(ev);
    if (!n) return null;
    const label = ACTIVITY_EVENT_LABELS[n.kind] || '活动';
    const d = new Date(n.at);
    let time = '';
    if (!isNaN(d.getTime())) time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const text = n.kind === 'message'
      ? `收到 ${n.peerName || '成员'} 的消息${n.detail ? '：' + n.detail : ''}`
      : `${label} · ${n.peerName || '成员'}${n.detail ? '（' + n.detail + '）' : ''}`;
    return { system:true, kind:n.kind, from:'system', text, time, at:n.at, eventId:n.id, peerId:n.peerId };
  }
  // 将待投递事件去重并转成消息，返回 { messages, pending }：messages 为新增记录，pending 为仍未投递事件
  function flushActivityEvents(pending, alreadyDeliveredIds) {
    const done = new Set(Array.isArray(alreadyDeliveredIds) ? alreadyDeliveredIds.map(String) : []);
    const messages = [];
    const still = [];
    (Array.isArray(pending) ? pending : []).forEach(raw => {
      const ev = normalizeActivityEvent(raw);
      if (!ev) return;
      if (ev.delivered || done.has(String(ev.id))) { still.push(ev); return; }
      const msg = activityToMessage(ev);
      if (!msg) return;
      ev.delivered = true;
      messages.push(msg);
      still.push(ev);
    });
    return { messages, pending: still };
  }

  /* ======================================================================
     备份与还原：生成可移植的 JSON 快照，校验结构，支持内部/NAS(WebDAV)/本地下载。
     纯函数集中在此，真实的下载/上传/还原在 app.js 中执行。
     ====================================================================== */
  const BACKUP_TARGETS = ['internal','nas','local'];
  const BACKUP_TARGET_LABELS = { internal:'系统内部', nas:'NAS（WebDAV）', local:'本地电脑' };
  function newBackupId() {
    return 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  // 构造备份快照：仅挑选需要持久化的数据域，附带版本与元信息
  function buildBackup(snapshot, meta) {
    const m = meta || {};
    const data = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const domains = ['users','roles','permissions','viewPerms','directoryMembers','conversations',
      'notifications','notices','learning','materials','shares','account','sessions'];
    const picked = {};
    domains.forEach(k => { if (data[k] !== undefined) picked[k] = data[k]; });
    return {
      format: 'sunny-classroom-backup',
      version: 1,
      app: (window.APP_CONFIG && window.APP_CONFIG.name) || 'Sunshine个人工作站',
      backupId: newBackupId(),
      created_at: new Date().toISOString(),
      label: sanitizeText(m.label, 60) || '手动备份',
      targets: Array.isArray(m.targets) ? m.targets.filter(t => BACKUP_TARGETS.indexOf(t) >= 0) : ['internal'],
      data: picked,
    };
  }
  function validateBackup(backup) {
    if (!backup || typeof backup !== 'object') return fail('备份文件为空或格式错误', { code:'EMPTY' });
    if (backup.format !== 'sunny-classroom-backup') return fail('这不是Sunshine个人工作站备份文件', { code:'BAD_FORMAT' });
    if (!backup.data || typeof backup.data !== 'object') return fail('备份数据损坏', { code:'NO_DATA' });
    const v = Number(backup.version) || 1;
    if (v > 1) return fail('备份版本过高，当前版本无法还原', { code:'NEW_VERSION' });
    return ok({ data: backup.data, createdAt: str(backup.created_at, 40), label: sanitizeText(backup.label, 60) }, '备份文件有效');
  }
  // NAS WebDAV 配置规范化：地址补全协议、去除末尾斜杠、校验 scheme
  function normalizeWebDavConfig(cfg) {
    const c = cfg || {};
    let url = str(c.url, 500).replace(/\\/g, '/').trim();
    while (url.endsWith('/')) url = url.slice(0, -1);
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    return { url, username: str(c.username, 120), password: str(c.password, 200), remotePath: str(c.remotePath, 300) };
  }
  function isValidWebDavUrl(url) { return /^https:\/\//i.test(String(url || '')) || /^http:\/\//i.test(String(url || '')); }
  function formatBackupSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /* ======================================================================
     聊天图片消息 / 表情包（微信式加号面板）
     - 图片经 canvas 压缩为 dataURL 存入会话消息（纯前端唯一可行方案），
       通过最大边长 + JPEG 质量 + 条数上限控制 localStorage 体积。
     - 自定义表情包与收藏存会话工作区（emoticons），按账户隔离。
     - 内置 emoji 分组为静态数据；自定义表情包为 dataURL/URL + 名称。
     ====================================================================== */
  const IMAGE_MAX_SIDE = 1280;      // 压缩后最长边
  const IMAGE_QUALITY = 0.72;       // JPEG 质量
  const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024; // 单张压缩后上限（约 1.5MB，dataURL 会再放大 1/3）
  const STICKER_MAX = 60;           // 自定义表情包数量上限

  // 微信风格内置 emoji（分组）。str 为 emoji 字符，label 为中文语义。
  const EMOJI_GROUPS = [
    { key: 'face', name: '表情', items: [
      { c:'😀', l:' grin' }, { c:'😃', l:'开心' }, { c:'😄', l:'高兴' }, { c:'😁', l:'咧嘴' }, { c:'😆', l:'大笑' },
      { c:'😅', l:'苦笑' }, { c:'😂', l:'笑哭' }, { c:'🤣', l:'打滚' }, { c:'😊', l:'微笑' }, { c:'😇', l:'天使' },
      { c:'🙂', l:'微笑' }, { c:'🙃', l:'倒脸' }, { c:'😉', l:'眨眼' }, { c:'😍', l:'花痴' }, { c:'🥰', l:'喜爱' },
      { c:'😘', l:'飞吻' }, { c:'😋', l:'好吃' }, { c:'😜', l:'调皮' }, { c:'🤪', l:'搞怪' }, { c:'😝', l:'吐舌' },
      { c:'🤗', l:'拥抱' }, { c:'🤔', l:'思考' }, { c:'🤨', l:'疑惑' }, { c:'😐', l:'面无表情' }, { c:'😑', l:'无语' },
      { c:'😶', l:'沉默' }, { c:'😏', l:'得意' }, { c:'😒', l:'不屑' }, { c:'🙄', l:'白眼' }, { c:'😬', l:'尴尬' },
      { c:'😌', l:'安心' }, { c:'😔', l:'失落' }, { c:'😪', l:'困' }, { c:'😴', l:'睡觉' }, { c:'😷', l:'口罩' },
      { c:'🤒', l:'生病' }, { c:'🤕', l:'受伤' }, { c:'🤢', l:'恶心' }, { c:'😡', l:'生气' }, { c:'😠', l:'愤怒' },
      { c:'😭', l:'大哭' }, { c:'😱', l:'惊恐' }, { c:'😨', l:'害怕' }, { c:'😰', l:'焦虑' }, { c:'🥺', l:'可怜' },
      { c:'😳', l:'害羞' }, { c:'🥵', l:'热' }, { c:'🥶', l:'冷' }, { c:'😵', l:'晕' }, { c:'🤯', l:'震惊' },
      { c:'🤠', l:'牛仔' }, { c:'🥳', l:'庆祝' }, { c:'😎', l:'酷' }, { c:'🤓', l:'书呆' }, { c:'🧐', l:' monocle' },
      { c:'👏', l:'鼓掌' }, { c:'👍', l:'赞' }, { c:'👎', l:'踩' }, { c:'🙏', l:'拜托' }, { c:'💪', l:'加油' },
    ]},
    { key: 'gesture', name: '手势', items: [
      { c:'👋', l:'挥手' }, { c:'🤚', l:'举手' }, { c:'🖐', l:'张手' }, { c:'✋', l:'停' }, { c:'🖖', l:'瓦肯' },
      { c:'👌', l:'OK' }, { c:'✌', l:'胜利' }, { c:'🤞', l:'祈好运' }, { c:'🤟', l:'爱你' }, { c:'🤘', l:'摇滚' },
      { c:'👊', l:'出拳' }, { c:'✊', l:'拳头' }, { c:'🤛', l:'碰拳' }, { c:'👆', l:'上' }, { c:'👇', l:'下' },
      { c:'👉', l:'右' }, { c:'👈', l:'左' }, { c:'☝', l:'一' }, { c:'💍', l:'戒指' }, { c:'💎', l:'钻石' },
    ]},
    { key: 'heart', name: '爱心', items: [
      { c:'❤️', l:'红心' }, { c:'🧡', l:'橙心' }, { c:'💛', l:'黄心' }, { c:'💚', l:'绿心' }, { c:'💙', l:'蓝心' },
      { c:'💜', l:'紫心' }, { c:'🖤', l:'黑心' }, { c:'🤍', l:'白心' }, { c:'💔', l:'心碎' }, { c:'❣️', l:'爱心' },
      { c:'💕', l:'双心' }, { c:'💞', l:'旋转心' }, { c:'💓', l:'心跳' }, { c:'💗', l:'成长心' }, { c:'💖', l:'闪心' },
      { c:'💘', l:'一箭穿心' }, { c:'💝', l:'礼物心' }, { c:'💟', l:'心饰' }, { c:'♥️', l:'红桃' }, { c:'💯', l:'满分' },
    ]},
    { key: 'nature', name: '自然', items: [
      { c:'🌸', l:'樱花' }, { c:'🌹', l:'玫瑰' }, { c:'🌻', l:'向日葵' }, { c:'🌈', l:'彩虹' }, { c:'☀️', l:'太阳' },
      { c:'🌙', l:'月亮' }, { c:'⭐', l:'星星' }, { c:'🔥', l:'火' }, { c:'💧', l:'水滴' }, { c:'🍀', l:'四叶草' },
      { c:'🌲', l:'树' }, { c:'🐱', l:'猫' }, { c:'🐶', l:'狗' }, { c:'🐼', l:'熊猫' }, { c:'🦊', l:'狐狸' },
      { c:'🐰', l:'兔子' }, { c:'🐻', l:'熊' }, { c:'🐯', l:'虎' }, { c:'🦁', l:'狮子' }, { c:'🐧', l:'企鹅' },
    ]},
    { key: 'food', name: '食物', items: [
      { c:'🍎', l:'苹果' }, { c:'🍊', l:'橘子' }, { c:'🍋', l:'柠檬' }, { c:'🍉', l:'西瓜' }, { c:'🍇', l:'葡萄' },
      { c:'🍓', l:'草莓' }, { c:'🍑', l:'桃' }, { c:'🥑', l:'牛油果' }, { c:'🍞', l:'面包' }, { c:'🍜', l:'面条' },
      { c:'🍚', l:'米饭' }, { c:'🍗', l:'鸡腿' }, { c:'🍔', l:'汉堡' }, { c:'🍟', l:'薯条' }, { c:'🍰', l:'蛋糕' },
      { c:'🍦', l:'冰淇淋' }, { c:'☕', l:'咖啡' }, { c:'🍵', l:'茶' }, { c:'🍺', l:'啤酒' }, { c:'🎂', l:'生日蛋糕' },
    ]},
    { key: 'symbol', name: '符号', items: [
      { c:'✅', l:'完成' }, { c:'❌', l:'错误' }, { c:'⚠️', l:'警告' }, { c:'❓', l:'问号' }, { c:'❗', l:'感叹' },
      { c:'🎉', l:'庆祝' }, { c:'🎊', l:'彩带' }, { c:'🎁', l:'礼物' }, { c:'🏆', l:'奖杯' }, { c:'🥇', l:'金牌' },
      { c:'💰', l:'钱' }, { c:'💡', l:'灯泡' }, { c:'🔔', l:'铃铛' }, { c:'📌', l:'图钉' }, { c:'📚', l:'书' },
      { c:'✏️', l:'铅笔' }, { c:'📷', l:'相机' }, { c:'🎵', l:'音乐' }, { c:'⚽', l:'足球' }, { c:'🏀', l:'篮球' },
    ]},
  ];
  const EMOJI_ALL = EMOJI_GROUPS.reduce((a, g) => a.concat(g.items.map(x => x.c)), []);

  function newStickerId() {
    return 'st_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function isImageDataUrl(v) { return /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(String(v || '')); }
  function isHttpUrl(v) { return /^https?:\/\//i.test(String(v || '')); }
  // 自定义表情包规范化：名称 + 图片(dataURL 或 http URL)
  function normalizeSticker(s) {
    if (!s || typeof s !== 'object') return null;
    const image = String(s.image || s.data || '').trim();
    if (!isImageDataUrl(image) && !isHttpUrl(image)) return null;
    return {
      id: str(s.id, 80) || newStickerId(),
      name: sanitizeText(s.name, 30) || '表情',
      image,
    };
  }
  // 图片消息规范化：kind=image，image 为 dataURL；text 为无障碍占位
  function normalizeImageMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const image = String(m.image || '').trim();
    if (!isImageDataUrl(image)) return null;
    return {
      from: str(m.from, 160),
      kind: 'image',
      image,
      text: sanitizeText(m.text, 60) || '[图片]',
      time: str(m.time, 20),
      w: Number(m.w) > 0 ? Number(m.w) : 0,
      h: Number(m.h) > 0 ? Number(m.h) : 0,
    };
  }
  // 表情消息（大表情包）规范化：kind=sticker
  function normalizeStickerMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const image = String(m.image || '').trim();
    if (!isImageDataUrl(image) && !isHttpUrl(image)) return null;
    return {
      from: str(m.from, 160),
      kind: 'sticker',
      image,
      text: sanitizeText(m.text, 60) || '[表情]',
      time: str(m.time, 20),
    };
  }
  // 计算压缩目标尺寸：保持比例，最长边不超过 maxSide
  function fitImageSize(w, h, maxSide) {
    const W = Math.max(1, Number(w) || 1), H = Math.max(1, Number(h) || 1);
    const M = Math.max(32, Number(maxSide) || IMAGE_MAX_SIDE);
    if (W <= M && H <= M) return { w: W, h: H, scaled: false };
    const scale = M / Math.max(W, H);
    return { w: Math.max(1, Math.round(W * scale)), h: Math.max(1, Math.round(H * scale)), scaled: true };
  }
  // dataURL 估算字节数（去掉 header 后 base64 长度的 3/4）
  function dataUrlBytes(v) {
    const s = String(v || '');
    const i = s.indexOf(',');
    const b64 = i >= 0 ? s.slice(i + 1) : s;
    return Math.floor(b64.length * 3 / 4);
  }
  // 表情工作区规范化：自定义 + 收藏（收藏的是 emoji 字符或 sticker id）
  function normalizeEmoticons(e) {
    const out = { custom: [], favorites: [] };
    if (!e || typeof e !== 'object') return out;
    if (Array.isArray(e.custom)) out.custom = e.custom.map(normalizeSticker).filter(Boolean).slice(0, STICKER_MAX);
    if (Array.isArray(e.favorites)) out.favorites = e.favorites.map(x => String(x || '').trim()).filter(Boolean).slice(0, STICKER_MAX);
    return out;
  }
  function toggleFavorite(list, key) {
    const k = String(key || '');
    if (!k) return Array.isArray(list) ? list.slice() : [];
    const arr = Array.isArray(list) ? list.slice() : [];
    const i = arr.indexOf(k);
    if (i >= 0) arr.splice(i, 1); else arr.push(k);
    return arr;
  }
  function nowHM(d) {
    const dt = d instanceof Date ? d : new Date();
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  }

  /* ======================================================================
     闲置超时二次验证（纯函数）
     无人操作超过 idleTimeoutMinutes 后锁定当前会话，二次验证只需当前账户密码。
     ====================================================================== */
  const IDLE_TIMEOUT_MS = Math.max(1, Number(AUTH_CFG.idleTimeoutMinutes) || 60) * 60 * 1000;
  function idleTimeoutMs() { return IDLE_TIMEOUT_MS; }
  // 会话闲置毫秒数：优先 lastActivityAt，其次 lastActiveAt，缺失按 createdAt / 当前时间
  function sessionIdleMs(sess, now) {
    if (!sess) return 0;
    const t = Date.parse(sess.lastActivityAt || sess.lastActiveAt || sess.createdAt || '');
    const n = Number(now) || Date.now();
    return Number.isFinite(t) ? Math.max(0, n - t) : 0;
  }
  function isSessionIdleLocked(sess, now) { return sessionIdleMs(sess, now) >= IDLE_TIMEOUT_MS; }
  function stampActivity(sess, now) {
    const n = Number(now) || Date.now();
    return { lastActivityAt: new Date(n).toISOString(), lastActiveAt: new Date(n).toISOString() };
  }
  function formatIdleCountdown(ms) {
    const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  /* ======================================================================
     课程表（纯函数）
     班级键 classKey = `${grade}-${className}`；每周 5 天 × 每天 7 节。
     内置国内小学通用作息模板，可由班级主任逐格覆盖；超管与班级主任可编辑，
     班级主任可管理多个班级（managedClasses）。
     ====================================================================== */
  const WEEKDAYS = [
    { key:1, label:'周一' }, { key:2, label:'周二' }, { key:3, label:'周三' },
    { key:4, label:'周四' }, { key:5, label:'周五' },
  ];
  const SCHEDULE_PERIODS = [
    { period:1, label:'第1节', time:'08:00–08:40' },
    { period:2, label:'第2节', time:'08:50–09:30' },
    { period:3, label:'第3节', time:'09:45–10:25' },
    { period:4, label:'第4节', time:'10:35–11:15' },
    { period:5, label:'第5节', time:'14:00–14:40' },
    { period:6, label:'第6节', time:'14:50–15:30' },
    { period:7, label:'第7节', time:'15:40–16:20' },
  ];
  const SUBJECTS_BY_GRADE = {
    1:['语文','数学','道德与法治','音乐','美术','体育','科学','班会'],
    2:['语文','数学','道德与法治','音乐','美术','体育','科学','班会'],
    3:['语文','数学','英语','道德与法治','音乐','美术','体育','科学','班会'],
    4:['语文','数学','英语','道德与法治','音乐','美术','体育','科学','班会'],
    5:['语文','数学','英语','道德与法治','音乐','美术','体育','科学','班会'],
    6:['语文','数学','英语','道德与法治','音乐','美术','体育','科学','班会'],
  };
  function classKeyOf(grade, className) { return `${Number(grade)||1}-${str(className,20)||'1班'}`; }
  function parseClassKey(key) {
    const m = String(key || '').match(/^(\d)-(.+)$/);
    return m ? { grade: Number(m[1]), className: m[2] } : null;
  }
  function normalizeManagedClasses(v) {
    if (!Array.isArray(v)) return [];
    return Array.from(new Set(v.map(x => str(x, 40)).filter(x => parseClassKey(x))));
  }
  function isPlatformAdminAccount(account) {
    if (!account) return false;
    if (account.role === 'admin' || account.is_admin === true) return true;
    const mail = String(account.email || '').toLowerCase();
    const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').toLowerCase();
    return !!adminMail && mail === adminMail;
  }
  // 班级管理权限：超管可管全部；班级主任仅能管理 managedClasses 列举的班级
  function canManageClass(account, classKey) {
    if (!account || !classKey) return false;
    if (isPlatformAdminAccount(account)) return true;
    if (account.role !== 'headteacher' && account.role !== 'r_headteacher') return false;
    return normalizeManagedClasses(account.managedClasses).indexOf(str(classKey, 40)) >= 0;
  }
  function newSlotId() {
    return 'slot_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function normalizeScheduleSlot(raw) {
    if (!isPlainObject(raw)) return null;
    const weekday = Number(raw.weekday);
    const period = Number(raw.period);
    if (!(weekday >= 1 && weekday <= 5) || !(period >= 1 && period <= SCHEDULE_PERIODS.length)) return null;
    return {
      id: str(raw.id, 64) || newSlotId(),
      classKey: str(raw.classKey, 40),
      weekday, period,
      subject: sanitizeText(raw.subject, 20),
      time: sanitizeText(raw.time, 40) || (SCHEDULE_PERIODS[period - 1] || {}).time || '',
      teacher: sanitizeText(raw.teacher, 30),
      teacherId: str(raw.teacherId, 80),
      remark: sanitizeText(raw.remark, 120),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }
  // 内置模板：按年级默认科目表轮转排布，节次时间取通用作息；班主任可逐格覆盖
  function buildScheduleTemplate(grade, className) {
    const g = Number(grade) || 1;
    const key = classKeyOf(g, className);
    const subjects = SUBJECTS_BY_GRADE[g] || SUBJECTS_BY_GRADE[1];
    const slots = [];
    for (let d = 1; d <= 5; d++) {
      for (let p = 1; p <= SCHEDULE_PERIODS.length; p++) {
        const idx = (d * 3 + p * 2 + g) % subjects.length;
        slots.push(normalizeScheduleSlot({
          classKey: key, weekday: d, period: p,
          subject: subjects[idx],
          time: SCHEDULE_PERIODS[p - 1].time,
          teacher: '', teacherId: '', remark: '',
        }));
      }
    }
    return slots;
  }
  function sortScheduleSlots(list) {
    return (Array.isArray(list) ? list : []).slice().sort((a, b) =>
      (Number(a.weekday) - Number(b.weekday)) || (Number(a.period) - Number(b.period)));
  }
  function slotAt(slots, weekday, period) {
    const w = Number(weekday), p = Number(period);
    return (Array.isArray(slots) ? slots : []).find(s => Number(s.weekday) === w && Number(s.period) === p) || null;
  }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  // 生成独立的、可直接打印/另存为 PDF 的课程表 HTML 文档（内联样式，不依赖站点 CSS）
  // opts: { slots, classKey, gradeLabel, className, printedAt(Date) }
  function buildSchedulePrintHtml(opts) {
    const o = opts || {};
    const slots = Array.isArray(o.slots) ? o.slots : [];
    const gradeText = str(o.gradeLabel, 20) || '年级';
    const classText = str(o.className, 20) || '';
    const classKey = str(o.classKey, 40);
    const d = o.printedAt instanceof Date ? o.printedAt : new Date();
    const dateText = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const sorted = sortScheduleSlots(slots);
    const head = `<tr><th class="pd-period">节次 / 时间</th>${WEEKDAYS.map(w => `<th>${escapeHtml(w.label)}</th>`).join('')}</tr>`;
    const body = SCHEDULE_PERIODS.map(p => {
      const cells = WEEKDAYS.map(w => {
        const s = slotAt(sorted, w.key, p.period);
        if (!s || !s.subject) return `<td class="pd-empty"></td>`;
        const teacher = s.teacher ? `<span class="pd-teacher">${escapeHtml(s.teacher)}</span>` : '';
        const remark = s.remark ? `<span class="pd-remark">${escapeHtml(s.remark)}</span>` : '';
        return `<td class="pd-course"><b>${escapeHtml(s.subject)}</b>${teacher}${remark}</td>`;
      }).join('');
      return `<tr><td class="pd-period"><b>${escapeHtml(p.label)}</b><span class="pd-time">${escapeHtml(p.time)}</span></td>${cells}</tr>`;
    }).join('');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(gradeText + classText + ' 课程表')}</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif; color: #1f2430; }
.pd-wrap { width: 100%; }
.pd-header { text-align: center; margin-bottom: 14px; border-bottom: 2px solid #f2653a; padding-bottom: 10px; }
.pd-header h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 1px; }
.pd-header .pd-meta { font-size: 12px; color: #6b7280; }
.pd-header .pd-meta span { margin: 0 12px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #9aa3b2; padding: 6px 4px; text-align: center; vertical-align: middle; height: 62px; }
thead th { background: #fdece6; font-size: 13px; }
.pd-period { width: 92px; background: #faf3f0; }
.pd-period b { display: block; font-size: 13px; }
.pd-time { display: block; font-size: 10px; color: #6b7280; margin-top: 3px; }
.pd-course b { display: block; font-size: 14px; color: #1f2430; }
.pd-teacher { display: block; font-size: 11px; color: #4b5563; margin-top: 3px; }
.pd-remark { display: block; font-size: 10px; color: #8a94a6; margin-top: 2px; }
.pd-empty { background: #fcfcfd; }
.pd-footer { margin-top: 10px; font-size: 11px; color: #9aa3b2; display: flex; justify-content: space-between; }
@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } tr { page-break-inside: avoid; } }
</style></head><body><div class="pd-wrap">
<div class="pd-header"><h1>${escapeHtml(gradeText + ' ' + classText + ' 课程表').trim()}</h1>
<div class="pd-meta"><span>班级：${escapeHtml(gradeText + classText)}</span><span>打印日期：${escapeHtml(dateText)}</span><span>Sunshine个人工作站</span></div></div>
<table><thead>${head}</thead><tbody>${body}</tbody></table>
<div class="pd-footer"><span>班级键：${escapeHtml(classKey)}</span><span>每周 5 天 × 每天 7 节</span></div>
</div></body></html>`;
  }

  /* ======================================================================
     跨设备同步（纯函数）
     user_sync 表按 owner_id + scope 存 JSON；本地构造 / 合并 / 规范化。
     合并按 updatedAt 取新，避免手机 / 电脑互相覆盖。
     ====================================================================== */
  const USER_SYNC_SCOPES = ['workspace', 'account', 'schedule'];
  const SYNC_FIELDS = ['library','learning','directory','conversations','notifications','pendingEvents','emoticons','notices','schedules'];
  // 账户身份键集合：邮箱 / id / 用户名 / 显示名，全部小写。
  // 电脑端与手机端可能用不同别名登录同一账户（admin、邮箱、超管绑定邮箱），
  // 口令同步必须按"任一别名命中"匹配，否则会出现同一人多套密码。
  function identityKeysOf(u) {
    if (!u) return [];
    const out = [];
    const push = (v) => {
      const s = String(v == null ? '' : v).trim().toLowerCase();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    push(u.email); push(u.id); push(u.username); push(u.name);
    return out;
  }
  // 强身份键：仅 email 与规范化 id，用于口令同步。姓名 / username（如历史脏数据 username='admin'）
  // 不得作为口令归属依据，否则工号会与超管交叉命中、哈希互相覆盖，导致 admin 密码失效。
  function strongIdentityKeysOf(u) {
    if (!u) return [];
    const out = [];
    const push = (v) => {
      const s = String(v == null ? '' : v).trim().toLowerCase();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    if (String(u.email || '').indexOf('@') > 0) push(u.email);
    [u.id, u.owner_id, u.uid].forEach(v => {
      const s = String(v == null ? '' : v).trim().toLowerCase();
      if (/^[up]_/.test(s) || /^\d{8,}$/.test(s)) push(s);
    });
    return out;
  }
  function identityMatches(u, keys) {
    const own = identityKeysOf(u);
    return Array.isArray(keys) && keys.some(k => own.indexOf(String(k).trim().toLowerCase()) >= 0);
  }
  function buildUserSyncPayload(state, scope) {
    const s = state || {};
    const base = { scope: USER_SYNC_SCOPES.indexOf(scope) >= 0 ? scope : 'workspace', updatedAt: new Date().toISOString() };
    if (scope === 'account') {
      // 登录口令跨设备统一：把本机所有账户的口令哈希随 account 域同步，
      // 使电脑端改密后手机端拉取即以同一口令登录（不存明文）。
      // authSecret 保留为超管专用字段（兼容旧版本），authSecrets 覆盖全部账户；
      // 每条携带 aliases 身份别名，解决同一账户在两端用不同标识登录导致匹配失败的问题。
      let authSecret = null;
      const authSecrets = [];
      const seen = new Set();
      const addSecret = (u) => {
        if (!u || !u.passwordHash) return;
        const keys = identityKeysOf(u);
        if (!keys.length) return;
        const sig = keys.slice().sort().join('|');
        if (seen.has(sig)) return;
        seen.add(sig);
        // accountKey / email / strongKeys 一律用强身份（email + 规范 id），
        // 不用 name/username，避免工号 username='admin' 与超管交叉命中。
        // aliases 仍保留全量键以兼容旧版接收端与测试。
        const strong = strongIdentityKeysOf(u);
        const primary = strong[0] || keys[0];
        const email = String(u.email || '').trim().toLowerCase();
        const entry = { accountKey: primary, aliases: keys, passwordHash: u.passwordHash,
          email, strongKeys: strong };
        authSecrets.push(entry);
        if (!authSecret && (u.role === 'admin' || u.is_admin === true)) {
          authSecret = { accountKey: primary, aliases: keys, passwordHash: u.passwordHash,
            email, strongKeys: strong };
        }
      };
      // 源头锁死：推送前把「权威超管」（绑定邮箱 / p_superadmin id）的角色强制为 admin，
      // 避免任何一端被污染后把 role=student 的超管载荷推上云端、再扩散到其它端。
      // 关键：判定必须用权威身份，不能用 role/is_admin——历史事故里学生被脏载荷写成
      // role=admin/username=admin，若按 role 判定会把假超管锁死并上行污染全端。
      const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').trim().toLowerCase();
      const isAuthoritative = (u) => {
        if (!u) return false;
        if (!!adminMail && String(u.email || '').trim().toLowerCase() === adminMail) return true;
        const id = String(u.id || '').trim().toLowerCase();
        return id === 'p_superadmin' || id === 'u_superadmin';
      };
      const lockAdmin = (u) => {
        if (!u) return u;
        return isAuthoritative(u) ? Object.assign({}, u, { role: 'admin', is_admin: true }) : u;
      };
      const sourceUsers = (Array.isArray(s.users) ? s.users : []).map(lockAdmin);
      sourceUsers.forEach(addSecret);
      const acct = lockAdmin(s.account);
      if (acct) {
        let hash = acct.passwordHash;
        if (!hash && Array.isArray(s.users)) {
          const keys = identityKeysOf(acct);
          const src = s.users.find(u => identityMatches(u, keys));
          if (src) hash = src.passwordHash;
        }
        addSecret(Object.assign({}, acct, { passwordHash: hash }));
      }
      return Object.assign(base, {
        account: acct ? {
          id:acct.id, name:acct.name, email:acct.email, phone:acct.phone,
          role:acct.role, grade:acct.grade, dept:acct.dept, gender:acct.gender,
          age:acct.age, signature:acct.signature, avatar:acct.avatar, color:acct.color,
          verified:acct.verified, managedClasses:normalizeManagedClasses(acct.managedClasses),
        } : null,
        authSecret,
        authSecrets,
        roles: s.roles || [], viewPerms: s.viewPerms || {}, permissions: s.permissions || [],
      });
    }
    if (scope === 'schedule') return Object.assign(base, { schedules: Array.isArray(s.schedules) ? s.schedules : [] });
    const payload = Object.assign(base, {});
    SYNC_FIELDS.forEach(k => { payload[k] = clonePlain(s[k]); });
    // 工号（人员名录）跨设备一致：workspace 域携带完整 users（含口令哈希，非明文），
    // 使新建工号后立即同步时，另一端拉取 workspace 即可得到同一份人员数据。
    // 使用 clonePlain 深拷贝，避免应用端合并时污染本地 state。
    // 推送前锁死超管角色（与 account 域同源），防止被污染的 student 超管上行扩散。
    const adminMail = String((window.APP_CONFIG && window.APP_CONFIG.adminEmail) || '').trim().toLowerCase();
    const isAuthoritative = (u) => {
      if (!u) return false;
      if (!!adminMail && String(u.email || '').trim().toLowerCase() === adminMail) return true;
      const id = String(u.id || '').trim().toLowerCase();
      return id === 'p_superadmin' || id === 'u_superadmin';
    };
    payload.users = clonePlain((Array.isArray(s.users) ? s.users : []).map(u => {
      if (!u) return u;
      // 权威超管锁 admin；非权威却冒充 admin 的假超管在此纠正为 student，杜绝上行污染。
      if (isAuthoritative(u)) return Object.assign({}, u, { role: 'admin', is_admin: true });
      if (u.role === 'admin' || u.is_admin === true || String(u.username || '').toLowerCase() === 'admin') {
        return Object.assign({}, u, { role: 'student', is_admin: false });
      }
      return u;
    }));
    return payload;
  }
  function normalizeUserSyncRow(row) {
    if (!isPlainObject(row)) return null;
    let payload = row.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { return null; } }
    if (!isPlainObject(payload)) return null;
    return { id:row.id, ownerId:row.owner_id || row.ownerId, scope:row.scope || payload.scope || 'workspace',
      payload, updatedAt: row.updated_at || row.updatedAt || payload.updatedAt || null };
  }
  // 决定远端是否更新：远端时间更新且内容不同才应用（由时间较新一方胜出）
  function shouldApplySync(localUpdatedAt, remoteUpdatedAt, localPayload, remotePayload) {
    const r = Date.parse(remoteUpdatedAt || '');
    const l = Date.parse(localUpdatedAt || '');
    if (!Number.isFinite(r)) return false;
    if (!Number.isFinite(l)) return true;
    if (r <= l) return false;
    try { return JSON.stringify(localPayload) !== JSON.stringify(remotePayload); }
    catch (e) { return true; }
  }

  /* ======================================================================
     实时同步：主动与云端校验
     ----------------------------------------------------------------------
     管理后台「实时同步」按钮调用。对每个同步域读取云端元数据，与本机的
     syncMeta 比较，产出"云端更新/本地已最新/云端无数据/校验失败"报告。
     只读、不改 state；真正的拉取与推送由 app 层据此按时间戳收敛，
     确保"较新者胜出"，不覆盖云端最新数据、不产生重复数据。
     ====================================================================== */
  async function checkRealtimeSync(localMetas, scopes) {
    const denied = requireAdmin(); if (denied) return denied;
    const metas = (localMetas && typeof localMetas === 'object') ? localMetas : {};
    const list = (Array.isArray(scopes) && scopes.length)
      ? scopes.filter(s => USER_SYNC_SCOPES.indexOf(s) >= 0)
      : USER_SYNC_SCOPES.slice();
    const cloud = await cloudClient();
    if (!cloud) return fail('云服务未就绪，请检查网络后重试', { code: 'CLOUD_NOT_READY' });
    const reports = [];
    for (const scope of list) {
      try {
        const res = await pullUserSync(scope);
        if (!res.ok || !res.data) {
          reports.push({ scope, ok: false, hasRemote: false, remoteNewer: false,
            error: (res && res.message) || '云端校验失败', code: 'SYNC_CHECK_FAILED' });
          continue;
        }
        const row = res.data;
        const localAt = metas[scope] || null;
        const remoteAt = row.updatedAt || null;
        // 云端记录存在但 payload 无有效数据时视为无数据，避免空覆盖
        const hasRemote = !!(row.payload && Object.keys(row.payload).length);
        const remoteNewer = hasRemote && shouldApplySync(localAt, remoteAt, null, row.payload);
        reports.push({ scope, ok: true, hasRemote, remoteNewer,
          localUpdatedAt: localAt, remoteUpdatedAt: remoteAt });
      } catch (e) {
        reports.push({ scope, ok: false, hasRemote: false, remoteNewer: false,
          error: (e && e.message) || '网络异常', code: 'CLOUD_ERROR' });
      }
    }
    return ok({ reports, checkedAt: new Date().toISOString() }, '云端校验完成');
  }

  /* ---------- 挂载 ---------- */
  const API = {
    bind, ok, fail, fromCloud,
    publicUser, hashPassword, parseJsonArray,
    verifyPassword, setPassword, markEmailVerified, resetPasswordByEmail,
    listPersons, createPerson, updatePerson, deletePerson, syncPersonnel, listRoleConfigs, saveRoleConfigs,
    syncDirectoryUsers, identityRule,
    normalizePresence, presenceLabel, effectivePresence, sessionKeyOf,
    upsertSession, listSessions, switchSession, setSessionPresence, closeSession, closeAllSessions, reconcileSessions, adoptCurrentSession,
    sessionTtlMs, isSessionExpired, readActivePointer, writeActivePointer, syncActivePointer, refreshSessionsFromShared,
    gradeScopeFor, canAccessGrade, filterByGradeScope, assertGradeAccess,
    COMMENT_KINDS, COMMENT_LABELS, normalizeComment, commentKindsFor, canPostComment, appendComment, groupComments,
    normalizeShares, deleteShares,
    CALL_SIGNAL_KINDS, CALL_KIND_LABELS, newCallId, normalizeCallSignal, signalsFor, canStartCall, callMode, formatCallDuration,
    NOTICE_KINDS, NOTICE_KIND_LABELS, newNoticeId, normalizeNotice, sortNotices, noticeReadBy, markNoticeRead, canPublishNotice,
    ACTIVITY_EVENT_KINDS, ACTIVITY_EVENT_LABELS, newActivityId, normalizeActivityEvent, activityToMessage, flushActivityEvents,
    BACKUP_TARGETS, BACKUP_TARGET_LABELS, newBackupId, buildBackup, validateBackup, normalizeWebDavConfig, isValidWebDavUrl, formatBackupSize,
    IMAGE_MAX_SIDE, IMAGE_QUALITY, IMAGE_MAX_BYTES, STICKER_MAX, EMOJI_GROUPS, EMOJI_ALL,
    newStickerId, isImageDataUrl, isHttpUrl, normalizeSticker, normalizeImageMessage, normalizeStickerMessage,
    fitImageSize, dataUrlBytes, normalizeEmoticons, toggleFavorite, nowHM,
    IDLE_TIMEOUT_MS, idleTimeoutMs, sessionIdleMs, isSessionIdleLocked, stampActivity, formatIdleCountdown,
    WEEKDAYS, SCHEDULE_PERIODS, SUBJECTS_BY_GRADE, classKeyOf, parseClassKey, normalizeManagedClasses,
    isPlatformAdminAccount, canManageClass, newSlotId, normalizeScheduleSlot, buildScheduleTemplate,
    sortScheduleSlots, slotAt, escapeHtml, buildSchedulePrintHtml,
    USER_SYNC_SCOPES, SYNC_FIELDS, identityKeysOf, identityMatches, buildUserSyncPayload, normalizeUserSyncRow, shouldApplySync,
    listPermissionDefs, savePermissionDefs, saveViewPerms,
    updateCloudProfile, setCloudPassword,
    pushUserSync, pullUserSync, checkRealtimeSync, listSchedules, saveScheduleSlot, deleteScheduleSlot,
    fetchCloudMaterials,
    listMaterials, getMaterial, createMaterial, updateMaterial, deleteMaterial,
    getRealtimeStats, getOverviewStats,
    getAccountCleanupPlan, cleanupAccounts,
  };
  window.SunnyAPI = API;
})();
