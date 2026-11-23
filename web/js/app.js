/* ==========================================================================
   Sunshine个人工作站 — 应用逻辑 (Vanilla JS SPA)
   ========================================================================== */

/* ---------- 注入统一数据接口层上下文 ---------- */
if (window.SunnyAPI) window.SunnyAPI.bind({ state: null, hasPerm: null, persist: null, isCloudMode: null });
function bindApiContext() {
  // 云端会话若 SDK 凭证不属于自己，视为“待验证”，按本地快照工作，避免以他人身份写云端
  if (window.SunnyAPI) window.SunnyAPI.bind({ state, hasPerm, persist, isCloudMode: () => state.cloudMode && !state.cloudStale });
}
// 通讯录以自定义用户为权威数据源实时重建；匹配/去重规则统一由 API 层执行
function syncDirectoryNow() {
  if (window.SunnyAPI && window.SunnyAPI.syncDirectoryUsers) {
    const res = window.SunnyAPI.syncDirectoryUsers();
    if (res && res.ok && res.data) {
      state.directory.members = res.data.members;
      state.directory.conflicts = res.data.conflicts;
      state.directory.syncedAt = new Date().toISOString();
    }
  }
  return state.directory.members;
}
function directoryMembers() {
  return Array.isArray(state.directory.members) && state.directory.members.length
    ? state.directory.members : syncDirectoryNow();
}
function findDirectoryMember(id) {
  return directoryMembers().find(m => String(m.id) === String(id)) || null;
}
// 在线状态统一取展示口径（会话在线 / 停用离线 / 其余按字段），避免各处自行判断
function presenceOf(u) {
  if (window.SunnyAPI && window.SunnyAPI.effectivePresence) return window.SunnyAPI.effectivePresence(u, state.account);
  return u && u.presence === 'online' ? 'online' : u && u.presence === 'away' ? 'away' : 'offline';
}
function presenceText(u) {
  return presenceOf(u) === 'online' ? '在线' : presenceOf(u) === 'away' ? '离开' : '离线';
}

/* ---------- 全局状态 ---------- */
const state = {
  authed: false,
  cloudMode: false,          // 当前是否为云端登录模式
  superAdminInitialized: false, // 默认超管是否已初始化（一次性标记，防止覆盖已有账号）
  remember: false,           // 是否记住登录状态（会话内保持）
  rememberPassword: false,   // 是否记住账号密码（跨浏览器回填凭据）
  view: 'library',           // library | shares | directory | admin
  role: 'student',           // student | teacher | admin (演示角色)
  account: { ...USERS[0] },  // 当前会话工作副本的账户（含 verified 状态）
  sessions: [],              // 多账户会话列表（同一浏览器同时在线）
  activeSessionId: null,     // 当前激活会话 id
  cloudAuthKey: null,        // 持有云端 SDK 凭证的会话 id（同一时刻仅一个）
  cloudStale: false,         // 当前会话是否为“云端待验证”（凭证属于其它账户，退回本地快照）
  library: { grade: 'all', subject: 'all', query: '', mode: 'grid' },
  learning: [],              // 已添加学习清单：{ id, addedAt }，按会话私有隔离
  directory: { query: '', roleFilter: 'all', activeConv: 'c01', chatFullscreen: false, members: [], conflicts: [], syncedAt: null, moreOpen: false, emojiOpen: false, emojiTab: 'face' },
  admin: { tab: 'overview', userQuery: '', activeRole: 'r_admin', permSub: 'assign', materialQuery: '', monitorTimer: null, monitorAuto: true },
  users: USERS.map(u => ({ ...u })),
  roles: ROLES.map(r => ({ ...r, perms: [...r.perms] })),
  permissions: PERMISSIONS.map(p => ({ ...p })),            // 权限项定义（内置 + 自定义）
  viewPerms: { ...DEFAULT_VIEW_PERMISSIONS },               // 视图 → 门禁权限项 key
  conversations: CONVERSATIONS.map(c => ({ ...c, messages: c.messages.map(m => ({...m})) })),
  notifications: NOTIFICATIONS.map(n => ({ ...n })),
  pendingEvents: [],           // 会话私有的离线活动事件（未接来电/消息/视频通话），上线时写入聊天记录
  emoticons: { custom: [], favorites: [] }, // 会话私有的表情包：自定义 + 收藏
  notices: [],                 // 全员广播通知（云端 notices 表 + 本地跨标签同步）
  schedules: [],               // 课程表节次（云端 class_schedules + 本地缓存），按班级键隔离
  syncMeta: { workspace:null, account:null, schedule:null }, // 各同步域最后同步时间（跨设备冲突判定）
  reauth: { required:false, at:null }, // 闲置超时二次验证状态
  backup: { target:'internal', webdav:{ url:'', username:'', password:'', remotePath:'' }, localPath:'',
    autoEnabled:false, autoIntervalHours:24, lastBackupAt:null, history:[] }, // 超管备份配置与历史
  materials: MATERIALS.map(m => ({ ...m, points: [...m.points], chapters: [...m.chapters] })),
  shares: SHARES.map(s => ({ ...s, like_by: [...s.like_by] })),
  // 绑定向导临时数据
  binding: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const icon = (id, cls = '') => `<svg class="icon ${cls}"><use href="#${id}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeParseArray = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } } return []; };
const AVATAR_COLORS = new Set(['avatar--sky','avatar--berry','avatar--sun','avatar--mint','avatar--brand','avatar--lilac','avatar--teal']);
const avatarHTML = (u, cls = '') => {
  const color = AVATAR_COLORS.has(u.color) ? u.color : '';
  return `<span class="avatar ${cls} ${color}">${esc(u.avatar || u.name?.[0] || '友')}</span>`;
};

/* ---------- 浏览器会话门闸：关闭浏览器后必须重新登录 ----------
   登录态（会话清单、活动指针）虽持久化在 localStorage，但"本次浏览器会话
   是否处于已登录"由 sessionStorage 的门闸标记决定：
     - 刷新页面 / 同会话新标签：sessionStorage 保留 → 自动恢复登录；
     - 关闭浏览器后重新打开：sessionStorage 随会话销毁 → 门闸消失 → 强制回到登录页。
   环境兼容：Node 测试无 sessionStorage，视为无法判定时不强制登出（保持原行为），
   仅真实浏览器启用该门闸。 */
const SESSION_GATE_KEY = ((window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1') + ':session-gate';
function sessionStorageRef() {
  try { return (typeof window !== 'undefined' && window.sessionStorage) ? window.sessionStorage : null; }
  catch (e) { return null; }
}
function markSessionLoggedIn() {
  const s = sessionStorageRef(); if (!s) return;
  try { s.setItem(SESSION_GATE_KEY, '1'); } catch (e) {}
}
function clearSessionGate() {
  const s = sessionStorageRef(); if (!s) return;
  try { s.removeItem(SESSION_GATE_KEY); } catch (e) {}
}
// 仅在浏览器提供 sessionStorage 时才启用门闸；无该能力时返回 true（放行，兼容测试/降级）
function sessionGateAllowsRestore() {
  const s = sessionStorageRef(); if (!s) return true;
  try { return s.getItem(SESSION_GATE_KEY) === '1'; } catch (e) { return true; }
}

/* ---------- 本地数据持久化：与云端表结构一一对应 ---------- */
let suppressSyncPush = false;
function persist() {
  syncDirectoryNow();
  if (!window.SunnyStore) return;
  window.SunnyStore.save({
    users: state.users,
    roles: state.roles,
    permissions: state.permissions,
    viewPerms: state.viewPerms,
    directoryMembers: state.directory.members,
    conversations: state.conversations,
    notifications: state.notifications,
    pendingEvents: state.pendingEvents,
    emoticons: state.emoticons,
    notices: state.notices,
    schedules: state.schedules,
    syncMeta: state.syncMeta,
    backup: state.backup,
    learning: state.learning,
    materials: state.materials,
    shares: state.shares,
    account: state.account,
    // "记住登录状态"未勾选时，登录态仅保留在内存：不落会话快照、不落活动指针，
    // 刷新页面或重新打开都会回到登录页（但仍保留资料/权限等非登录数据）。
    sessions: state.remember ? state.sessions : [],
    activeSessionId: state.remember ? state.activeSessionId : null,
    cloudAuthKey: state.remember ? state.cloudAuthKey : null,
    remember: state.remember,
    authed: state.remember ? state.authed : false,
    role: state.role,
    superAdminInitialized: state.superAdminInitialized,
  });
  // 云端同步：本地变更节流上传（函数定义在文件后部，运行时已就绪）
  // 拉取远端数据后临时置位 suppressSyncPush，避免把刚拉下来的数据又推回去形成回声循环
  if (!suppressSyncPush && typeof scheduleSyncPush === 'function') {
    scheduleSyncPush('workspace');
    scheduleSyncPush('account');
    scheduleSyncPush('schedule');
  }
}
function hydrate() {
  const saved = window.SunnyStore && window.SunnyStore.load();
  if (!saved) return;
  const isArrOfObjects = v => Array.isArray(v) && v.every(x => x && typeof x === 'object' && !Array.isArray(x));
  if (isArrOfObjects(saved.users) && saved.users.length) state.users = saved.users;
  if (isArrOfObjects(saved.roles) && saved.roles.length) state.roles = saved.roles;
  // 兼容旧版本本地角色数据：超管角色始终拥有全部内置权限
  // （否则老账户升级后 r_admin 缺少后来新增的 publish_notice，导致「消息通知」入口被门禁隐藏）
  (function ensureAdminBuiltinPerms() {
    const admin = state.roles.find(r => r.id === 'r_admin' || r.key === 'r_admin');
    if (!admin) return;
    const builtins = BUILTIN_PERMISSIONS.map(p => p.key);
    admin.perms = Array.from(new Set([...(Array.isArray(admin.perms) ? admin.perms : []), ...builtins]));
  })();
  // 权限项：始终保留内置项，合并本地已保存的自定义项（防止内置项被本地旧数据抹除）
  if (isArrOfObjects(saved.permissions) && saved.permissions.length) {
    const custom = saved.permissions.filter(p => !BUILTIN_PERMISSIONS.some(b => b.key === p.key));
    state.permissions = [...BUILTIN_PERMISSIONS.map(p => ({ ...p })), ...custom];
  }
  if (saved.viewPerms && typeof saved.viewPerms === 'object' && !Array.isArray(saved.viewPerms)) {
    state.viewPerms = { ...DEFAULT_VIEW_PERMISSIONS, ...saved.viewPerms };
  }
  if (isArrOfObjects(saved.directoryMembers)) state.directory.members = saved.directoryMembers;
  if (isArrOfObjects(saved.conversations)) {
    state.conversations = saved.conversations.filter(c => Array.isArray(c.messages) && c.messages.every(m => m && typeof m === 'object'));
  }
  if (isArrOfObjects(saved.notifications)) state.notifications = saved.notifications;
  if (isArrOfObjects(saved.pendingEvents)) state.pendingEvents = saved.pendingEvents;
  if (saved.emoticons && typeof saved.emoticons === 'object') {
    state.emoticons = window.SunnyAPI.normalizeEmoticons(saved.emoticons);
  }
  if (isArrOfObjects(saved.notices)) {
    state.notices = saved.notices.map(n => window.SunnyAPI.normalizeNotice(n)).filter(Boolean);
  }
  if (isArrOfObjects(saved.schedules)) {
    state.schedules = saved.schedules.map(s => window.SunnyAPI.normalizeScheduleSlot(s)).filter(Boolean);
  }
  if (saved.syncMeta && typeof saved.syncMeta === 'object') {
    state.syncMeta = Object.assign({}, state.syncMeta, {
      workspace: saved.syncMeta.workspace || null,
      account: saved.syncMeta.account || null,
      schedule: saved.syncMeta.schedule || null,
    });
  }
  if (saved.backup && typeof saved.backup === 'object' && !Array.isArray(saved.backup)) {
    const b = saved.backup;
    state.backup = {
      target: ['internal','nas','local'].indexOf(b.target) >= 0 ? b.target : 'internal',
      webdav: { url:String(b.webdav?.url||''), username:String(b.webdav?.username||''), password:String(b.webdav?.password||''), remotePath:String(b.webdav?.remotePath||'') },
      localPath: String(b.localPath||''),
      autoEnabled: !!b.autoEnabled,
      autoIntervalHours: Math.min(720, Math.max(1, Number(b.autoIntervalHours)||24)),
      lastBackupAt: b.lastBackupAt || null,
      history: Array.isArray(b.history) ? b.history.slice(0, 50) : [],
    };
  }
  if (isArrOfObjects(saved.materials) && saved.materials.length) {
    state.materials = saved.materials.filter(m => m && SUBJECTS[m.subject]);
  }
  // 已添加学习清单：结构校验后恢复，过滤掉已不存在的资料 id（须在资料恢复之后）
  if (Array.isArray(saved.learning)) {
    const validIds = new Set(state.materials.map(m => String(m.id)));
    state.learning = saved.learning
      .filter(x => x && (typeof x === 'string' || x.id))
      .map(x => (typeof x === 'string' ? { id: String(x), addedAt: null } : { id: String(x.id), addedAt: x.addedAt || null }))
      .filter(x => validIds.has(x.id));
  }
  if (isArrOfObjects(saved.shares)) {
    state.shares = saved.shares.map(s => ({
      ...s,
      like_by: Array.isArray(s.like_by) ? s.like_by : [],
      comments: Array.isArray(s.comments) ? s.comments.filter(c => c && typeof c === 'object') : [],
    }));
  }
  if (saved.account && typeof saved.account === 'object' && !Array.isArray(saved.account)) {
    state.account = { ...state.account, ...saved.account };
  }
  // 多账户会话：结构校验后恢复；工作副本由 reconcileSessions 统一装载
  if (isArrOfObjects(saved.sessions)) {
    state.sessions = saved.sessions.filter(s => s && s.id && s.account && typeof s.account === 'object')
      .map(s => ({
        id: String(s.id),
        account: { ...s.account },
        role: s.role || s.account.role || 'student',
        cloudMode: !!s.cloudMode,
        presence: s.presence === 'away' ? 'away' : 'online',
        workspace: Object.assign({
          view: 'library',
          library: { grade: 'all', subject: 'all', query: '', mode: 'grid' },
          learning: [],
          directory: { query: '', roleFilter: 'all', activeConv: null },
          admin: { tab: 'overview', userQuery: '', activeRole: 'r_admin', permSub: 'assign', materialQuery: '', monitorAuto: true },
          conversations: [], notifications: [], pendingEvents: [], emoticons: { custom: [], favorites: [] },
        }, s.workspace && typeof s.workspace === 'object' ? s.workspace : {}),
        createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
        status: s.status || 'active',
        issuedAt: s.issuedAt, expiresAt: s.expiresAt,
      }));
  }
  if (typeof saved.activeSessionId === 'string') state.activeSessionId = saved.activeSessionId;
  if (typeof saved.cloudAuthKey === 'string') state.cloudAuthKey = saved.cloudAuthKey;
  if (saved.remember === true && saved.authed === true && state.account.verified) {
    state.remember = true;
    state.authed = true;
    if (['student','teacher','headteacher','admin'].includes(saved.role)) state.role = saved.role;
  }
  if (saved.superAdminInitialized === true) state.superAdminInitialized = true;
}

/* ---------- 清理内置演示账户 ----------
   源码内置的 u01–u12 演示用户会在首次打开或清空浏览器本地数据时重新出现，
   看起来像“人员管理恢复成之前的了”。正式环境只保留超级管理员，其余账户
   由超管创建（p…）或从云端同步（p_superadmin），因此启动时剔除这些演示 id，
   不影响超管新建账户与云端人员。 */
function purgeSeedDemoUsers() {
  const isDemoId = id => /^u\d{2}$/.test(String(id || ''));
  const before = state.users.length;
  state.users = state.users.filter(u => !isDemoId(u && u.id));
  if (state.users.length === before) return false;
  state.directory.members = (state.directory.members || []).filter(m => !isDemoId(m && m.id));
  if (state.account && isDemoId(state.account.id)) {
    const admin = state.users.find(u => u && u.role === 'admin');
    state.account = admin ? { ...admin } : { ...(state.users[0] || {}) };
    state.authed = false; // 演示账户已失效，强制重新登录
  }
  if (typeof persist === 'function') persist();
  return true;
}

/* ---------- 视口自适应 ----------
   按当前分辨率自动标记 phone / tablet / desktop 与屏幕方向，
   CSS 结合 data-viewport / data-orientation 调整登录与操作界面的布局与触控目标。 */
function syncViewportMode() {
  const docEl = document.documentElement;
  const width = Math.max(docEl.clientWidth || 0, window.innerWidth || 0);
  const height = Math.max(docEl.clientHeight || 0, window.innerHeight || 0);
  const viewport = width <= 680 ? 'phone' : (width <= 1024 ? 'tablet' : 'desktop');
  const orientation = width >= height ? 'landscape' : 'portrait';
  const coarse = !!(window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches);
  docEl.dataset.viewport = viewport;
  docEl.dataset.orientation = orientation;
  if (docEl.classList && docEl.classList.toggle) docEl.classList.toggle('is-touch', coarse);
  if (docEl.style && docEl.style.setProperty) {
    docEl.style.setProperty('--viewport-w', width + 'px');
    docEl.style.setProperty('--viewport-h', height + 'px');
  }
}

/* ---------- 超级管理员初始化 ----------
   默认凭据来自 APP_CONFIG.auth.superAdmin（username / password / displayName）。
   仅在「首次初始化」或「未显式配置」时生效：
     - 已写入初始化标记（superAdminInitialized）→ 一律跳过，不覆盖任何已有账号；
     - 已存在同名 / 同邮箱账号（管理员改过名或已初始化过）→ 只补标记，不创建、不覆盖。
   这样既保证开箱即用 admin/123456，又不重置管理员后续修改过的凭据。 */
function ensureSuperAdmin() {
  if (state.superAdminInitialized) return;
  const auth = (window.APP_CONFIG && window.APP_CONFIG.auth) || {};
  const cfg = auth.superAdmin || {};
  const username = String(cfg.username || 'admin').trim() || 'admin';
  const password = String(cfg.password || auth.defaultPassword || '123456');
  const displayName = String(cfg.displayName || '超级管理员');
  const norm = s => String(s || '').trim().toLowerCase();
  const uname = norm(username);

  // 已存在同名账号 / 同邮箱本地部分 / 云端绑定邮箱 / 任一超管角色的账号：
  // 视为已初始化，绝不覆盖。最后一条尤其关键：云端下发的 p_superadmin 使用绑定邮箱
  // 3440576634@qq.com，旧逻辑识别不到，会再建一个 u_superadmin（admin@sunny.edu.cn），
  // 于是"电脑登录 admin、手机登录邮箱"落到两个不同账户、口令自然不一致。
  const boundEmail = norm(window.APP_CONFIG && window.APP_CONFIG.adminEmail);
  const existed = state.users.some(u =>
    norm(u.name) === uname || norm(u.username) === uname ||
    norm(String(u.email || '').split('@')[0]) === uname ||
    (!!boundEmail && norm(u.email) === boundEmail) ||
    u.role === 'admin' || u.is_admin === true
  );
  if (existed) {
    state.superAdminInitialized = true;
    persist();
    return;
  }

  // 首次初始化：写入默认超管账号（口令以演示级哈希存储，不落明文）
  const email = username.includes('@') ? username : (username + '@sunny.edu.cn');
  state.users.unshift({
    id: 'u_superadmin',
    name: username,
    username,
    email,
    phone: '',
    role: 'admin',
    dept: '校务管理',
    status: 'active',
    verified: true,
    avatar: displayName.slice(0, 1),
    color: 'avatar--brand',
    passwordHash: window.SunnyAPI ? window.SunnyAPI.hashPassword(password) : undefined,
    created_at: new Date().toISOString(),
  });
  state.superAdminInitialized = true;
  persist();
}

// 权限系统：依据角色权限矩阵（state.roles）判断，管理员改权限后立即生效。
// 角色由账户真实 role 决定，用户无法自行切换；超管在后台分配权限后即时反映到此处。
function currentRole() {
  const roleMap = { admin:'r_admin', teacher:'r_teacher', headteacher:'r_headteacher', student:'r_student', parent:'r_parent' };
  const id = roleMap[state.role] || state.role; // 自定义角色 id 直接使用
  return state.roles.find(r => r.id === id || r.key === id) || null;
}
function currentPerms() {
  const role = currentRole();
  return role && Array.isArray(role.perms) ? role.perms : [];
}
function hasPerm(key) { return !!key && currentPerms().includes(key); }
function canPublish() { return hasPerm('publish'); }

// 视图门禁：主视图需具备对应权限项才可访问；未配置门禁（null）则所有人可见。
// admin 视图固定仅超级管理员可见，不受权限项分配影响。
function viewRequiredPerm(view) {
  if (view === 'admin') return null;
  const key = state.viewPerms[view];
  return key === undefined ? (DEFAULT_VIEW_PERMISSIONS[view] || null) : key;
}
function canView(view) {
  if (view === 'admin') return state.role === 'admin';
  const perm = viewRequiredPerm(view);
  return !perm || hasPerm(perm); // 无门禁或已授权
}

/* ---------- Toast ---------- */
function toast(msg, type = 'success') {
  const root = $('#toast-root');
  const ic = type === 'success' ? 'i-check' : type === 'error' ? 'i-x' : 'i-info';
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span class="toast__ic">${icon(ic, 'icon--sm')}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 200); }, 2800);
}

/* ---------- 模态框 ---------- */
let lastFocusedEl = null;
function focusFirst(root) {
  const target = root.querySelector('[autofocus], input:not([type=hidden]), select, textarea, .btn--primary, button');
  if (target) target.focus();
}
function openModal({ title, body, footer, wide = false }) {
  const root = $('#modal-root');
  if (!lastFocusedEl) lastFocusedEl = document.activeElement;
  root.innerHTML = `
    <div class="modal-mask" data-action="close-modal">
      <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-stop>
        <div class="modal__head"><h3>${esc(title)}</h3><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('i-x')}</button></div>
        <div class="modal__body">${body}</div>
        ${footer ? `<div class="modal__foot">${footer}</div>` : ''}
      </div>
    </div>`;
  focusFirst(root);
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  if (lastFocusedEl && document.contains(lastFocusedEl)) lastFocusedEl.focus();
  lastFocusedEl = null;
}
// 只拦截“点在遮罩上但落在弹窗内部”的误关；明确的关闭按钮（含其内部 svg/path）必须放行
function shouldIgnoreMaskClose(actionEl, target, action) {
  if (action !== 'close-modal' && action !== 'close-drawer') return false;
  const isMask = !!(actionEl && actionEl.classList &&
    (actionEl.classList.contains('modal-mask') || actionEl.classList.contains('drawer-mask')));
  return isMask && target !== actionEl && !!(target && target.closest && target.closest('[data-stop]'));
}

/* ==========================================================================
   登录 + 绑定流程
   ========================================================================== */
const authLayer = $('#auth-layer');

/* 记住密码：凭据读写（localStorage，跨浏览器重开回填）。
   仅存储账号与密码明文于本机浏览器，用于便利回填；不含任何服务端传输。
   与"记住登录状态"（会话级、关浏览器即失效）相互独立。 */
function readRememberedCredential() {
  try {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.authUi) || {};
    const key = cfg.credentialKey || 'sunny-classroom-login-credential';
    const raw = window.localStorage && window.localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.account !== 'string') return null;
    return { account: data.account, password: typeof data.password === 'string' ? data.password : '' };
  } catch (e) { return null; }
}
function saveRememberedCredential(account, password) {
  try {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.authUi) || {};
    const key = cfg.credentialKey || 'sunny-classroom-login-credential';
    if (!window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify({ account, password, savedAt: new Date().toISOString() }));
  } catch (e) {}
}
function clearRememberedCredential() {
  try {
    const cfg = (window.APP_CONFIG && window.APP_CONFIG.authUi) || {};
    const key = cfg.credentialKey || 'sunny-classroom-login-credential';
    if (window.localStorage) window.localStorage.removeItem(key);
  } catch (e) {}
}

function renderLogin(prefill = {}, message = '') {
  authLayer.classList.remove('hidden');
  $('#app').classList.add('hidden');
  const uiCfg = (window.APP_CONFIG && window.APP_CONFIG.authUi) || {};
  const savedCred = readRememberedCredential();
  // 预填：显式传入优先（如重置密码后），否则用记住的凭据；"记住密码"勾选态随配置与已存凭据
  const finalPrefill = {
    account: prefill.account !== undefined ? prefill.account : (savedCred ? savedCred.account : ''),
    password: prefill.password !== undefined ? prefill.password : (savedCred ? savedCred.password : ''),
  };
  const rememberPwOn = uiCfg.showRememberPassword === false
    ? false
    : (prefill.rememberPassword !== undefined ? prefill.rememberPassword
        : (state.rememberPassword || (state.rememberPassword === false && !!savedCred)
           || (uiCfg.rememberPasswordDefault === true && !savedCred)));
  // "记住登录状态"为手动选择项：只认配置默认值（false），不读取历史勾选态、不自动回填。
  const rememberLoginOn = uiCfg.rememberLoginDefault === true;
  authLayer.innerHTML = `
    <div class="auth-visual">
      <div class="brand--auth"><span class="brand__mark">${icon('i-sun')}</span>Sunshine个人工作站.</div>
      <div class="auth-visual__body">
        <div class="eyebrow" style="color:rgba(255,255,255,.8)">Sunshine Personal Workstation</div>
        <h1>让每一次努力<br>都充满阳光</h1>
        <p>为个人打造的安全、有趣、易用的在线工作站。</p>
        <div class="auth-feats">
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-book')}</span>覆盖各大平台实用工具</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-shield-check')}</span>手机号 + 邮箱双重验证保障安全</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-message')}</span>安全、有趣、易用便捷沟通</div>
        </div>
      </div>
      <div class="auth-visual__foot">© 2026 Sunshine个人工作站 · 安全、有趣、易用</div>
    </div>
    <div class="auth-form-wrap">
      <form class="auth-form" id="login-form">
        <div class="auth-form__head">
          <div class="eyebrow">欢迎回来</div>
          <h2>登录个人工作站</h2>
          <p>登录后即可开始</p>
        </div>
        ${message ? `<div class="auth-alert auth-alert--warn">${icon('i-info')}<span>${esc(message)}</span></div>` : ''}
        <div class="auth-alert auth-alert--warn">
          ${icon('i-info')}
          <span>为保障账号安全，<b>首次登录</b>须完成手机号与邮箱验证；验证后再次登录无需重复验证。</span>
        </div>
        <div class="field">
          <label class="field__label" for="login-account">邮箱 / 账号</label>
          <div class="input-group">${icon('i-user')}<input class="input" id="login-account" type="text" placeholder="例如 xiaoman@sunny.edu.cn" value="${esc(finalPrefill.account || '')}" autocomplete="username" /></div>
          <span class="field__error" id="err-account"></span>
        </div>
        <div class="field">
          <label class="field__label" for="login-password">密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="login-password" type="password" placeholder="初始密码 123456，可自行修改" value="${esc(finalPrefill.password || '')}" autocomplete="current-password" /></div>
          <span class="field__error" id="err-password"></span>
        </div>
        <div class="auth-form__row auth-form__row--checks">
          <label class="auth-check" title="不勾选时，刷新或重新打开页面都需要重新登录"><input type="checkbox" id="remember" ${rememberLoginOn ? 'checked' : ''} />记住登录状态</label>
          <label class="auth-check"><input type="checkbox" id="remember-password" ${rememberPwOn ? 'checked' : ''} />记住密码</label>
          <button type="button" class="link-btn" data-action="forgot-password">忘记密码？</button>
        </div>
        <button class="btn btn--primary btn--block" type="submit" style="margin-top:var(--s5)">登录Sunshine个人工作站 ${icon('i-arrow-right', 'icon--sm')}</button>
        <div class="auth-form__foot muted" style="font-size:var(--fs-sm);line-height:1.6">本平台不开放自助注册，账号由超级管理员统一创建与分配。</div>
        <div class="demo-hint">
          <b>账号密码登录：</b>使用超级管理员创建的账号与密码登录；初始密码 <b>123456</b>。<br>
          <b>忘记密码：</b>点击「忘记密码？」通过绑定邮箱验证码重置，验证码仅用于身份验证与密码重置。
        </div>
      </form>
    </div>`;
  $('#login-form').addEventListener('submit', handleLogin);
}

/* ==========================================================================
   云端登录（邮箱 OTP）—— 真实认证 + 云端数据持久化
   ========================================================================== */
/* ==========================================================================
   忘记密码（邮箱验证码仅用于身份验证，不用于登录）
   --------------------------------------------------------------------------
   流程：输入绑定邮箱 → 发送验证码 → 校验验证码 + 设置新密码 → 用新密码登录。
   云端账户：走 SDK resetPasswordForEmail().updateUser()；
   本地账户：演示验证码 123456，校验通过后由 API 层重置口令。
   ========================================================================== */
let resetPending = null; // { email, mode:'local'|'cloud', updateUser?, verificationId? }

const RESET_DEMO_CODE = '123456'; // 本地演示邮箱验证码（与绑定向导一致）

function renderForgotPassword(prefill = {}, message = '') {
  authLayer.classList.remove('hidden');
  $('#app').classList.add('hidden');
  authLayer.innerHTML = `
    <div class="auth-visual">
      <div class="brand--auth"><span class="brand__mark">${icon('i-sun')}</span>Sunshine个人工作站.</div>
      <div class="auth-visual__body">
        <div class="eyebrow" style="color:rgba(255,255,255,.8)">ACCOUNT RECOVERY</div>
        <h1>找回密码<br>安心继续学习</h1>
        <p>通过绑定邮箱的验证码验证身份，重置密码后即可用新密码登录。</p>
        <div class="auth-feats">
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-shield-check')}</span>邮箱验证码验证真实身份</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-lock')}</span>重置后使用新密码登录</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-info')}</span>验证码仅用于身份验证</div>
        </div>
      </div>
      <div class="auth-visual__foot">© 2026 Sunshine个人工作站 · 账户安全</div>
    </div>
    <div class="auth-form-wrap">
      <form class="auth-form" id="forgot-form">
        <div class="auth-form__head">
          <div class="eyebrow">账户安全</div>
          <h2>忘记密码</h2>
          <p>验证绑定邮箱后设置新密码</p>
        </div>
        ${message ? `<div class="auth-alert auth-alert--warn">${icon('i-info')}<span>${esc(message)}</span></div>` : ''}
        <div class="field">
          <label class="field__label" for="reset-email">绑定邮箱</label>
          <div class="input-group">${icon('i-mail')}<input class="input" id="reset-email" type="email" placeholder="name@example.com" value="${esc(prefill.email || '')}" autocomplete="email" /></div>
        </div>
        <div class="field">
          <label class="field__label" for="reset-code">邮箱验证码</label>
          <div class="input-group">${icon('i-key')}<input class="input" id="reset-code" type="text" placeholder="6 位验证码" maxlength="6" inputmode="numeric" /></div>
          <span class="field__hint" id="reset-code-hint" style="margin-top:6px">先点击「获取验证码」，查收邮件后填入</span>
        </div>
        <button class="btn btn--outline btn--block" type="button" id="send-reset-code" data-action="send-reset-code">获取验证码</button>
        <div class="field" style="margin-top:var(--s4)">
          <label class="field__label" for="reset-new">新密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="reset-new" type="password" placeholder="至少 ${((window.APP_CONFIG?.auth?.minLength)||6)} 位" autocomplete="new-password" /></div>
        </div>
        <div class="field">
          <label class="field__label" for="reset-confirm">确认新密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="reset-confirm" type="password" placeholder="再次输入新密码" autocomplete="new-password" /></div>
        </div>
        <span class="field__error" id="reset-err"></span>
        <button class="btn btn--primary btn--block" type="submit" style="margin-top:var(--s3)">重置密码并登录 ${icon('i-arrow-right', 'icon--sm')}</button>
        <div class="auth-form__foot"><button type="button" class="link-btn" data-action="back-demo-login">← 返回登录</button></div>
      </form>
    </div>`;
  $('#forgot-form').addEventListener('submit', handleResetPassword);
}

async function sendResetCode() {
  const email = ($('#reset-email')?.value || '').trim().toLowerCase();
  const err = $('#reset-err');
  if (err) err.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err && (err.textContent = '请输入有效的邮箱地址');

  // 本地账户：使用演示验证码，无需云端
  const localUser = (state.users || []).find(u => String(u.email || '').toLowerCase() === email);
  if (localUser) {
    if (localUser.status === 'disabled') return err && (err.textContent = '该账号已被禁用，请联系超级管理员');
    resetPending = { email, mode: 'local' };
    const hint = $('#reset-code-hint');
    if (hint) hint.innerHTML = `${icon('i-check','icon--sm')} 验证码已发送（演示验证码：<b style="color:var(--brand)">${RESET_DEMO_CODE}</b>）`;
    toast('验证码已发送，请查收邮件', 'success');
    startCodeCountdown('#send-reset-code', '#reset-code-hint', email, () => !!resetPending);
    return;
  }

  // 云端账户：白名单校验 + SDK 发送 PASSWORD_RESET 验证码
  const cloud = await window.cloudReady();
  if (!cloud) return err && (err.textContent = '云服务未就绪，请检查网络后刷新页面');
  try {
    const { data: allowed, error: allowErr } = await cloud.database
      .from('personnel').select('id,status').eq('email', email);
    if (allowErr) return err && (err.textContent = '账号校验失败：' + (allowErr.message || '云端异常'));
    if (!allowed || !allowed.length) return err && (err.textContent = '该邮箱未开通，请联系超级管理员创建账号');
    if (allowed.some(p => p.status === 'disabled')) return err && (err.textContent = '该账号已被禁用，请联系超级管理员');
  } catch (e) {
    return err && (err.textContent = '账号校验失败，请检查网络后重试');
  }
  const btn = $('#send-reset-code');
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  try {
    const sent = await cloud.auth.resetPasswordForEmail(email);
    if (sent && sent.error) { if (err) err.textContent = sent.error.message || '验证码发送失败'; return; }
    resetPending = { email, mode: 'cloud', updateUser: sent && sent.data && sent.data.updateUser };
    if (!resetPending.updateUser) return err && (err.textContent = '验证码发送失败，请重试');
    const hint = $('#reset-code-hint');
    if (hint) hint.innerHTML = `${icon('i-check','icon--sm')} 验证码已发送到 <b>${esc(email)}</b>，请查收邮件`;
    toast('验证码已发送，请查收邮件', 'success');
    startCodeCountdown('#send-reset-code', '#reset-code-hint', email, () => !!resetPending);
  } catch (e) {
    if (err) err.textContent = '发送失败，请稍后重试';
  } finally {
    if (btn && (!resetPending || ($('#reset-code-hint')?.textContent || '').includes('重发'))) {
      btn.disabled = false; btn.textContent = '获取验证码';
    }
  }
}

// 通用 60 秒重发倒计时
function startCodeCountdown(btnSel, hintSel, email, stillValid) {
  let seconds = 60;
  const timer = setInterval(() => {
    const b = $(btnSel);
    if (!b || !stillValid()) { clearInterval(timer); return; }
    if (seconds <= 0) { b.disabled = false; b.textContent = '重新获取验证码'; clearInterval(timer); }
    else { b.textContent = `${seconds}s 后重发`; seconds--; }
  }, 1000);
}

async function handleResetPassword(e) {
  e.preventDefault();
  const err = $('#reset-err');
  err.textContent = '';
  if (!resetPending) return err.textContent = '请先点击「获取验证码」验证身份';
  const code = ($('#reset-code')?.value || '').trim();
  const newPw = $('#reset-new')?.value || '';
  const confirm = $('#reset-confirm')?.value || '';
  if (!/^\d{6}$/.test(code)) return err.textContent = '请输入 6 位数字验证码';
  const minLen = (window.APP_CONFIG?.auth?.minLength) || 6;
  if (newPw.length < minLen) return err.textContent = `新密码至少 ${minLen} 位`;
  if (newPw !== confirm) return err.textContent = '两次输入的新密码不一致';

  const submit = e.target.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = '重置中…'; }
  try {
    if (resetPending.mode === 'cloud') {
      const res = await resetPending.updateUser({ nonce: code, password: newPw });
      if (res && res.error) {
        err.textContent = res.error.message || '验证码校验失败';
        if (submit) { submit.disabled = false; submit.textContent = '重置密码并登录'; }
        return;
      }
      const pending = resetPending;
      resetPending = null;
      const cloud = await window.cloudReady();
      const { data: session } = cloud ? await cloud.auth.getSession() : { data: null };
      if (session && session.user) {
        state.cloudMode = true;
        await cloudLoginSuccess(session.user);
        toast('密码已重置，请使用新密码登录', 'success');
        return;
      }
      renderLogin({ account: pending.email }, '密码已重置，请使用新密码登录');
      return;
    }
    // 本地账户：演示验证码校验
    if (code !== RESET_DEMO_CODE) {
      err.textContent = `验证码不正确（演示验证码为 ${RESET_DEMO_CODE}）`;
      if (submit) { submit.disabled = false; submit.textContent = '重置密码并登录'; }
      return;
    }
    const res = window.SunnyAPI.resetPasswordByEmail({ email: resetPending.email, newPassword: newPw, confirmPassword: confirm });
    if (!res.ok) {
      err.textContent = res.message;
      if (submit) { submit.disabled = false; submit.textContent = '重置密码并登录'; }
      return;
    }
    const email = resetPending.email;
    resetPending = null;
    // 重置成功后用新密码自动登录：取回账户并按新口令校验
    const user = (state.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if (user) {
      loginSuccess({ ...user });
      toast('密码已重置，已用新密码为你登录', 'success');
    } else {
      renderLogin({ account: email }, '密码已重置，请使用新密码登录');
    }
  } catch (ex) {
    err.textContent = '重置失败，请稍后重试';
    if (submit) { submit.disabled = false; submit.textContent = '重置密码并登录'; }
  }
}

async function cloudLoginSuccess(authUser) {
  const email = String(authUser.email || '').trim().toLowerCase();
  const uid = authUser.id;
  const nickname = authUser.name || email.split('@')[0] || '学员';
  const adminEmail = String(window.APP_CONFIG?.adminEmail || '').toLowerCase();

  // ① 白名单：人员表是唯一开户依据，未由超管创建的人员一律拒绝登录
  let person = null;
  try {
    const got = await window.cloud.database.from('personnel').select('*').eq('email', email);
    if (got.error) console.warn('[Sunshine个人工作站] 读取人员白名单失败', got.error.message);
    if (got.data && got.data.length) person = got.data[0];
  } catch (ex) {
    console.warn('[Sunshine个人工作站] 人员白名单异常', ex && ex.message);
  }
  const reject = async (msg) => {
    try { await window.cloud.auth.signOut(); } catch (_) {}
    state.cloudMode = false; state.authed = false;
    renderLogin({ account: email }, msg);
    return false;
  };
  if (!person) return await reject('该邮箱未开通，请联系超级管理员创建账号');
  if (person.status === 'disabled') return await reject('该账号已被禁用，请联系超级管理员');

  // ② 首次登录尽力绑定认证 uid（用于审计；绑定失败不影响登录）
  if (!person.owner_id) {
    try {
      await window.cloud.database.from('personnel')
        .update({ owner_id: uid, updated_at: new Date().toISOString() }).eq('id', person.id);
    } catch (ex) { console.warn('[Sunshine个人工作站] 绑定认证账号失败', ex && ex.message); }
  }

  // ③ 同步 profiles：保留资料表与历史提权触发器逻辑
  let profile = null;
  try {
    const got = await window.cloud.database.from('profiles').select('*').eq('owner_id', uid).maybeSingle();
    profile = got.data;
    if (got.error) console.warn('[Sunshine个人工作站] 读取资料失败', got.error.message);
    if (!profile) {
      const ins = await window.cloud.database.from('profiles').insert({
        display_name: person.display_name || nickname,
        email, grade: person.grade || 1,
        role: email === adminEmail ? 'admin' : (person.role || 'student'),
        avatar: person.avatar || nickname.slice(0, 1),
        color: person.color || 'avatar--sky',
      }).select();
      profile = ins.data && ins.data[0];
    } else {
      const patch = {};
      if (!String(profile.email || '').trim() && email) patch.email = email;
      if (email === adminEmail && profile.role !== 'admin') patch.role = 'admin';
      if (!profile.role && person.role) patch.role = person.role;
      if (Object.keys(patch).length) {
        const upd = await window.cloud.database.from('profiles').update(patch).eq('owner_id', uid).select();
        if (!upd.error) profile = (upd.data && upd.data[0]) || Object.assign(profile, patch);
        else console.warn('[Sunshine个人工作站] 资料补齐失败', upd.error.message);
      }
    }
  } catch (ex) {
    console.warn('[Sunshine个人工作站] 资料同步异常', ex && ex.message);
  }

  // ④ 账户角色以人员表为准；超管邮箱强制 admin
  const role = email === adminEmail ? 'admin' :
    (person.role || (profile?.is_admin ? 'admin' : (profile?.role || 'student')));
  const account = {
    id: person.id,          // 与人员管理列表 id 一致，便于删除自保护校验
    uid,
    name: person.display_name || profile?.display_name || nickname,
    email: person.email || email,
    phone: person.phone || profile?.phone || '',
    role,
    grade: person.grade || profile?.grade || 1,
    dept: person.dept || '',
    gender: person.gender || '',
    age: person.age || '',
    signature: person.signature || '',
    managedClasses: window.SunnyAPI.normalizeManagedClasses(safeParseArray(person.managed_classes)),
    presence: (window.SunnyAPI && window.SunnyAPI.normalizePresence ? window.SunnyAPI.normalizePresence(person.presence) : (person.presence || 'offline')),
    avatar: person.avatar || profile?.avatar || nickname.slice(0, 1),
    color: person.color || profile?.color || 'avatar--sky',
    verified: !!(person.email_verified || profile?.email_verified || authUser.email_verified),
    status: 'active',
    is_admin: role === 'admin',
  };
  // 登记为独立会话（重复登录同一云端账户则复用并切换）
  const sessRes = window.SunnyAPI && window.SunnyAPI.upsertSession
    ? window.SunnyAPI.upsertSession(account, { cloudMode: true }) : null;
  if (sessRes && !sessRes.ok) { toast(sessRes.message, 'error'); return false; }
  markSessionLoggedIn();     // 本次浏览器会话门闸：刷新保持，关浏览器需重登
  if (!sessRes) {
    state.account = account;
    state.authed = true;
    state.cloudMode = true;
    state.role = ['admin','teacher','headteacher','student','parent'].includes(role) ? role : (role || 'student');
  }
  // 云端模式下登录态由 SDK 维护，本地仅保存会话快照供切换展示
  authLayer.classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderShell();
  await loadRoleConfigs();
  if (role === 'admin') await refreshPersons();
  await loadCloudShares();
  syncDirectoryNow(); // 当前登录账户在线状态随会话生效
  navigate(state.view);
  if (typeof pullAllSync === 'function') pullAllSync(); // 云端登录后立即对齐手机/电脑数据
  pushSyncScope('account'); // 首次登录把本机账户资料/权限上传，供其它设备拉取
  if (typeof startShareRealtime === 'function') startShareRealtime();
  if (typeof startIdleWatcher === 'function') startIdleWatcher();
  if (typeof restartBackupTimer === 'function') restartBackupTimer();
  toast(`欢迎回来，${account.name}！已连接云端`);
  return true;
}

async function cloudLogout() {
  try { if (window.cloud) await window.cloud.auth.signOut(); } catch (e) {}
  // 仅关闭当前会话；若仍有其它在线账户则保持登录态并切换过去
  const res = window.SunnyAPI && window.SunnyAPI.closeSession
    ? window.SunnyAPI.closeSession(state.activeSessionId) : null;
  if (res && res.ok && res.data.next) {
    state.cloudMode = !!res.data.next.cloudMode;
    syncDirectoryNow();
    closeDropdowns();
    renderShell();
    navigate(state.view);
    persist();
    toast(`已退出云端账户，当前为 ${state.account.name}`, 'info');
    return;
  }
  state.cloudMode = false;
  state.authed = false;
  state.sessions = [];
  state.activeSessionId = null;
  state.account = { ...USERS[0] };
  syncDirectoryNow(); // 退出后当前账户在线状态回落
  renderLogin();
  toast('已退出云端登录', 'info');
}

function handleLogin(e) {
  e.preventDefault();
  const accountVal = $('#login-account').value.trim();
  const pw = $('#login-password').value;
  let ok = true;
  $('#err-account').textContent = ''; $('#err-password').textContent = '';
  if (!accountVal) { $('#err-account').textContent = '请输入邮箱或账号'; ok = false; }
  if (!pw) { $('#err-password').textContent = '请输入密码'; ok = false; }
  if (!ok) return;

  // 白名单校验：仅超级管理员创建的账户可登录，系统不支持自助注册 / 自动建号
  const found = state.users.find(u =>
    String(u.email || '').toLowerCase() === accountVal.toLowerCase() || u.name === accountVal);
  if (!found) {
    $('#err-account').textContent = '账号不存在或尚未开通，请联系超级管理员创建';
    return;
  }
  if (found.status === 'disabled') { $('#err-account').textContent = '该账户已被禁用，请联系超级管理员'; return; }
  // 口令校验（走统一接口层，兼容内置账户默认口令与管理员设置的初始口令）
  const res = window.SunnyAPI.verifyPassword({ userId: found.id, password: pw });
  if (!res.ok) { $('#err-account').textContent = res.message; return; }
  if (!res.data.valid) {
    const hintPw = (window.APP_CONFIG?.auth?.superAdmin?.password || window.APP_CONFIG?.auth?.defaultPassword || '123456');
    $('#err-password').textContent = `密码错误（初始密码为 ${hintPw}）`;
    return;
  }
  let user = { ...found };

  state.remember = !!$('#remember')?.checked;
  state.rememberPassword = !!$('#remember-password')?.checked;
  // 记住密码：勾选则保存凭据供下次回填，取消则清除，避免残留敏感信息
  if (state.rememberPassword) saveRememberedCredential(accountVal, pw);
  else clearRememberedCredential();
  // 邮箱验证策略由 APP_CONFIG.auth.emailVerifyOnce 控制：
  //   true（默认）= 未验证账户首次登录必须完成绑定向导；验证状态持久化后不再重复。
  //   false = 不强制验证，管理员分配的账户凭口令即可直接使用。
  const verifyOnce = window.APP_CONFIG?.auth?.emailVerifyOnce !== false;
  if (verifyOnce && !user.verified) {
    state.account = user;
    state.binding = { step: 0, phone: '', email: '' };
    renderBinding();
    toast('首次登录需完成手机号与邮箱验证', 'info');
  } else {
    // 关闭强制验证时，若账户仍未验证则就地补记为已验证，避免后台状态与登录态不一致
    if (!user.verified) {
      const resv = window.SunnyAPI && window.SunnyAPI.markEmailVerified
        ? window.SunnyAPI.markEmailVerified({ userId: user.id }) : null;
      if (resv && resv.ok) { user = { ...user, verified: true, emailVerifiedAt: resv.data.emailVerifiedAt }; }
    }
    loginSuccess(user);
  }
}

function loginSuccess(user) {
  // 登记为独立会话（重复登录同一账户则复用并切换）；工作副本由会话层装载
  const res = window.SunnyAPI && window.SunnyAPI.upsertSession
    ? window.SunnyAPI.upsertSession(user, { cloudMode: false }) : null;
  if (res && !res.ok) { toast(res.message, 'error'); return; }
  state.cloudMode = false;   // 演示登录走本地数据
  markSessionLoggedIn();     // 本次浏览器会话门闸：刷新保持，关浏览器需重登
  if (!res) {
    state.authed = true;
    state.account = user;
    state.role = ['admin','teacher','headteacher','student','parent'].includes(user.role) ? user.role : (user.role || 'student');
  }
  syncDirectoryNow(); // 当前登录账户在线状态随会话生效
  persist();
  // 复用统一入口：此前本地登录只渲染外壳，未启动实时同步/闲置监听/自动备份，
  // 导致改密后电脑端不会上传、手机端也不会拉取，是两端密码不一致的直接原因。
  showApp();
  toast((res && res.data && res.data.created) ? `${user.name}，欢迎加入在线会话！` : `欢迎回来，${user.name}！`);
}

/* ---------- 绑定向导（仅首次登录，账号由超级管理员创建） ---------- */
const BIND_STEPS = ['绑定手机', '短信验证', '绑定邮箱', '邮件验证', '完成'];

function renderBinding() {
  const b = state.binding;
  const step = b.step;
  authLayer.classList.remove('hidden');
  $('#app').classList.add('hidden');
  const stepsHTML = BIND_STEPS.map((label, i) => `
    <div class="step ${i === step ? 'is-active' : ''} ${i < step ? 'is-done' : ''}">
      <div class="step__num">${i < step ? icon('i-check','icon--sm') : i + 1}</div>
      <span class="step__label">${label}</span>
      ${i < BIND_STEPS.length - 1 ? '<div class="step__line"></div>' : ''}
    </div>`).join('');

  let body = '';
  if (step === 0) {
    body = `
      <div class="wizard__icon">${icon('i-phone','icon--xl')}</div>
      <h3>绑定手机号</h3><p>手机号用于账号安全验证与重要通知，请填写你常用的号码。</p>
      <div class="field"><label class="field__label">手机号码</label>
        <div class="input-group">${icon('i-phone')}<input class="input" id="bind-phone" type="tel" placeholder="请输入 11 位手机号" maxlength="11" value="${esc(b.phone)}" /></div>
        <span class="field__error" id="bind-err"></span></div>`;
  } else if (step === 1) {
    body = `
      <div class="wizard__icon">${icon('i-message','icon--xl')}</div>
      <h3>验证手机号</h3><p>我们已向 <b>${esc(b.phone)}</b> 发送了 6 位短信验证码。</p>
      <div class="field"><label class="field__label">短信验证码</label>
        <input class="input code-input" id="bind-code" type="text" placeholder="000000" maxlength="6" inputmode="numeric" />
        <span class="field__error" id="bind-err"></span>
        <span class="code-sent">${icon('i-check','icon--sm')} 验证码已发送 · <button class="link-btn" data-action="resend-code">重新发送</button></span>
        <span class="field__hint">演示验证码：<b style="color:var(--brand)">123456</b></span></div>`;
  } else if (step === 2) {
    body = `
      <div class="wizard__icon">${icon('i-mail','icon--xl')}</div>
      <h3>绑定邮箱</h3><p>邮箱用于找回密码与接收学习报告，请填写有效邮箱。</p>
      <div class="field"><label class="field__label">电子邮箱</label>
        <div class="input-group">${icon('i-mail')}<input class="input" id="bind-email" type="email" placeholder="name@example.com" value="${esc(b.email)}" /></div>
        <span class="field__error" id="bind-err"></span></div>`;
  } else if (step === 3) {
    body = `
      <div class="wizard__icon">${icon('i-mail','icon--xl')}</div>
      <h3>验证邮箱</h3><p>我们已向 <b>${esc(b.email)}</b> 发送了验证邮件，请输入邮件中的验证码。</p>
      <div class="field"><label class="field__label">邮件验证码</label>
        <input class="input code-input" id="bind-code" type="text" placeholder="000000" maxlength="6" inputmode="numeric" />
        <span class="field__error" id="bind-err"></span>
        <span class="code-sent">${icon('i-check','icon--sm')} 验证邮件已发送 · <button class="link-btn" data-action="resend-code">重新发送</button></span>
        <span class="field__hint">演示验证码：<b style="color:var(--brand)">123456</b></span></div>`;
  } else {
    body = `
      <div class="wizard__icon" style="background:var(--mint-soft);color:var(--mint)">${icon('i-shield-check','icon--xl')}</div>
      <h3>全部验证完成！</h3><p>你的账号已通过手机号与邮箱双重验证，现在可以安全登录了。</p>
      <div class="bind-summary">
        <div class="bind-summary__row">${icon('i-phone')}<div><strong>${esc(b.phone)}</strong><small>手机号 · 已验证</small></div>${icon('i-check','icon--sm')}</div>
        <div class="bind-summary__row">${icon('i-mail')}<div><strong>${esc(b.email)}</strong><small>邮箱 · 已验证</small></div>${icon('i-check','icon--sm')}</div>
      </div>`;
  }

  authLayer.innerHTML = `
    <div class="auth-visual">
      <div class="brand--auth"><span class="brand__mark">${icon('i-sun')}</span>Sunshine个人工作站.</div>
      <div class="auth-visual__body">
        <div class="eyebrow" style="color:rgba(255,255,255,.8)">账号安全</div>
        <h1>先完成验证<br>再开启学习</h1>
        <p>双重验证保护每一位同学的账号安全，只需几步即可完成。</p>
        <div class="auth-feats">
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-phone')}</span>验证手机号</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-mail')}</span>验证电子邮箱</div>
          <div class="auth-feat"><span class="auth-feat__ic">${icon('i-shield-check')}</span>安全登录平台</div>
        </div>
      </div>
      <div class="auth-visual__foot">© 2026 Sunshine个人工作站</div>
    </div>
    <div class="auth-form-wrap">
      <div class="wizard">
        <div class="wizard__head"><div class="eyebrow">第 ${Math.min(step + 1, 5)} / 5 步</div><h2>账户绑定与验证</h2></div>
        <div class="steps">${stepsHTML}</div>
        <div class="wizard__body">${body}</div>
        <div class="row" style="margin-top:var(--s6)">
          ${step > 0 && step < 4 ? `<button class="btn btn--ghost" data-action="bind-back">${icon('i-arrow-left','icon--sm')}上一步</button>` : ''}
          ${step < 3 ? `<button class="btn btn--primary grow" data-action="bind-next">下一步 ${icon('i-chevron-right','icon--sm')}</button>` : ''}
          ${step === 3 ? `<button class="btn btn--primary grow" data-action="bind-next">验证并进入平台 ${icon('i-check','icon--sm')}</button>` : ''}
          ${step === 4 ? `<button class="btn btn--primary btn--block" data-action="bind-finish">进入学习平台 ${icon('i-chevron-right','icon--sm')}</button>` : ''}
        </div>
      </div>
    </div>`;
  // 输入框回车推进
  const inp = $('#bind-phone') || $('#bind-email') || $('#bind-code');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') window.bindNext(); });
}

window.bindNext = function () {
  const b = state.binding, s = b.step;
  const setErr = (msg) => { const el = $('#bind-err'); if (el) el.textContent = msg; };
  if (s === 0) {
    const v = $('#bind-phone').value.trim();
    if (!/^1\d{10}$/.test(v)) return setErr('请输入有效的 11 位手机号');
    b.phone = v; b.step = 1;
  } else if (s === 1) {
    const v = $('#bind-code').value.trim();
    if (v !== '123456') return setErr('验证码不正确，演示验证码为 123456');
    b.step = 2;
  } else if (s === 2) {
    const v = $('#bind-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return setErr('请输入有效的邮箱地址');
    b.email = v; b.step = 3;
  } else if (s === 3) {
    const v = $('#bind-code').value.trim();
    if (v !== '123456') return setErr('验证码不正确，演示验证码为 123456');
    b.step = 4;
    state.account.phone = b.phone.slice(0,3) + '****' + b.phone.slice(-4);
    state.account.email = b.email;
    const idx = state.users.findIndex(u => u.id === state.account.id);
    if (idx >= 0) state.users[idx] = { ...state.users[idx], phone: state.account.phone, email: b.email };
    // 通过接口层持久化验证状态：本地立即生效，云端模式异步回写 personnel.email_verified
    const resv = window.SunnyAPI && window.SunnyAPI.markEmailVerified
      ? window.SunnyAPI.markEmailVerified({ userId: state.account.id }) : null;
    Promise.resolve(resv).then(r => {
      if (r && r.ok) {
        state.account.emailVerifiedAt = r.data.emailVerifiedAt;
        if (idx >= 0) state.users[idx].emailVerifiedAt = r.data.emailVerifiedAt;
        if (r.data.cloudSynced === false && state.cloudMode) {
          toast('验证状态已保存；云端同步待超管权限确认', 'info');
        }
      } else if (r && !r.ok) {
        toast(r.message || '验证状态保存失败', 'error');
      }
    });
    state.account.verified = true;
    state.account.emailVerifiedAt = state.account.emailVerifiedAt || new Date().toISOString();
  }
  renderBinding();
};

/* ==========================================================================
   应用外壳：导航 / 顶栏 / 通知 / 角色
   ========================================================================== */
function navItemsForRole() {
  // 每个主视图按门禁权限过滤：未授权的功能入口直接隐藏
  const all = [
    { view:'library', label:'学习资料', icon:'i-book', group:'学习空间' },
    { view:'shares', label:'学习感悟', icon:'i-heart', group:'学习空间' },
    { view:'directory', label:'内部通讯录', icon:'i-users', group:'学习空间', badge:1 },
    { view:'notices', label:'消息通知', icon:'i-bell', group:'学习空间' },
    { view:'schedule', label:'课程表', icon:'i-calendar', group:'学习空间' },
  ];
  const items = all.filter(i => canView(i.view));
  // 管理后台仅超级管理员可进入（角色权限不开放此入口）
  if (canView('admin')) {
    items.push({ view:'admin', label:'管理后台', icon:'i-shield', group:'管理中心' });
  }
  return items;
}

/* ---------- 多账户会话：UI 编排（登录/切换/在线状态/退出） ---------- */
function refreshAfterSessionChange(msg, type = 'success') {
  closeDropdowns();
  syncDirectoryNow();
  onUserComeOnline(); // 切换到该账户上线：补记离线活动事件
  // 权限重校验：先把无权限的视图改为有权限的首个视图，再渲染，避免残留上一个账户的内容
  if (!canView(state.view)) {
    const fallback = navItemsForRole()[0];
    state.view = fallback ? fallback.view : 'library';
  }
  // 年级范围重校验：切换到学生账户时清掉其无权限的年级筛选
  const scope = allowedGrades();
  if (scope !== 'all' && state.library.grade !== 'all' && scope.indexOf(Number(state.library.grade)) < 0) {
    state.library.grade = 'all';
  }
  renderShell();
  navigate(state.view);
  persist();
  if (msg) toast(msg, type);
}
function switchToSession(id) {
  if (id === state.activeSessionId) { closeDropdowns(); return; }
  const res = window.SunnyAPI && window.SunnyAPI.switchSession
    ? window.SunnyAPI.switchSession(id) : null;
  if (!res) return;
  if (!res.ok) {
    toast(res.message, 'error');
    // 失效会话被移除后，刷新列表并回退
    if (res.error && ['ACCOUNT_DISABLED', 'NO_ACCOUNT', 'SESSION_NOT_FOUND'].includes(res.error.code)) {
      const alive = (window.SunnyAPI.listSessions() || { ok:false, data:{} });
      if (!alive.ok || !alive.data.count) { logoutAllSessions(true); }
      else refreshAfterSessionChange('', '');
    }
    return;
  }
  refreshAfterSessionChange(res.message);
  if (res.data && res.data.warning) toast(res.data.warning, 'info');
}
function setSessionPresence(id, value) {
  const res = window.SunnyAPI && window.SunnyAPI.setSessionPresence
    ? window.SunnyAPI.setSessionPresence(id, value) : null;
  if (!res) return;
  if (!res.ok) { toast(res.message, 'error'); return; }
  syncDirectoryNow();
  renderSessionMenu();
  persist();
  toast(res.message);
}
function closeSessionById(id) {
  if (id === state.activeSessionId) { logoutCurrentSession(); return; }
  const res = window.SunnyAPI && window.SunnyAPI.closeSession
    ? window.SunnyAPI.closeSession(id) : null;
  if (!res) return;
  if (!res.ok) { toast(res.message, 'error'); return; }
  renderSessionMenu();
  persist();
  toast('已退出该账户', 'info');
}
function logoutCurrentSession() {
  const res = window.SunnyAPI && window.SunnyAPI.closeSession
    ? window.SunnyAPI.closeSession(state.activeSessionId) : null;
  if (res && res.ok && res.data.next) {
    state.cloudMode = !!res.data.next.cloudMode;
    refreshAfterSessionChange(`已退出，当前为 ${state.account.name}`, 'info');
    return;
  }
  // 无其它会话：完全退出
  if (state.cloudMode && window.cloud) { try { window.cloud.auth.signOut(); } catch (e) {} }
  state.authed = false; state.remember = false; state.role = 'student';
  state.cloudMode = false; state.sessions = []; state.activeSessionId = null;
  state.account = { ...USERS[0] };
  clearSessionGate();
  syncDirectoryNow();
  renderLogin();
  toast('已安全退出登录', 'info');
}
function logoutAllSessions(silent = false) {
  if (state.cloudMode && window.cloud) { try { window.cloud.auth.signOut(); } catch (e) {} }
  if (window.SunnyAPI && window.SunnyAPI.closeAllSessions) window.SunnyAPI.closeAllSessions();
  state.authed = false; state.remember = false; state.role = 'student';
  state.cloudMode = false; state.sessions = []; state.activeSessionId = null;
  state.account = { ...USERS[0] };
  clearSessionGate();
  syncDirectoryNow();
  persist();
  renderLogin();
  if (!silent) toast('已退出全部账户', 'info');
}

// 账户切换菜单（下拉内动态渲染）
function renderSessionMenu() {
  const host = $('#session-menu-list');
  if (!host) return;
  const listed = window.SunnyAPI && window.SunnyAPI.listSessions
    ? window.SunnyAPI.listSessions() : null;
  const sessions = (listed && listed.ok && listed.data.sessions) || [];
  host.innerHTML = sessions.length ? sessions.map(s => {
    const a = s.account || {};
    const roleLabel = (typeof roleViewOf === 'function' ? roleViewOf(a.role).label : (a.role || '成员'));
    const dot = s.presence === 'online' ? 'var(--mint)' : 'var(--warning)';
    return `<div class="session-item ${s.active ? 'is-active' : ''}">
      ${avatarHTML(a, 'avatar--sm')}
      <button class="session-item__main" data-action="session-switch" data-id="${esc(s.id)}">
        <strong>${esc(a.name || '成员')}${s.active ? ' · 当前' : ''}</strong>
        <small><span class="session-dot" style="background:${dot}"></span>${esc(roleLabel)} · ${s.presence === 'online' ? '在线' : '离开'} · ${s.cloudMode ? '云端' : '本地'}</small>
      </button>
      ${s.active ? `
        <button class="session-item__act" data-action="session-presence" data-id="${esc(s.id)}" data-value="${s.presence === 'online' ? 'away' : 'online'}" title="切换在线/离开">${icon(s.presence === 'online' ? 'i-toggle' : 'i-check','icon--sm')}</button>
      ` : `<button class="session-item__act" data-action="session-close" data-id="${esc(s.id)}" title="退出该账户">${icon('i-x','icon--sm')}</button>`}
    </div>`;
  }).join('') : '<div class="session-empty">暂无在线账户</div>';
  const cnt = $('#session-count');
  if (cnt) cnt.textContent = String(sessions.length || 1);
}

function renderShell() {
  // 顶栏账户信息
  const u = state.account;
  $('#topbar-avatar').textContent = u.avatar || u.name[0];
  $('#topbar-name').textContent = u.name;
  const roleText = (typeof roleViewOf === 'function' ? roleViewOf(u.role).label : u.role)
    || (u.role === 'teacher' ? (u.dept || '教师') : `${gradeLabel(u.grade || 1)} · 学生`);
  $('#topbar-role').textContent = state.cloudStale ? `${roleText} · 云端待验证` : roleText;
  $('#menu-avatar').textContent = u.avatar || u.name[0];
  $('#menu-name').textContent = u.name;
  $('#menu-email').textContent = u.email;
  // 侧栏提示（自定义角色回退到通用提示，避免 tips[role] 为 undefined 崩溃）
  const tips = {
    student: ['每天进步一点点', '今天也要元气满满哦！'],
    teacher: ['教学相长', '用知识点亮每个孩子。'],
    admin: ['管理也需要温度', '你的决策影响整个学堂。'],
    parent: ['陪伴是最好的教育', '和孩子一起发现学习的乐趣。'],
  };
  const tip = tips[state.role] || ['学无止境', '每次学习都是一点进步。'];
  $('#sidebar-tip-title').textContent = tip[0];
  $('#sidebar-tip-text').textContent = tip[1];
  renderNav();
  renderNotifications();
  renderSessionMenu();
}

function renderNav() {
  const items = navItemsForRole();
  const groups = [...new Set(items.map(i => i.group))];
  // 实用工具：独立页面入口，不占用主视图/门禁系统，保持现有页面结构不变
  const toolsGroup = `
    <div class="nav__label">实用工具</div>
    <button class="nav__item" data-action="open-image-to-doc" title="图片转文档（在新页面打开）">
      ${icon('i-file')}<span>图片转文档</span>
    </button>
    <button class="nav__item" data-action="open-text-to-doc" title="文字转文档（在新页面打开）">
      ${icon('i-edit')}<span>文字转文档</span>
    </button>`;
  $('#main-nav').innerHTML = groups.map(g => `
    <div class="nav__label">${g}</div>
    ${items.filter(i => i.group === g).map(i => `
      <button class="nav__item ${state.view === i.view ? 'is-active' : ''}" data-action="navigate" data-view="${i.view}">
        ${icon(i.icon)}<span>${i.label}</span>${i.badge ? `<span class="badge">${i.badge}</span>` : ''}
      </button>`).join('')}
  `).join('') + toolsGroup;
}

function navigate(view) {
  if (view === 'admin' && state.role !== 'admin') {
    toast('管理后台仅超级管理员可访问', 'error');
    return;
  }
  // 视图门禁：即使绕过菜单直接调用（如伪造 data-view），未授权也让访问被拦截
  if (!canView(view)) {
    const perm = viewRequiredPerm(view);
    const def = state.permissions.find(p => p.key === perm);
    toast(`当前账号未授权访问该功能${def ? `（需「${def.name}」权限）` : ''}`, 'error');
    // 回退到第一个有权限的视图，避免停留在无内容的空页
    const fallback = navItemsForRole()[0];
    if (fallback && fallback.view !== view) { view = fallback.view; }
    else return;
  }
  if (view !== 'admin') stopMonitorTimer();
  // 离开通讯录时收起手机端全屏聊天，避免残留遮住其它页面
  if (view !== 'directory' && state.directory.chatFullscreen) {
    state.directory.chatFullscreen = false;
    const fsRoot = $('#chat-fullscreen-root'); if (fsRoot) fsRoot.innerHTML = '';
  }
  state.view = view;
  document.title = `${({ library:'学习资料', shares:'学习感悟', directory:'内部通讯录', notices:'消息通知', schedule:'课程表', admin:'管理后台' })[view] || '学习平台'} · Sunshine个人工作站`;
  renderNav();
  closeDropdowns();
  $('#sidebar').classList.remove('is-open');
  $('#scrim').classList.add('hidden');
  const main = $('#main');
  main.innerHTML = '';
  if (view === 'library') renderLibrary(main);
  else if (view === 'shares') {
    renderShares(main);
    if (state.cloudMode) loadCloudShares(); // 云端模式进入时刷新最新感悟
  }
  else if (view === 'directory') renderDirectory(main);
  else if (view === 'notices') renderNotices(main);
  else if (view === 'schedule') renderSchedule(main);
  else if (view === 'admin') renderAdmin(main);
  main.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function closeDropdowns() {
  $('#usermenu')?.classList.add('hidden');
  $('#notify-panel')?.classList.add('hidden');
  $('#session-menu')?.classList.add('hidden');
  $('[data-action="toggle-usermenu"]')?.setAttribute('aria-expanded', 'false');
  $('[data-action="toggle-notifications"]')?.setAttribute('aria-expanded', 'false');
  $('[data-action="session-toggle-menu"]')?.setAttribute('aria-expanded', 'false');
}

function toggleDropdown(id) {
  const el = $(id);
  const willShow = el.classList.contains('hidden');
  closeDropdowns();
  if (willShow) {
    el.classList.remove('hidden');
    const triggerMap = {
      '#usermenu': '[data-action="toggle-usermenu"]',
      '#notify-panel': '[data-action="toggle-notifications"]',
      '#session-menu': '[data-action="session-toggle-menu"]',
    };
    $(triggerMap[id])?.setAttribute('aria-expanded', 'true');
    if (id === '#session-menu') renderSessionMenu();
  }
}

function renderNotifications() {
  const list = $('#notify-list');
  const unread = state.notifications.filter(n => !n.read).length;
  const badge = $('#notify-badge');
  if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  list.innerHTML = state.notifications.length ? state.notifications.map(n => `
    <div class="notify-item ${n.read ? '' : 'is-unread'}" data-action="read-notification" data-id="${n.id}">
      <span class="notify-item__ic">${icon(n.icon)}</span>
      <div class="notify-item__body"><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p><time>${esc(n.time)}</time></div>
    </div>`).join('') : `<div class="empty" style="padding:var(--s7)"><p>暂无消息通知</p></div>`;
}

/* ==========================================================================
   模块一：学习资料
   ========================================================================== */
// 当前账户可见的年级集合：'all' 或年级数组；用于资料筛选条与感悟发布
function allowedGrades() {
  return window.SunnyAPI.gradeScopeFor(state.account);
}

function filteredMaterials() {
  const f = state.library;
  const scope = allowedGrades();
  return state.materials.filter(m => {
    // 学生按年级权限隔离：无权限年级的资料不展示（无年级资料默认可见）
    if (scope !== 'all' && !(m.grade === undefined || m.grade === null || scope.indexOf(Number(m.grade)) >= 0)) return false;
    if (f.grade !== 'all' && m.grade !== Number(f.grade)) return false;
    if (f.subject !== 'all' && m.subject !== f.subject) return false;
    if (f.query) {
      const q = f.query.toLowerCase();
      const hay = `${m.title} ${m.desc} ${(SUBJECTS[m.subject] || SUBJECTS.chinese).name} ${(m.points || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ---------- 已添加学习栏目 ---------- */
// 依据学习清单顺序取出仍存在的资料，去重，避免已删除资料残留
function addedLearningMaterials() {
  const seen = new Set();
  const out = [];
  (state.learning || []).forEach(entry => {
    const id = String(entry && entry.id ? entry.id : entry);
    if (seen.has(id)) return;
    const m = state.materials.find(x => String(x.id) === id);
    if (!m) return;
    seen.add(id);
    out.push(m);
  });
  return out;
}
// 按学科分组渲染资料条目，每条展示名称与年级/类型/时长等状态信息
function learningPanelHTML() {
  const list = addedLearningMaterials();
  if (!list.length) {
    return `<div class="learn-empty">
      <div class="learn-empty__art">${icon('i-book-open','icon--xl')}</div>
      <h3>还没有添加学习资料</h3>
      <p>打开资料并点击「开始学习」，就会收进这里。</p>
    </div>`;
  }
  return Object.entries(SUBJECTS).map(([key, s]) => {
    const items = list.filter(m => m.subject === key);
    if (!items.length) return '';
    return `<section class="learn-group">
      <div class="learn-group__head">
        <span class="chip__dot" style="background:${s.color}"></span>
        <strong>${s.name}</strong>
        <small>${items.length} 份</small>
      </div>
      <div class="learn-group__list">
        ${items.map(m => `
          <button class="learn-item" data-action="open-material" data-id="${esc(m.id)}" aria-label="查看 ${esc(m.title)} 详情">
            <span class="learn-item__ic" style="background:${s.soft};color:${s.color}">${icon(s.icon,'icon--sm')}</span>
            <span class="learn-item__body">
              <span class="learn-item__title">${esc(m.title)}</span>
              <span class="learn-item__meta">${gradeLabel(m.grade)} · ${esc(m.type)} · ${m.minutes} 分钟</span>
            </span>
            <span class="learn-item__status"><span class="learn-item__dot"></span>已添加</span>
          </button>`).join('')}
      </div>
    </section>`;
  }).join('');
}
// 判断资料是否已在当前会话的学习清单中
function isLearning(id) {
  const key = String(id);
  return (state.learning || []).some(x => String(x && x.id ? x.id : x) === key);
}
// 加入学习清单：去重、置顶、持久化并刷新左栏
function addToLearning(id) {
  if (!state.learning) state.learning = [];
  const key = String(id);
  if (!state.materials.some(m => String(m.id) === key)) return false;
  const existed = state.learning.some(x => String(x && x.id ? x.id : x) === key);
  state.learning = state.learning.filter(x => String(x && x.id ? x.id : x) !== key);
  state.learning.unshift({ id: key, addedAt: new Date().toISOString() });
  persist();
  refreshLearningPanel();
  return !existed;
}
// 从学习清单移除
function removeFromLearning(id) {
  if (!state.learning) return false;
  const key = String(id);
  const before = state.learning.length;
  state.learning = state.learning.filter(x => String(x && x.id ? x.id : x) !== key);
  if (state.learning.length === before) return false;
  persist();
  refreshLearningPanel();
  return true;
}
// 仅重绘左栏内容，保留右侧筛选与滚动状态
function refreshLearningPanel() {
  const box = $('#learning-list');
  if (!box) return;
  const n = addedLearningMaterials().length;
  const count = $('#learning-count');
  if (count) {
    count.textContent = n;
    count.classList.toggle('hidden', n === 0);
  }
  box.innerHTML = learningPanelHTML();
}

function renderLibrary(main) {
  const gradeScope = allowedGrades();
  const gradeChips = (gradeScope === 'all' ? GRADES : GRADES.filter(g => gradeScope.indexOf(g) >= 0))
    .map(g => `<button class="chip ${state.library.grade == g ? 'is-active' : ''}" data-action="filter-grade" data-grade="${g}">${gradeLabel(g)}</button>`).join('');
  main.innerHTML = `
    <div class="page">
      <section class="hero">
        <div class="hero__body">
          <div class="eyebrow" style="color:var(--sun)">SUNNY CLASSROOM · 学习资料库</div>
          <h1>你好，${esc(state.account.name)}！<br><em>今天想学点什么？</em></h1>
          <p>精选 1–6 年级全学科优质学习资源，按年级和科目轻松筛选，让每一次探索都有收获。</p>
        </div>
        <div class="hero__art">
          <div class="hero__emoji" style="background:linear-gradient(145deg,var(--sky),#8CC7E9)">${icon('i-book-open','icon--xl')}</div>
          <div class="hero__emoji" style="background:linear-gradient(145deg,var(--sun),#F3C46A)">${icon('i-sparkles','icon--xl')}</div>
          <div class="hero__emoji" style="background:linear-gradient(145deg,var(--mint),#6CCBA7)">${icon('i-graduation','icon--xl')}</div>
        </div>
      </section>

      <section class="tool-entry card" aria-label="实用工具">
        <div class="tool-entry__ic">${icon('i-file','icon--xl')}</div>
        <div class="tool-entry__body">
          <h3>图片转文档 <span class="tool-entry__tag">所有成员可用</span></h3>
          <p>把多张图片排版生成 Word / PDF，可保存到电脑或手机本地，也支持系统分享。</p>
        </div>
        <button class="btn btn--soft tool-entry__btn" data-action="open-image-to-doc">${icon('i-arrow-right','icon--sm')} 立即使用</button>
      </section>

      <section class="tool-entry card tool-entry--text" aria-label="实用工具">
        <div class="tool-entry__ic">${icon('i-edit','icon--xl')}</div>
        <div class="tool-entry__body">
          <h3>文字转文档 <span class="tool-entry__tag">所有成员可用</span></h3>
          <p>输入或粘贴文字即可排版生成 Word / PDF，字号、行距与页边距可调，同样支持保存本地与系统分享。</p>
        </div>
        <button class="btn btn--soft tool-entry__btn" data-action="open-text-to-doc">${icon('i-arrow-right','icon--sm')} 立即使用</button>
      </section>

      <div class="learn-layout">
        <aside class="learn-side" aria-label="已添加学习">
          <div class="learn-panel card">
            <div class="learn-panel__head">
              <h3>${icon('i-book-open','icon--sm')} 已添加学习</h3>
              <span class="learn-panel__count hidden" id="learning-count">0</span>
            </div>
            <div id="learning-list"></div>
          </div>
        </aside>

        <div class="learn-main">
          <div class="filterbar">
            <div class="filterbar__group">
              <span class="filterbar__label">年级</span>
              <button class="chip ${state.library.grade === 'all' ? 'is-active' : ''}" data-action="filter-grade" data-grade="all">全部</button>
              ${gradeChips}
            </div>
            <div class="filterbar__sep"></div>
            <div class="filterbar__group">
              <span class="filterbar__label">科目</span>
              <button class="chip ${state.library.subject === 'all' ? 'is-active' : ''}" data-action="filter-subject" data-subject="all">全部</button>
              ${Object.entries(SUBJECTS).map(([k,s]) => `<button class="chip ${state.library.subject === k ? 'is-active' : ''}" data-action="filter-subject" data-subject="${k}"><span class="chip__dot" style="background:${s.color}"></span>${s.name}</button>`).join('')}
            </div>
            <div class="filterbar__spacer"></div>
            <div class="seg">
              <button class="seg__btn ${state.library.mode === 'grid' ? 'is-active' : ''}" data-action="set-mode" data-mode="grid" aria-label="网格视图">${icon('i-grid','icon--sm')}</button>
              <button class="seg__btn ${state.library.mode === 'list' ? 'is-active' : ''}" data-action="set-mode" data-mode="list" aria-label="列表视图">${icon('i-file','icon--sm')}</button>
            </div>
            ${canPublish() ? `<button class="btn btn--soft btn--sm" data-action="publish-material">${icon('i-plus','icon--sm')} 发布资料</button>` : ''}
          </div>

          <div class="result-meta">
            <h2>为你找到 <span id="result-count">—</span> 份资料</h2>
            <small id="result-desc"></small>
          </div>
          <div id="material-area"></div>
        </div>
      </div>
    </div>`;
  refreshLearningPanel();
  refreshMaterials(true);
}

let loadTimer = null;
function refreshMaterials(animate = false) {
  const area = $('#material-area');
  if (!area) return;
  // 计数与筛选描述即时更新，骨架屏期间也展示真实结果规模
  const f = state.library;
  $('#result-count').textContent = filteredMaterials().length;
  $('#result-desc').textContent = [
    f.grade !== 'all' ? gradeLabel(Number(f.grade)) : '全部年级',
    f.subject !== 'all' ? SUBJECTS[f.subject].name : '全部科目',
    f.query ? `关键词「${f.query}」` : '',
  ].filter(Boolean).join(' · ');
  const render = () => {
    const list = filteredMaterials();
    if (!list.length) {
      area.innerHTML = `<div class="empty card"><div class="empty__art">${icon('i-search','icon--xl')}</div><h3>没有找到相关资料</h3><p>换个年级、科目或关键词试试看吧。</p><button class="btn btn--soft" data-action="clear-filters">清除筛选条件</button></div>`;
      return;
    }
    area.innerHTML = `<div class="material-grid ${f.mode === 'list' ? 'is-list' : ''}">
      ${list.map(m => materialCard(m)).join('')}
    </div>`;
  };
  if (loadTimer) clearTimeout(loadTimer);
  if (animate) {
    area.innerHTML = `<div class="material-grid">${Array.from({length:8}).map(() => `
      <div class="card" style="overflow:hidden"><div class="skeleton" style="height:130px;border-radius:0"></div><div style="padding:16px"><div class="skeleton" style="height:12px;width:40%;margin-bottom:10px"></div><div class="skeleton" style="height:18px;width:80%;margin-bottom:10px"></div><div class="skeleton" style="height:12px;width:100%"></div></div></div>`).join('')}</div>`;
    loadTimer = setTimeout(render, 420);
  } else render();
}

function materialCard(m) {
  const s = SUBJECTS[m.subject];
  return `
    <article class="material-card" data-action="open-material" data-id="${m.id}" tabindex="0" role="button" aria-label="查看 ${esc(m.title)} 详情">
      <div class="material-card__cover" style="background:linear-gradient(145deg,${s.color},${s.soft})">
        <span class="material-card__grade">${gradeLabel(m.grade)}</span>
        <span class="material-card__type">${esc(m.type)}</span>
        ${icon(s.icon)}
      </div>
      <div class="material-card__body">
        <span class="material-card__subj" style="color:${s.color}">${s.name}</span>
        <h3 class="material-card__title">${esc(m.title)}</h3>
        <p class="material-card__desc">${esc(m.desc)}</p>
        <div class="material-card__meta">
          <span>${icon('i-clock')} ${m.minutes} 分钟</span>
          <span>${icon('i-file')} ${m.chapters.length} 章</span>
          <span class="material-card__rating">${icon('i-star')} ${m.rating}</span>
        </div>
      </div>
    </article>`;
}

let currentDrawerMaterialId = null;
function openMaterial(id) {
  const m = state.materials.find(x => x.id === id);
  if (!m) return;
  currentDrawerMaterialId = m.id;
  const s = SUBJECTS[m.subject];
  const root = $('#drawer-root');
  root.innerHTML = `
    <div class="drawer-mask" data-action="close-drawer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(m.title)}详情">
      <div class="drawer__cover" style="background:linear-gradient(145deg,${s.color},${s.soft})">
        ${icon(s.icon)}
        <button class="drawer__close" data-action="close-drawer" aria-label="关闭">${icon('i-x')}</button>
      </div>
      <div class="drawer__body">
        <div class="drawer__tags">
          <span class="tag" style="background:${s.soft};color:${s.color}">${s.name}</span>
          <span class="tag" style="background:var(--surface-3);color:var(--ink-2)">${gradeLabel(m.grade)}</span>
          <span class="tag" style="background:var(--sun-soft);color:#96701C">${icon('i-star','icon--sm')} ${m.rating}</span>
        </div>
        <h2>${esc(m.title)}</h2>
        <p class="muted">${esc(m.desc)}</p>
        <div class="detail-section" style="margin-top:var(--s6)">
          <h4>${icon('i-sparkles')}你将学到</h4>
          <ul class="detail-list">${m.points.map(p => `<li>${icon('i-check','icon--sm')}<span>${esc(p)}</span></li>`).join('')}</ul>
        </div>
        <div class="detail-section">
          <h4>${icon('i-file')}课程目录 · 共 ${m.chapters.length} 节</h4>
          <div class="chapter-list">${m.chapters.map((c,i) => `<div class="chapter"><strong>${esc(c)}</strong><small>约 ${Math.max(1, Math.round(m.minutes / m.chapters.length))} 分钟</small></div>`).join('')}</div>
        </div>
        <div class="detail-section">
          <h4>${icon('i-info')}资料信息</h4>
          <div class="info-row"><span>适用年级</span><strong>${gradeLabel(m.grade)}</strong></div>
          <div class="info-row"><span>所属学科</span><strong>${s.name}</strong></div>
          <div class="info-row"><span>资料类型</span><strong>${esc(m.type)}</strong></div>
          <div class="info-row"><span>总时长</span><strong>约 ${m.minutes} 分钟</strong></div>
        </div>
      </div>
      <div class="drawer__footer">
        ${isLearning(m.id)
          ? `<button class="btn btn--soft" data-action="remove-learning" data-id="${m.id}">${icon('i-check','icon--sm')} 已添加 · 移出</button>
             <button class="btn btn--primary grow" data-action="start-learning" data-id="${m.id}">${icon('i-play','icon--sm')} 继续学习</button>`
          : `<button class="btn btn--ghost" data-action="close-drawer">关闭</button>
             <button class="btn btn--primary grow" data-action="start-learning" data-id="${m.id}">${icon('i-play','icon--sm')} 开始学习</button>`}
      </div>
    </aside>`;
  focusFirst(root);
}
function closeDrawer() {
  $('#drawer-root').innerHTML = '';
  currentDrawerMaterialId = null;
  if (lastFocusedEl && document.contains(lastFocusedEl)) lastFocusedEl.focus();
  lastFocusedEl = null;
}

/* ---------- 资料发布（教师 / 超管） ---------- */
function openMaterialForm() {
  openModal({
    title: '发布学习资料',
    body: `
      <div class="field"><label class="field__label" for="mat-title">资料标题</label><input class="input" id="mat-title" placeholder="例如：拼音拼读练习" /></div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="mat-grade">适用年级</label><select class="select" id="mat-grade">${GRADES.map(g => `<option value="${g}" ${state.account.grade === g ? 'selected' : ''}>${gradeLabel(g)}</option>`).join('')}</select></div>
        <div class="field grow"><label class="field__label" for="mat-subject">所属学科</label><select class="select" id="mat-subject">${Object.entries(SUBJECTS).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('')}</select></div>
      </div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="mat-type">资料类型</label><input class="input" id="mat-type" value="互动课" placeholder="互动课 / 练习册 / 科普视频" /></div>
        <div class="field grow"><label class="field__label" for="mat-minutes">时长（分钟）</label><input class="input" id="mat-minutes" type="number" min="1" max="180" value="20" /></div>
      </div>
      <div class="field"><label class="field__label" for="mat-desc">简介</label><textarea class="textarea" id="mat-desc" rows="3" placeholder="用一句话介绍这份资料…"></textarea></div>
      <span class="field__error" id="mat-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="submit-material">发布资料</button>`,
  });
}

async function submitMaterial() {
  const err = $('#mat-err');
  if (err) err.textContent = '';
  const payload = {
    title: $('#mat-title')?.value,
    desc: $('#mat-desc')?.value,
    type: $('#mat-type')?.value || '互动课',
    minutes: $('#mat-minutes')?.value,
    grade: $('#mat-grade')?.value,
    subject: $('#mat-subject')?.value,
    points: ($('#mat-points')?.value || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean),
    chapters: ($('#mat-chapters')?.value || '').split(/[,，\n]/).map(s => s.trim()).filter(Boolean),
  };
  const res = await window.SunnyAPI.createMaterial(payload);
  if (!res.ok) { if (err) err.textContent = res.message; return; }
  if (state.cloudMode) await loadCloudMaterials();
  state.library.query = '';
  const gs = $('#global-search');
  if (gs) gs.value = '';
  closeModal();
  if (state.view !== 'library') navigate('library');
  else refreshLibraryFilterUI();
  toast(res.message);
}

/* ---------- 资料编辑 / 删除（走统一接口层，供管理后台调用） ---------- */
function materialFormModal(material) {
  const isEdit = !!material;
  openModal({
    title: isEdit ? `编辑资料 · ${material.title}` : '新建学习资料',
    body: `
      <div class="field"><label class="field__label" for="mm-title">资料标题</label><input class="input" id="mm-title" value="${esc(material?.title||'')}" placeholder="请输入资料标题" /></div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="mm-grade">适用年级</label><select class="select" id="mm-grade">${GRADES.map(g => `<option value="${g}" ${Number(material?.grade)===g?'selected':''}>${gradeLabel(g)}</option>`).join('')}</select></div>
        <div class="field grow"><label class="field__label" for="mm-subject">所属学科</label><select class="select" id="mm-subject">${Object.entries(SUBJECTS).map(([k,s]) => `<option value="${k}" ${material?.subject===k?'selected':''}>${s.name}</option>`).join('')}</select></div>
      </div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="mm-type">资料类型</label><input class="input" id="mm-type" value="${esc(material?.type||'互动课')}" placeholder="互动课 / 练习册" /></div>
        <div class="field grow"><label class="field__label" for="mm-minutes">时长（分钟）</label><input class="input" id="mm-minutes" type="number" min="1" max="300" value="${material?.minutes||20}" /></div>
      </div>
      <div class="field"><label class="field__label" for="mm-desc">简介</label><textarea class="textarea" id="mm-desc" rows="2" placeholder="一句话介绍这份资料">${esc(material?.desc||'')}</textarea></div>
      <div class="field"><label class="field__label" for="mm-points">知识点（逗号或换行分隔）</label><input class="input" id="mm-points" value="${esc((material?.points||[]).join('，'))}" placeholder="拼音拼读，声调练习" /></div>
      <div class="field"><label class="field__label" for="mm-chapters">章节（逗号或换行分隔）</label><input class="input" id="mm-chapters" value="${esc((material?.chapters||[]).join('，'))}" placeholder="认识声母，拼读练习" /></div>
      <span class="field__error" id="mm-err"></span>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="save-material" data-id="${material?.id||''}">${isEdit?'保存修改':'创建资料'}</button>`,
  });
}

async function saveMaterial(id) {
  const err = $('#mm-err');
  if (err) err.textContent = '';
  const payload = {
    title: $('#mm-title')?.value, desc: $('#mm-desc')?.value,
    type: $('#mm-type')?.value || '互动课', minutes: $('#mm-minutes')?.value,
    grade: $('#mm-grade')?.value, subject: $('#mm-subject')?.value,
    points: ($('#mm-points')?.value||'').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),
    chapters: ($('#mm-chapters')?.value||'').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),
  };
  const res = id ? await window.SunnyAPI.updateMaterial(id, payload) : await window.SunnyAPI.createMaterial(payload);
  if (!res.ok) { if (err) err.textContent = res.message; return; }
  if (state.cloudMode) await loadCloudMaterials();
  closeModal();
  renderAdmin($('#main'));
  toast(res.message);
}

function deleteMaterial(id) {
  const m = state.materials.find(x => String(x.id) === String(id));
  if (!m) return;
  openModal({
    title:'确认删除资料',
    body:`<p>确定要删除资料 <b>${esc(m.title)}</b> 吗？此操作不可撤销。</p>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--danger" data-action="confirm-delete-material" data-id="${esc(m.id)}">确认删除</button>`,
  });
}

/* ==========================================================================
   模块二：学习感悟分享
   ========================================================================== */
function shareCard(s) {
  const me = state.account;
  const liked = (s.like_by || []).some(uid => String(uid) === String(me.id));
  const subj = SUBJECTS[s.subject] || SUBJECTS.chinese;
  const groups = window.SunnyAPI.groupComments(s.comments);
  const total = groups.student.length + groups.teacher.length + groups.group.length;
  const canComment = (window.SunnyAPI.commentKindsFor(me.role) || []).length > 0;
  return `
    <article class="share-card card">
      <div class="share-card__head">
        ${avatarHTML({ avatar: s.avatar, name: s.owner_name, color: s.color })}
        <div class="share-card__meta">
          <strong>${esc(s.owner_name)}</strong>
          <small>${esc(s.created_at)} · ${gradeLabel(s.grade)} · ${esc(subj.name)}</small>
        </div>
        <span class="tag" style="background:${subj.soft};color:${subj.color}">${esc(subj.name)}</span>
      </div>
      <h3 class="share-card__title">${esc(s.title)}</h3>
      <p class="share-card__content">${esc(s.content)}</p>
      <div class="share-card__foot">
        <button class="btn btn--ghost btn--sm ${liked ? 'is-liked' : ''}" data-action="toggle-like" data-id="${esc(s.id)}">
          ${icon('i-heart', 'icon--sm')} ${liked ? '已点赞' : '点赞'} ${s.likes || 0}
        </button>
        <button class="btn btn--ghost btn--sm" data-action="open-comment-form" data-id="${esc(s.id)}" ${canComment ? '' : 'disabled'}>
          ${icon('i-message', 'icon--sm')} 评论 ${total ? `(${total})` : ''}
        </button>
        <span class="muted" style="font-size:var(--fs-xs)">${(s.like_by || []).length} 人喜欢</span>
      </div>
      ${total ? `<div class="share-comments">
        ${[
          ['student', groups.student],
          ['teacher', groups.teacher],
          ['group', groups.group],
        ].filter(([, list]) => list.length).map(([kind, list]) => `
          <div class="share-comments__group share-comments__group--${kind}">
            <div class="share-comments__label">${icon('i-message','icon--sm')} ${window.SunnyAPI.COMMENT_LABELS[kind]} <span>${list.length}</span></div>
            ${list.map(c => `
              <div class="share-comment">
                <span class="avatar avatar--sm ${c.color}">${esc(c.avatar)}</span>
                <div class="share-comment__body">
                  <div class="share-comment__meta"><strong>${esc(c.owner_name)}</strong><small>${esc(c.created_at)}</small></div>
                  <p>${esc(c.content)}</p>
                </div>
              </div>`).join('')}
          </div>`).join('')}
      </div>` : ''}
      ${canDeleteShare(s) ? `<div class="share-card__tools"><button class="btn btn--ghost btn--sm" data-action="delete-share" data-id="${esc(s.id)}" title="删除这条感悟" aria-label="删除这条感悟">${icon('i-trash', 'icon--sm')} 删除</button></div>` : ''}
    </article>`;
}

// 删除权限：本人发布或超管可删除；其余成员不可见删除入口
function canDeleteShare(s) {
  const me = state.account || {};
  if (me.role === 'admin' || me.is_admin === true) return true;
  return String(s && s.owner_id) === String(me.id);
}

// 学生按年级可见的感悟：非授权年级的感悟不展示（通用/无年级感悟始终可见）
function visibleShares() {
  const list = window.SunnyAPI.filterByGradeScope(state.shares, state.account, 'grade');
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function renderShares(main) {
  const sorted = visibleShares();
  main.innerHTML = `
    <div class="page">
      <div class="section-head">
        <div><div class="eyebrow">SHARE · 学习感悟</div><h2>把成长写成故事</h2><p>发布学习心得，浏览老师和同学的感悟，为喜欢的分享点赞、评论。</p></div>
        <div class="share-head-actions">
          ${(state.role === 'admin' || state.account?.is_admin === true) && sorted.length ? `<button class="btn btn--danger btn--sm" data-action="clear-all-shares" title="清空全部感悟并同步">${icon('i-trash', 'icon--sm')} 清空全部</button>` : ''}
          <button class="btn btn--primary" data-action="open-share-form">${icon('i-plus', 'icon--sm')} 发布感悟</button>
        </div>
      </div>
      <div id="share-sync-bar" class="share-sync-bar hidden"></div>
      <div class="share-layout">
        <div class="share-list">
          ${sorted.length ? sorted.map(shareCard).join('') : `<div class="empty card"><div class="empty__art">${icon('i-heart', 'icon--xl')}</div><h3>还没有感悟分享</h3><p>来发布第一条学习感悟吧。</p></div>`}
        </div>
        <aside class="share-side panel">
          <div class="panel__head"><div><h3>分享小贴士</h3><small>让感悟更有温度</small></div></div>
          <ul class="share-tips">
            <li>${icon('i-check', 'icon--sm')} 写下今天学到的一个新知识</li>
            <li>${icon('i-check', 'icon--sm')} 记录一次失败与重新尝试</li>
            <li>${icon('i-check', 'icon--sm')} 给同学一个真诚的建议</li>
            <li>${icon('i-check', 'icon--sm')} 配上年级与学科，更容易找到同好</li>
          </ul>
          <div class="share-side__stat">
            <strong>${sorted.length}</strong><span>条感悟</span>
            <strong>${sorted.reduce((n, s) => n + (s.likes || 0), 0)}</strong><span>个点赞</span>
          </div>
        </aside>
      </div>
    </div>`;
  renderShareSyncBar();
}

/* ---------- 学习感悟删除：即时同步 + 失败重试 ----------
   设计要点：
   1) 删除后立即更新本地权威 state.shares 并持久化 → storage 事件广播到其它标签，
      当前视图重渲染（列表、空状态、侧边统计、顶部计数）无需刷新页面。
   2) 云端模式先删云端权威数据，再更新本地，避免"本地删了云端还在"的残留。
   3) 删除失败保留原数据并展示错误条 + 重试按钮；防重复点击；异常兜底。
   4) normalizeShares 按 id 去重，避免跨端合并/轮询时出现重复感悟。 */
let shareDeleteInFlight = false;
let shareDeletePending = []; // 确认弹窗对应的待删除 id 列表（空数组=清空全部）
let shareSyncStatus = ''; // '' | 'syncing' | 'success' | 'error'
let shareSyncMessage = '';
let shareSyncRetry = null;

function renderShareSyncBar() {
  const bar = $('#share-sync-bar');
  if (!bar) return;
  if (!shareSyncStatus) { bar.className = 'share-sync-bar hidden'; bar.innerHTML = ''; return; }
  const iconId = shareSyncStatus === 'syncing' ? 'i-refresh' : shareSyncStatus === 'success' ? 'i-check' : 'i-x';
  bar.className = `share-sync-bar is-${shareSyncStatus}`;
  bar.innerHTML = `
    <span class="share-sync-bar__dot">${icon(iconId, 'icon--sm')}</span>
    <span class="share-sync-bar__text">${esc(shareSyncMessage)}</span>
    ${shareSyncStatus === 'error' ? `<button class="btn btn--ghost btn--sm" data-action="retry-share-sync">${icon('i-refresh', 'icon--sm')} 重试</button>` : ''}`;
}
function setShareSyncStatus(status, message, retry) {
  shareSyncStatus = status;
  shareSyncMessage = message || '';
  shareSyncRetry = typeof retry === 'function' ? retry : null;
  renderShareSyncBar();
}
function refreshShareDependentViews() {
  if (state.view === 'shares' && $('#main')) renderShares($('#main'));
  // 数据概括页的"今日感悟/点赞"等统计基于 state.shares，需同步刷新
  if (state.view === 'admin' && state.admin.tab === 'overview' && $('#admin-content')) {
    Promise.resolve(typeof refreshOverviewSources === 'function' ? refreshOverviewSources() : null)
      .then(() => {
        if (state.view === 'admin' && state.admin.tab === 'overview' && $('#admin-content')) renderAdminOverview($('#admin-content'));
      });
  }
}

function confirmDeleteShares(ids, label) {
  shareDeletePending = (ids || []).slice();
  const count = ids.length;
  const title = count > 1 || !label ? '清空全部学习感悟' : '删除学习感悟';
  openModal({
    title,
    body: `<p>即将删除 <b>${count}</b> 条学习感悟${count > 1 || !label ? '（全部感悟）' : `「${esc(label)}」`}及其评论、点赞记录。</p>
      <p class="muted" style="margin-top:var(--s3)">删除后本机与其它设备将立即同步更新，无需刷新页面。</p>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button>
      <button class="btn btn--danger" data-action="confirm-delete-shares">确认删除并同步</button>`,
  });
}

async function executeDeleteShares(ids) {
  if (shareDeleteInFlight) return;
  shareDeleteInFlight = true;
  const retry = () => executeDeleteShares(ids);
  setShareSyncStatus('syncing', '正在同步删除结果…');
  const btn = $('[data-action="confirm-delete-shares"]');
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  try {
    const res = await window.SunnyAPI.deleteShares({ ids: ids || [] });
    if (!res.ok) {
      setShareSyncStatus('error', res.message || '同步失败，请重试', retry);
      toast(res.message || '同步失败，请重试', 'error');
      return;
    }
    // API 已更新 state.shares 并持久化；重渲染立即反映空列表/零统计
    refreshShareDependentViews();
    setShareSyncStatus('success', res.message || '删除结果已同步');
    toast(res.message || '删除结果已同步');
    // 云端复核：以最新云端数据为准，杜绝重复/残留（失败不阻塞本轮成功反馈）
    if (state.cloudMode && !state.cloudStale && window.cloud) loadCloudShares({ silent: true });
    setTimeout(() => { if (shareSyncStatus === 'success') setShareSyncStatus(''); }, 4000);
  } catch (e) {
    setShareSyncStatus('error', '网络异常，请检查网络后重试', retry);
    toast('网络异常，请检查网络后重试', 'error');
  } finally {
    shareDeleteInFlight = false;
    const b = $('[data-action="confirm-delete-shares"]');
    if (b) { b.disabled = false; b.textContent = '确认删除并同步'; }
  }
}

function openShareForm() {
  const me = state.account;
  const scope = window.SunnyAPI.gradeScopeFor(me);
  const allowed = scope === 'all' ? GRADES : GRADES.filter(g => scope.indexOf(g) >= 0);
  const defaultGrade = allowed.indexOf(Number(me.grade)) >= 0 ? Number(me.grade) : allowed[0];
  openModal({
    title: '发布学习感悟',
    body: `
      <div class="field"><label class="field__label" for="share-title">标题</label><input class="input" id="share-title" placeholder="例如：我今天学会了分数" /></div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="share-grade">年级</label><select class="select" id="share-grade">${allowed.map(g => `<option value="${g}" ${defaultGrade === g ? 'selected' : ''}>${gradeLabel(g)}</option>`).join('')}</select>
          ${scope !== 'all' ? '<span class="field__hint">仅可在你有权限的年级发布</span>' : ''}</div>
        <div class="field grow"><label class="field__label" for="share-subject">学科</label><select class="select" id="share-subject">${Object.entries(SUBJECTS).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label class="field__label" for="share-content">感悟内容</label><textarea class="textarea" id="share-content" rows="5" placeholder="写下你的学习收获、疑问或有趣发现…"></textarea></div>
      <span class="field__error" id="share-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="submit-share">发布感悟</button>`,
  });
}

// 评论弹窗：评论种类按角色权限过滤（学生/老师/小组）
function openCommentForm(shareId) {
  const share = state.shares.find(s => String(s.id) === String(shareId));
  if (!share) return;
  const me = state.account;
  const kinds = window.SunnyAPI.commentKindsFor(me.role) || [];
  if (!kinds.length) { toast('当前账户无权评论', 'error'); return; }
  // 学生只能评论有权限年级的感悟
  const gate = window.SunnyAPI.assertGradeAccess(me, share.grade);
  if (!gate.ok) { toast(gate.message, 'error'); return; }
  openModal({
    title: '发表评论',
    body: `
      <p class="muted" style="margin-bottom:var(--s4)">评论「${esc(share.title)}」</p>
      <div class="field"><label class="field__label" for="comment-kind">评论身份</label>
        <select class="select" id="comment-kind">${kinds.map(k => `<option value="${k}">${window.SunnyAPI.COMMENT_LABELS[k]}</option>`).join('')}</select></div>
      <div class="field"><label class="field__label" for="comment-content">评论内容</label><textarea class="textarea" id="comment-content" rows="4" placeholder="写下你的想法…"></textarea></div>
      <span class="field__error" id="comment-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="submit-comment" data-id="${esc(share.id)}">发表评论</button>`,
  });
}

async function submitComment(shareId) {
  const share = state.shares.find(s => String(s.id) === String(shareId));
  const err = $('#comment-err');
  if (!share) return;
  const me = state.account;
  const kind = $('#comment-kind')?.value || 'student';
  const content = ($('#comment-content')?.value || '').trim();
  if (err) err.textContent = '';
  const gate = window.SunnyAPI.assertGradeAccess(me, share.grade);
  if (!gate.ok) { if (err) err.textContent = gate.message; return; }
  if (!window.SunnyAPI.canPostComment(me.role, kind)) {
    if (err) err.textContent = '当前账户无权使用该评论身份'; return;
  }
  if (!content) { if (err) err.textContent = '请输入评论内容'; return; }

  const comment = {
    id: 'cm' + Date.now(), kind, owner_id: me.id, owner_name: me.name,
    avatar: me.avatar || me.name[0], color: me.color || 'avatar--sky',
    content, created_at: formatStamp(new Date()),
  };

  if (state.cloudMode && !state.cloudStale && window.cloud) {
    const btn = $('[data-action="submit-comment"]');
    if (btn) { btn.disabled = true; btn.textContent = '发表中…'; }
    try {
      const { error } = await window.cloud.database.from('share_comments').insert({
        share_id: Number(share.id), owner_name: me.name, avatar: me.avatar || me.name[0],
        color: me.color || 'avatar--sky', kind, content,
      }).select();
      if (error) { if (err) err.textContent = error.message || '评论失败，请重试'; return; }
      closeModal();
      await loadCloudShares();
      toast('评论已发表并同步到云端');
    } catch (e) {
      if (err) err.textContent = '评论失败，请检查网络后重试';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '发表评论'; }
    }
    return;
  }

  // 本地：经 API 归一化后写回并持久化
  const res = window.SunnyAPI.appendComment(share, comment);
  if (!res.ok) { if (err) err.textContent = res.message; return; }
  const idx = state.shares.findIndex(s => String(s.id) === String(share.id));
  if (idx >= 0) state.shares[idx] = res.data;
  persist();
  closeModal();
  renderShares($('#main'));
  toast('评论已发表');
}

function formatStamp(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- 人员白名单：从云端 personnel 加载到 state.users（超管专用） ---------- */
async function refreshPersons() {
  if (!window.SunnyAPI || !window.SunnyAPI.listPersons) return;
  try {
    const res = await window.SunnyAPI.listPersons();
    if (!res.ok) { toast(res.message, 'error'); return; }
    if (state.view === 'admin' && state.admin.tab === 'users') renderAdmin($('#main'));
  } catch (e) { toast('加载人员失败，请检查网络后重试', 'error'); }
}

/* ---------- 权限配置：从云端 app_config 加载到 state.roles / permissions / viewPerms ---------- */
async function loadRoleConfigs() {
  if (!window.SunnyAPI || !window.SunnyAPI.listRoleConfigs) return;
  try {
    const res = await window.SunnyAPI.listRoleConfigs();
    if (!res.ok) { toast(res.message, 'error'); return; }
    if (window.SunnyAPI.listPermissionDefs) {
      await window.SunnyAPI.listPermissionDefs();
    }
    // 权限配置加载后重建导航（视图门禁可能变化），并校验当前视图是否仍可访问
    if (typeof renderNav === 'function') renderNav();
    if (state.authed && !canView(state.view) && typeof navigate === 'function') navigate(state.view);
    if (state.view === 'admin' && state.admin.tab === 'roles') renderAdmin($('#main'));
  } catch (e) { toast('加载角色配置失败，请检查网络后重试', 'error'); }
}

/* ---------- 云端资料：从云数据库加载到 state.materials（公开可读，无需登录） ---------- */
async function loadCloudMaterials() {
  if (!window.cloud || !window.SunnyAPI || !window.SunnyAPI.fetchCloudMaterials) return;
  try {
    const res = await window.SunnyAPI.fetchCloudMaterials();
    if (!res.ok) { console.warn('[Sunshine个人工作站] 加载云端资料失败', res.message); return; }
    const items = res.data && res.data.items;
    if (!Array.isArray(items) || !items.length) return;
    state.materials = items;
    // 缓存到 localStorage，保证离线也能看到完整资料；不写入则刷新会回退到 data.js 种子
    if (typeof window.SunnyStore !== 'undefined') persist();
    if (state.authed) {
      if (state.view === 'library') refreshMaterials();
      else if (state.view === 'admin' && state.admin.tab === 'materials') renderAdminMaterials($('#main'));
    }
  } catch (e) {
    console.warn('[Sunshine个人工作站] 云端资料同步异常', e && e.message);
  }
}

/* ---------- 云端感悟：从云数据库加载到 state.shares ----------
   silent=true 时为后台复核（删除后/轮询），不覆盖用户正在看的同步状态条。 */
async function loadCloudShares(options) {
  if (!state.cloudMode || !window.cloud) return;
  const silent = !!(options && options.silent);
  try {
    const { data, error } = await window.cloud.database
      .from('shares').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) {
      if (!silent) setShareSyncStatus('error', '加载云端感悟失败：' + (error.message || '请检查网络后重试'), () => loadCloudShares());
      console.warn('[Sunshine个人工作站] 加载云端感悟失败', error.message);
      return;
    }
    // 并行拉取三类评论，按 share_id 归组后挂到各自感悟上
    let commentsByShare = {};
    try {
      const cmRes = await window.cloud.database.from('share_comments').select('*').limit(1000);
      if (!cmRes.error && Array.isArray(cmRes.data)) {
        cmRes.data.forEach(raw => {
          const n = window.SunnyAPI.normalizeComment(raw);
          if (!n) return;
          const sid = String(raw.share_id);
          (commentsByShare[sid] = commentsByShare[sid] || []).push(n);
        });
      }
    } catch (e) { console.warn('[Sunshine个人工作站] 加载云端评论失败', e && e.message); }
    const rows = (data || []).map(row => Object.assign({}, row, { comments: commentsByShare[String(row.id)] || [] }));
    // 归一 + 按 id 去重，避免轮询/跨端合并产生重复数据
    const next = window.SunnyAPI.normalizeShares(rows);
    const changed = JSON.stringify(next.map(s => s.id)) !== JSON.stringify((state.shares || []).map(s => s.id))
      || JSON.stringify(next.map(s => s.likes)) !== JSON.stringify((state.shares || []).map(s => s.likes));
    state.shares = next;
    // 同步本地缓存：删除后其它标签/下次打开不会从旧快照恢复已删感悟；
    // 拉取的数据不回推云端，避免回声循环。
    suppressSyncPush = true;
    try { persist(); } finally { suppressSyncPush = false; }
    if (changed) refreshShareDependentViews();
    else if (state.view === 'shares' && $('#main')) renderShares($('#main'));
    if (!silent && shareSyncStatus === 'error') setShareSyncStatus('');
  } catch (e) {
    if (!silent) setShareSyncStatus('error', '感悟同步异常，请检查网络后重试', () => loadCloudShares());
    console.warn('[Sunshine个人工作站] 云端感悟同步异常', e && e.message);
  }
}

async function submitShare() {
  const title = $('#share-title').value.trim();
  const content = $('#share-content').value.trim();
  const grade = Number($('#share-grade').value);
  const subject = $('#share-subject').value;
  const err = $('#share-err');
  if (!title) return err.textContent = '请输入标题';
  if (!content) return err.textContent = '请输入感悟内容';
  const me = state.account;
  const gate = window.SunnyAPI.assertGradeAccess(me, grade);
  if (!gate.ok) return err.textContent = gate.message;
  const now = new Date();
  const stamp = formatStamp(now);

  if (state.cloudMode && window.cloud) {
    // 云端写入：owner_id 由 DEFAULT auth.uid() 服务端填充，客户端不传
    const submitBtn = $('[data-action="submit-share"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '发布中…'; }
    try {
      const { error } = await window.cloud.database.from('shares').insert({
        owner_name: me.name, avatar: me.avatar || me.name[0], color: me.color || 'avatar--sky',
        grade, subject, title, content,
      }).select();
      if (error) { err.textContent = error.message || '发布失败，请重试'; return; }
      closeModal();
      await loadCloudShares();
      toast('感悟已发布并同步到云端');
    } catch (e) {
      err.textContent = '发布失败，请检查网络后重试';
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '发布感悟'; }
    }
    return;
  }

  // 演示模式：写入本地
  state.shares.unshift({
    id: 's' + now.getTime(), owner_id: me.id, owner_name: me.name,
    avatar: me.avatar || me.name[0], color: me.color || 'avatar--sky',
    grade, subject, title, content, likes: 0, like_by: [], created_at: stamp,
  });
  persist();
  closeModal();
  renderShares($('#main'));
  toast('感悟已发布');
}

async function toggleLike(id) {
  const s = state.shares.find(x => String(x.id) === String(id));
  if (!s) return;
  const me = state.account;

  if (state.cloudMode && window.cloud) {
    // 云端点赞：share_likes 表按 (share_id, owner_id) 唯一约束防重复
    const key = String(id);
    s.like_by = Array.isArray(s.like_by) ? s.like_by : [];
    const liked = s.like_by.some(uid => String(uid) === String(me.id));
    try {
      if (liked) {
        await window.cloud.database.from('share_likes').delete()
          .eq('share_id', Number(id)).eq('owner_id', me.id);
        await window.cloud.database.from('shares').update({ likes: Math.max(0, (s.likes || 1) - 1) }).eq('id', Number(id));
      } else {
        await window.cloud.database.from('share_likes').insert({ share_id: Number(id) });
        await window.cloud.database.from('shares').update({ likes: (s.likes || 0) + 1 }).eq('id', Number(id));
      }
      await loadCloudShares();
    } catch (e) {
      toast('点赞同步失败，请重试', 'error');
    }
    return;
  }

  // 演示模式：本地点赞
  s.like_by = Array.isArray(s.like_by) ? s.like_by : [];
  const i = s.like_by.indexOf(me.id);
  if (i >= 0) {
    s.like_by.splice(i, 1);
    s.likes = Math.max(0, (s.likes || 1) - 1);
  } else {
    s.like_by.push(me.id);
    s.likes = (s.likes || 0) + 1;
  }
  persist();
  renderShares($('#main'));
}

/* ==========================================================================
   模块三：内部通讯录
   ========================================================================== */
function filteredMembers() {
  const d = state.directory, q = d.query.trim().toLowerCase();
  return directoryMembers().filter(m => {
    if (d.roleFilter !== 'all' && m.role !== d.roleFilter) return false;
    if (q && !`${m.name} ${m.title} ${m.dept || ''} ${m.email || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderDirectory(main) {
  syncDirectoryNow();
  main.innerHTML = `
    <div class="page">
      <div class="section-head">
        <div><div class="eyebrow">CONNECT · 内部通讯录</div><h2>与老师和同学保持联系</h2><p>查看成员信息、搜索同事同学、发送内部消息。</p></div>
        <button class="btn btn--primary" data-action="new-message">${icon('i-plus','icon--sm')} 发起会话</button>
      </div>
      ${state.directory.conflicts.length ? `<div class="dir-sync-notice">${icon('i-info','icon--sm')} 检测到 ${state.directory.conflicts.length} 条重复成员记录，已按「唯一标识 → 手机号 → 邮箱」规则自动合并，保留最近更新的记录。</div>` : ''}
      <div class="dir-layout">
        <section class="dir-panel dir-panel--list">
          <div class="dir-panel__head">
            <h3>成员 <span class="muted" id="member-count" style="font-size:var(--fs-sm)"></span></h3>
            <div class="search-sm">${icon('i-search')}<input id="member-search" type="search" placeholder="按姓名 / 角色搜索…" value="${esc(state.directory.query)}" /></div>
            <div class="row wrap" style="margin-top:12px;gap:6px">
              ${[['all','全部'],['student','学生'],['teacher','教师'],['admin','管理员'],['parent','家长']].map(([k,l]) => `
                <button class="chip ${state.directory.roleFilter === k ? 'is-active' : ''}" style="padding:5px 11px" data-action="filter-dir-role" data-role="${k}">${l}</button>`).join('')}
            </div>
          </div>
          <div class="member-list" id="member-list"></div>
        </section>
        <section class="dir-panel dir-panel--chat chat-panel" id="chat-panel"></section>
      </div>
    </div>`;
  refreshMemberList();
  renderChat();
  $('#member-search').addEventListener('input', e => {
    state.directory.query = e.target.value;
    refreshMemberList();
  });
}

function refreshMemberList() {
  const list = filteredMembers();
  $('#member-count').textContent = `(${list.length})`;
  const el = $('#member-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty" style="padding:var(--s7) 16px"><div class="empty__art" style="width:64px;height:64px">${icon('i-users','icon--lg')}</div><h3>没有匹配的成员</h3><p>换个姓名或角色试试。</p></div>`;
    return;
  }
  el.innerHTML = list.map(m => {
    const conv = state.conversations.find(c => c.with === m.id);
    const isActive = conv && conv.id === state.directory.activeConv;
    return `<div class="member-item ${isActive ? 'is-active' : ''}">
      <div class="member-item__open" data-action="show-member-info" data-id="${m.id}" aria-label="查看 ${esc(m.name)} 的个人简介">
        ${avatarHTML(m)}
        <div class="member-item__meta">
          <strong>${esc(m.name)}</strong>
          <small><span class="member-item__status member-item__status--${m.presence}"></span>${esc(m.title)}</small>
        </div>
      </div>
      <button class="member-item__info" data-action="show-member-info" data-id="${m.id}" aria-label="查看 ${esc(m.name)} 的个人简介">${icon('i-info','icon--sm')}</button>
      <button class="member-item__msg" data-action="open-conv-with" data-id="${m.id}" aria-label="给 ${esc(m.name)} 发消息">${icon('i-message','icon--sm')}</button>
    </div>`;
  }).join('');
}

function findOrCreateConv(userId) {
  let conv = state.conversations.find(c => c.with === userId);
  if (!conv) {
    conv = { id: 'c' + Date.now(), with: userId, messages: [], unread: 0 };
    state.conversations.unshift(conv);
  }
  return conv;
}

// 视口判断：手机走全屏聊天，电脑走通讯录左右分栏（与 syncViewportMode 的断点一致）
function isPhoneViewport(width) { const w = Number(width); return w > 0 && w <= 680; }
function isPhone() {
  const v = (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset.viewport) || '';
  if (v) return v === 'phone';
  return typeof window !== 'undefined' && isPhoneViewport(window.innerWidth);
}
function convPerson(conv) {
  return findDirectoryMember(conv.with) || state.users.find(m => m.id === conv.with) || {
    id: conv.with, name: '未知成员', avatar: '友', presence: 'offline',
  };
}

/* ---------- 上线活动通知记录：离线事件写入聊天记录 ---------- */
// 记录一条活动事件到当前会话的待投递队列（会话隔离，persist 落盘）
function recordActivityEvent(kind, peerId, detail) {
  const A = window.SunnyAPI;
  const peer = findDirectoryMember(peerId) || state.users.find(m => String(m.id) === String(peerId));
  const ev = A && A.normalizeActivityEvent ? A.normalizeActivityEvent({
    id: A.newActivityId(), kind, peerId: String(peerId), peerName: peer ? peer.name : '',
    detail: detail || '', at: new Date().toISOString(), delivered: false,
  }) : null;
  if (!ev) return null;
  state.pendingEvents.push(ev);
  persist();
  flushPendingEvents(); // 若当前已在线且会话打开，立即落入聊天记录
  return ev;
}
// 将待投递事件写入对应会话的聊天记录（去重），保持未投递项以便跨上线补记
function flushPendingEvents() {
  const A = window.SunnyAPI;
  if (!A || !A.flushActivityEvents) return;
  const deliveredIds = [];
  state.conversations.forEach(c => (c.messages || []).forEach(m => { if (m && m.eventId) deliveredIds.push(m.eventId); }));
  const res = A.flushActivityEvents(state.pendingEvents, deliveredIds);
  // 已成功写入聊天记录的事件从待投递队列移除；未投递（如异常）的保留以便下次补记
  const writtenIds = new Set(res.messages.map(m => m.eventId));
  state.pendingEvents = res.pending.filter(ev => !writtenIds.has(String(ev.id)));
  let changed = false;
  res.messages.forEach(msg => {
    if (!msg.peerId) return;
    const conv = findOrCreateConv(msg.peerId);
    // 避免重复写入
    if ((conv.messages || []).some(m => m && m.eventId === msg.eventId)) return;
    conv.messages.push(msg);
    changed = true;
  });
  if (res.messages.length) persist();
  if (changed && state.view === 'directory') renderActiveChat();
}
// 用户上线时调用：把离线期间积累的活动事件补记到聊天记录
function onUserComeOnline() {
  flushPendingEvents();
}
function activityEventIcon(kind) {
  if (kind === 'voice_call' || kind === 'voice_missed') return 'i-phone';
  if (kind === 'video_call' || kind === 'video_missed') return 'i-video';
  return 'i-message';
}
function chatMessagesHTML(conv, me, person) {
  if (!conv.messages.length) return `<div class="chat-empty" style="margin:auto"><p>还没有消息，打个招呼吧 👋</p></div>`;
  return conv.messages.map(m => {
    if (m && m.system) {
      return `<div class="msg-event ${m.kind && m.kind.indexOf('missed') >= 0 ? 'msg-event--missed' : ''}">
        <span class="msg-event__ic">${icon(activityEventIcon(m.kind))}</span>
        <span class="msg-event__text">${esc(m.text)}</span>
        ${m.time ? `<time class="msg-event__time">${esc(m.time)}</time>` : ''}
      </div>`;
    }
    const mine = m.from === me.id;
    const av = avatarHTML(mine ? me : person, 'avatar--sm');
    let bubble;
    if (m.kind === 'image' && m.image) {
      bubble = `<div class="msg__bubble msg__bubble--media"><img class="msg__img" src="${esc(m.image)}" alt="${esc(m.text || '图片')}" data-action="preview-image" loading="lazy" /></div>`;
    } else if (m.kind === 'sticker' && m.image) {
      bubble = `<div class="msg__bubble msg__bubble--sticker"><img class="msg__sticker" src="${esc(m.image)}" alt="${esc(m.text || '表情')}" /></div>`;
    } else {
      bubble = `<div class="msg__bubble">${esc(m.text)}</div>`;
    }
    return `
    <div class="msg ${mine ? 'msg--me' : ''}">
      ${av}
      ${bubble}
      <span class="msg__time">${esc(m.time)}</span>
    </div>`;
  }).join('');
}
function chatCallButtonsHTML(peerId, cls = 'icon-btn') {
  return `<button class="${cls}" data-action="start-call" data-type="voice" data-id="${esc(peerId)}" aria-label="语音通话">${icon('i-phone')}</button>
    <button class="${cls}" data-action="start-call" data-type="video" data-id="${esc(peerId)}" aria-label="视频通话">${icon('i-video')}</button>`;
}
// 统一聊天输入区：加号（照片/拍照/预留）、表情、输入框、发送。
// isFs=true 为手机全屏聊天，id 用 chat-fs-*；否则用 chat-*。
function chatComposeHTML(inputId, isFs = false) {
  return `
    <div class="chat-compose ${isFs ? 'chat-compose--fs' : ''}" data-stop>
      <div class="chat-tools">
        <div class="chat-tools__row">
          <button class="chat-tool-btn ${state.directory.moreOpen ? 'is-active' : ''}" data-action="toggle-chat-more" aria-label="更多功能" aria-expanded="${!!state.directory.moreOpen}">${icon('i-plus')}</button>
          <button class="chat-tool-btn ${state.directory.emojiOpen ? 'is-active' : ''}" data-action="toggle-chat-emoji" aria-label="表情" aria-expanded="${!!state.directory.emojiOpen}">${icon('i-smile')}</button>
        </div>
        ${state.directory.moreOpen ? chatMorePanelHTML() : ''}
        ${state.directory.emojiOpen ? chatEmojiPanelHTML() : ''}
      </div>
      <textarea id="${inputId}" rows="1" placeholder="输入消息，按 Enter 发送…"></textarea>
      <button class="btn btn--primary btn--icon" data-action="send-message" aria-label="发送消息">${icon('i-send')}</button>
    </div>`;
}
// 加号折叠面板：照片 / 拍照 + 预留扩展位（未来新增接口只需在此追加一项）
function chatMorePanelHTML() {
  return `<div class="chat-more-panel" data-stop>
    <button class="chat-more-item" data-action="pick-photo">
      <span class="chat-more-item__ic">${icon('i-image')}</span><span>照片</span>
    </button>
    <button class="chat-more-item" data-action="take-photo">
      <span class="chat-more-item__ic">${icon('i-camera')}</span><span>拍照</span>
    </button>
    <button class="chat-more-item chat-more-item--soon" data-action="feature-soon" title="敬请期待">
      <span class="chat-more-item__ic">${icon('i-plus')}</span><span>更多</span>
    </button>
  </div>`;
}
// 表情面板：内置 emoji 分类 + 自定义表情包 + 收藏
function chatEmojiPanelHTML() {
  const emo = state.emoticons || { custom: [], favorites: [] };
  const tab = state.directory.emojiTab || 'face';
  const groups = window.SunnyAPI.EMOJI_GROUPS || [];
  const custom = Array.isArray(emo.custom) ? emo.custom : [];
  const favs = Array.isArray(emo.favorites) ? emo.favorites : [];
  let grid = '';
  if (tab === 'custom') {
    grid = custom.length
      ? custom.map(s => `<button class="emoji-cell emoji-cell--sticker" data-action="insert-emoji" data-value="${esc(s.image)}" data-kind="sticker" title="${esc(s.name)}"><img src="${esc(s.image)}" alt="${esc(s.name)}" /></button>`).join('')
      : `<div class="emoji-empty">还没有自定义表情，点击下方「添加」上传图片</div>`;
  } else if (tab === 'fav') {
    grid = favs.length
      ? favs.map(v => {
          const isImg = /^(data:image|https?:\/\/)/i.test(v);
          return isImg
            ? `<button class="emoji-cell emoji-cell--sticker" data-action="insert-emoji" data-value="${esc(v)}" data-kind="sticker"><img src="${esc(v)}" alt="收藏表情" /></button>`
            : `<button class="emoji-cell" data-action="insert-emoji" data-value="${esc(v)}" data-kind="emoji">${esc(v)}</button>`;
        }).join('')
      : `<div class="emoji-empty">还没有收藏表情，长按表情或点表情右上角星标收藏</div>`;
  } else {
    const group = groups.find(g => g.key === tab) || groups[0];
    grid = group ? group.items.map(x => `<button class="emoji-cell" data-action="insert-emoji" data-value="${esc(x.c)}" data-kind="emoji" title="${esc(x.l)}">${esc(x.c)}</button>`).join('') : '';
  }
  const tabs = groups.map(g => `<button class="emoji-tab ${tab === g.key ? 'is-active' : ''}" data-action="emoji-tab" data-tab="${g.key}">${esc(g.name)}</button>`).join('')
    + `<button class="emoji-tab ${tab === 'custom' ? 'is-active' : ''}" data-action="emoji-tab" data-tab="custom">自定义</button>`
    + `<button class="emoji-tab ${tab === 'fav' ? 'is-active' : ''}" data-action="emoji-tab" data-tab="fav">收藏</button>`;
  return `<div class="chat-emoji-panel" data-stop>
    <div class="emoji-tabs">${tabs}</div>
    <div class="emoji-grid">${grid}</div>
    <div class="emoji-foot">
      <button class="emoji-foot__btn" data-action="add-sticker">${icon('i-plus','icon--sm')} 添加表情</button>
      <button class="emoji-foot__btn" data-action="manage-stickers">${icon('i-edit','icon--sm')} 管理</button>
    </div>
  </div>`;
}

function openConvWith(userId) {
  const conv = findOrCreateConv(userId);
  state.directory.activeConv = conv.id;
  conv.unread = 0;
  state.directory.moreOpen = false;
  state.directory.emojiOpen = false;
  refreshMemberList();
  if (isPhone()) {
    state.directory.chatFullscreen = true;
    renderChatFullscreen();
  } else {
    state.directory.chatFullscreen = false;
    renderChat();
  }
}

function renderChat() {
  const panel = $('#chat-panel');
  if (!panel) return;
  const conv = state.conversations.find(c => c.id === state.directory.activeConv);
  if (!conv) {
    panel.innerHTML = `<div class="chat-empty"><div class="chat-empty__art">${icon('i-message','icon--xl')}</div><h3>选择一个成员开始聊天</h3><p>在左侧列表中点击成员头像旁的按钮，即可发送内部消息。</p></div>`;
    return;
  }
  const person = convPerson(conv);
  const me = state.account;
  panel.innerHTML = `
    <div class="chat-head">
      ${avatarHTML(person,'avatar--sm')}
      <div class="chat-head__meta"><strong>${esc(person.name)}</strong><small><span class="dot"></span> ${presenceText(person)}</small></div>
      <div class="chat-head__actions">
        ${chatCallButtonsHTML(conv.with)}
        <button class="icon-btn" data-action="chat-info" aria-label="成员资料">${icon('i-info')}</button>
        <button class="icon-btn" data-action="close-chat" aria-label="关闭会话">${icon('i-x')}</button>
      </div>
    </div>
    <div class="chat-body" id="chat-body">
      <div class="chat-day">今天</div>
      ${chatMessagesHTML(conv, me, person)}
    </div>
    ${chatComposeHTML('chat-input', false)}`;
  const body = $('#chat-body');
  body.scrollTop = body.scrollHeight;
  const input = $('#chat-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage(); }
  });
}

/* 手机端：独立全屏聊天界面（顶部返回 + 对方信息 + 通话按钮 + 消息 + 输入） */
function renderChatFullscreen() {
  const root = $('#chat-fullscreen-root');
  if (!root) return;
  const conv = state.conversations.find(c => c.id === state.directory.activeConv);
  if (!conv) { closeChatFullscreen(); return; }
  const person = convPerson(conv);
  const me = state.account;
  root.innerHTML = `
    <div class="chat-fs-mask" data-stop>
      <div class="chat-fs-head">
        <button class="chat-fs-back" data-action="chat-fs-back" aria-label="返回通讯录">${icon('i-chevron-left')}</button>
        <div class="chat-fs-title">
          ${avatarHTML(person,'avatar--sm')}
          <div class="chat-fs-title__meta"><strong>${esc(person.name)}</strong><small>${esc(presenceText(person))}</small></div>
        </div>
        <div class="chat-fs-actions">
          ${chatCallButtonsHTML(conv.with)}
          <button class="icon-btn" data-action="chat-info" aria-label="成员资料">${icon('i-info')}</button>
        </div>
      </div>
      <div class="chat-fs-body" id="chat-fs-body">
        <div class="chat-day">今天</div>
        ${chatMessagesHTML(conv, me, person)}
      </div>
      ${chatComposeHTML('chat-fs-input', true)}
    </div>`;
  const body = $('#chat-fs-body');
  body.scrollTop = body.scrollHeight;
  const input = $('#chat-fs-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage(); }
  });
}
function closeChatFullscreen() {
  state.directory.chatFullscreen = false;
  const root = $('#chat-fullscreen-root');
  if (root) root.innerHTML = '';
  renderChat();
  refreshMemberList();
}
function renderActiveChat() {
  if (state.directory.chatFullscreen) renderChatFullscreen(); else renderChat();
}

window.sendMessage = function () {
  const input = state.directory.chatFullscreen ? $('#chat-fs-input') : $('#chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const conv = state.conversations.find(c => c.id === state.directory.activeConv);
  if (!conv) return;
  const now = new Date();
  conv.messages.push({ from: state.account.id, text, time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` });
  renderActiveChat();
  persist();
  toast('消息已发送');
  // 模拟对方回复（对方可能已被删除或为演示用户，取不到时安全回退）
  const person = findDirectoryMember(conv.with) || state.users.find(m => m.id === conv.with);
  const replyFrom = person ? person.id : conv.with;
  const replyTime = new Date(now.getTime() + 60 * 1000);
  setTimeout(() => {
    const c2 = state.conversations.find(c => c.id === conv.id);
    const replyText = '收到啦，谢谢你！';
    const visible = state.view === 'directory' && state.directory.activeConv === conv.id;
    if (!visible) {
      // 不在线/不在该会话：记一条消息活动事件，上线时在聊天记录里补记通知
      try { recordActivityEvent('message', replyFrom, replyText); } catch (e) {}
    }
    if (!c2) return;
    if (!visible) { c2.unread = (c2.unread || 0) + 1; persist(); return; }
    c2.messages.push({
      from: replyFrom,
      text: replyText,
      time: `${String(replyTime.getHours()).padStart(2,'0')}:${String(replyTime.getMinutes()).padStart(2,'0')}`,
    });
    renderActiveChat();
    persist();
  }, 1400);
};

/* ---------- 聊天：加号面板 / 表情 / 图片消息 ---------- */
function activeChatInput() {
  return state.directory.chatFullscreen ? $('#chat-fs-input') : $('#chat-input');
}
function toggleChatMore() {
  state.directory.moreOpen = !state.directory.moreOpen;
  if (state.directory.moreOpen) state.directory.emojiOpen = false;
  renderActiveChat();
}
function toggleChatEmoji() {
  state.directory.emojiOpen = !state.directory.emojiOpen;
  if (state.directory.emojiOpen) state.directory.moreOpen = false;
  renderActiveChat();
}
// 读取并压缩图片文件为 dataURL（canvas 等比缩放 + JPEG 质量），失败返回 fail。
function compressImageFile(file) {
  return new Promise((resolve) => {
    const A = window.SunnyAPI;
    if (!file || !/^image\//i.test(file.type || '')) return resolve({ ok: false, error: '请选择图片文件' });
    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, error: '读取图片失败' });
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve({ ok: false, error: '图片解析失败' });
      img.onload = () => {
        try {
          const fit = A.fitImageSize(img.naturalWidth || img.width, img.naturalHeight || img.height, A.IMAGE_MAX_SIDE);
          const canvas = document.createElement('canvas');
          canvas.width = fit.w; canvas.height = fit.h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, fit.w, fit.h); // 透明背景填白，避免 JPEG 变黑
          ctx.drawImage(img, 0, 0, fit.w, fit.h);
          let dataUrl = canvas.toDataURL('image/jpeg', A.IMAGE_QUALITY);
          if (A.dataUrlBytes(dataUrl) > A.IMAGE_MAX_BYTES) dataUrl = canvas.toDataURL('image/jpeg', 0.5);
          if (A.dataUrlBytes(dataUrl) > A.IMAGE_MAX_BYTES) return resolve({ ok: false, error: '图片过大，请换一张较小的图片' });
          resolve({ ok: true, dataUrl, w: fit.w, h: fit.h });
        } catch (e) {
          resolve({ ok: false, error: '图片处理失败' });
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// 打开系统图片选择器：useCamera=true 优先调用后置摄像头（拍照），否则打开相册/文件。
// 动态创建并挂到 body 的 input，避免聊天区重绘、或桌面与手机全屏同时存在同 id input
// 导致的选择器串台；同时保证 iOS / 微信内置浏览器能在用户手势同步栈内正常唤起。
function openImagePicker(useCamera) {
  // 清理上一次可能残留的临时输入（用户取消选择时浏览器不触发 change）
  Array.from(document.querySelectorAll('.chat-file-input[data-temp="1"]')).forEach(el => {
    try { el.remove(); } catch (e) {}
  });
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (useCamera) input.setAttribute('capture', 'environment');
  input.className = 'chat-file-input';
  input.setAttribute('data-temp', '1');
  input.setAttribute('aria-hidden', 'true');
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    try { input.remove(); } catch (e) {}
    if (file) await sendImageFile(file);
  });
  try { input.click(); }
  catch (e) { try { input.remove(); } catch (_) {} toast('无法打开图片选择器，请检查浏览器权限', 'error'); }
}
// 读取并压缩图片文件，成功后作为图片消息发送
async function sendImageFile(file) {
  if (!file) return;
  toast('正在处理图片…', 'info');
  const res = await compressImageFile(file);
  if (!res.ok) { toast(res.error || '图片处理失败', 'error'); return; }
  pushImageMessage(res.dataUrl, 'image', res.w, res.h);
}
// 统一的图片/表情消息入栈：写会话 → 重绘 → 落盘 → 模拟回复
function pushImageMessage(image, kind, w, h) {
  const conv = state.conversations.find(c => c.id === state.directory.activeConv);
  if (!conv) return;
  const A = window.SunnyAPI;
  const msg = kind === 'sticker'
    ? { from: state.account.id, kind: 'sticker', image, text: '[表情]', time: A.nowHM() }
    : { from: state.account.id, kind: 'image', image, text: '[图片]', time: A.nowHM(), w: w || 0, h: h || 0 };
  conv.messages.push(msg);
  state.directory.moreOpen = false;
  state.directory.emojiOpen = false;
  renderActiveChat();
  persist();
  toast(kind === 'sticker' ? '表情已发送' : '图片已发送');
  // 复用文本消息的模拟回复（不带图片，避免占用过多空间）
  const person = findDirectoryMember(conv.with) || state.users.find(m => m.id === conv.with);
  const replyFrom = person ? person.id : conv.with;
  const replyText = '收到啦，谢谢你！';
  setTimeout(() => {
    const c2 = state.conversations.find(c => c.id === conv.id);
    const visible = state.view === 'directory' && state.directory.activeConv === conv.id;
    if (!visible) {
      try { recordActivityEvent('message', replyFrom, replyText); } catch (e) {}
    }
    if (!c2) return;
    if (!visible) { c2.unread = (c2.unread || 0) + 1; persist(); return; }
    c2.messages.push({ from: replyFrom, text: replyText, time: A.nowHM() });
    renderActiveChat();
    persist();
  }, 1400);
}
// 表情点击：emoji 插入输入框；sticker 直接作为表情消息发送
function insertEmoji(value, kind) {
  if (kind === 'sticker') { pushImageMessage(value, 'sticker'); return; }
  const input = activeChatInput();
  if (!input) return;
  const start = input.selectionStart != null ? input.selectionStart : input.value.length;
  const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
  input.value = input.value.slice(0, start) + value + input.value.slice(end);
  const pos = start + value.length;
  try { input.setSelectionRange(pos, pos); } catch (e) {}
  input.focus();
}
// 收藏/取消收藏当前表情（用于面板）。key 为 emoji 字符或图片 dataURL/URL
function toggleEmojiFavorite(key) {
  if (!key) return;
  const A = window.SunnyAPI;
  state.emoticons = state.emoticons || { custom: [], favorites: [] };
  state.emoticons.favorites = A.toggleFavorite(state.emoticons.favorites, key);
  persist();
  renderActiveChat();
  toast('收藏已更新');
}
// 图片大图预览（独立图层）
function previewImage(src) {
  let layer = $('#image-preview-root');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'image-preview-root';
    layer.className = 'image-preview-root hidden';
    document.body.appendChild(layer);
  }
  layer.innerHTML = `<div class="image-preview-mask" data-action="close-image-preview"></div>
    <img class="image-preview-img" src="${esc(src)}" alt="图片预览" data-stop />
    <button class="image-preview-close" data-action="close-image-preview" aria-label="关闭">${icon('i-x')}</button>`;
  layer.classList.remove('hidden');
}
function closeImagePreview() {
  const layer = $('#image-preview-root');
  if (layer) { layer.innerHTML = ''; layer.classList.add('hidden'); }
}

function newMessageModal() {
  openModal({
    title:'发起新会话',
    body:`<div class="field"><label class="field__label">选择成员</label>
      <select class="select" id="new-msg-select">${directoryMembers().filter(m => m.id !== state.account.id).map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(m.title)}</option>`).join('')}</select></div>
      <div class="field"><label class="field__label">消息内容</label><textarea class="textarea" id="new-msg-text" rows="3" placeholder="写点什么…"></textarea></div>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="confirm-new-message">发送并打开会话</button>`,
  });
}

// 添加自定义表情：名称 + 图片文件，压缩为 dataURL 存入会话表情包
function addStickerModal() {
  openModal({
    title:'添加自定义表情',
    body:`<div class="field"><label class="field__label">表情名称</label>
        <input class="input" id="sticker-name" maxlength="30" placeholder="例如：加油鸭" /></div>
      <div class="field"><label class="field__label">表情图片</label>
        <input type="file" id="sticker-file" class="sticker-file-input" accept="image/*" />
        <span class="field__hint">支持 JPG / PNG / GIF / WebP，自动压缩；添加后可在「自定义」分类中发送。</span></div>
      <div id="sticker-preview" class="sticker-add-preview"></div>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="confirm-add-sticker">添加表情</button>`,
  });
  const f = $('#sticker-file');
  if (f) f.addEventListener('change', async () => {
    const file = f.files && f.files[0];
    const box = $('#sticker-preview');
    if (!box) return;
    if (!file) { box.innerHTML = ''; return; }
    const res = await compressImageFile(file);
    if (res.ok) box.innerHTML = `<img src="${esc(res.dataUrl)}" alt="预览" /><span>已就绪，点「添加表情」保存</span>`;
    else box.innerHTML = `<span class="form-error">${esc(res.error || '图片处理失败')}</span>`;
  });
}
async function confirmAddSticker() {
  const A = window.SunnyAPI;
  const name = ($('#sticker-name') && $('#sticker-name').value || '').trim();
  const f = $('#sticker-file');
  const file = f && f.files && f.files[0];
  if (!file) { toast('请选择表情图片', 'error'); return; }
  state.emoticons = A.normalizeEmoticons(state.emoticons);
  if (state.emoticons.custom.length >= A.STICKER_MAX) { toast(`自定义表情最多 ${A.STICKER_MAX} 个`, 'error'); return; }
  toast('正在处理表情…', 'info');
  const res = await compressImageFile(file);
  if (!res.ok) { toast(res.error || '处理失败', 'error'); return; }
  const sticker = A.normalizeSticker({ id: A.newStickerId(), name: name || '表情', image: res.dataUrl });
  if (!sticker) { toast('表情格式不正确', 'error'); return; }
  state.emoticons.custom.push(sticker);
  persist();
  closeModal();
  state.directory.emojiOpen = true;
  state.directory.emojiTab = 'custom';
  renderActiveChat();
  toast('表情已添加');
}
// 表情包管理：删除 / 收藏
function manageStickersModal() {
  const emo = window.SunnyAPI.normalizeEmoticons(state.emoticons);
  const favs = emo.favorites;
  const list = emo.custom.map(s => `
    <div class="sticker-manage-item">
      <img src="${esc(s.image)}" alt="${esc(s.name)}" />
      <span class="sticker-manage-item__name">${esc(s.name)}</span>
      <button class="icon-btn" data-action="fav-sticker" data-id="${esc(s.id)}" title="${favs.indexOf(s.image) >= 0 ? '取消收藏' : '收藏'}">${icon('i-star', favs.indexOf(s.image) >= 0 ? 'is-fav' : '')}</button>
      <button class="icon-btn" data-action="delete-sticker" data-id="${esc(s.id)}" title="删除">${icon('i-trash')}</button>
    </div>`).join('') || '<p class="muted">还没有自定义表情，点「添加表情」上传。</p>';
  openModal({
    title:'管理表情包',
    body:`<div class="sticker-manage-list">${list}</div>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">关闭</button><button class="btn btn--primary" data-action="add-sticker">${icon('i-plus','icon--sm')} 添加表情</button>`,
  });
}
function deleteSticker(id) {
  state.emoticons = window.SunnyAPI.normalizeEmoticons(state.emoticons);
  const s = state.emoticons.custom.find(x => x.id === id);
  if (s) {
    state.emoticons.favorites = state.emoticons.favorites.filter(v => v !== s.image);
    state.emoticons.custom = state.emoticons.custom.filter(x => x.id !== id);
    persist();
    manageStickersModal();
    renderActiveChat();
    toast('表情已删除');
  }
}
function favSticker(id) {
  state.emoticons = window.SunnyAPI.normalizeEmoticons(state.emoticons);
  const s = state.emoticons.custom.find(x => x.id === id);
  if (!s) return;
  toggleEmojiFavorite(s.image);
  manageStickersModal();
}

/* ==========================================================================
   模块三点五：内部通话（语音 / 视频）
   --------------------------------------------------------------------------
   真实模式：getUserMedia + RTCPeerConnection + 云表 call_signals 交换信令，
   使用公共 STUN 服务器打洞；演示降级：无云端凭证 / 无摄像头权限 / 本地模式下
   用同一浏览器 localStorage 信令，走完整来电→接听→挂断流程（界面一致）。
   ========================================================================== */
const CALL_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const call = {
  active: false, callId: '', direction: '', type: 'voice', mode: 'demo',
  phase: 'idle', peerId: '', peerName: '', peerAvatar: '', peerColor: '',
  micOn: true, camOn: true, connectedAt: 0, timer: null,
  pc: null, localStream: null, remoteStream: null, pendingIce: [],
  pollTimer: null, sinceId: 0, ringTimer: null, lastSignalKinds: {},
};
function callStorageKey() {
  const base = (window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1';
  return base + ':call-signals';
}
function callModeNow() {
  const A = window.SunnyAPI;
  const secure = !!(window.isSecureContext || (typeof location !== 'undefined' && /^https:$/.test(location.protocol)));
  const media = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  const cloudReady = !!(state.cloudMode && !state.cloudStale && window.cloud);
  return A && A.callMode ? A.callMode({ cloudReady, secureContext: secure, mediaSupported: media }) : (cloudReady && secure && media ? 'real' : 'demo');
}
function callSignalInsert(row) {
  // row 不含 owner_id：数据库默认 auth.uid() 自动填充，防止伪造所属者
  return window.cloud.database.from('call_signals').insert(row);
}
async function sendCallSignal(kind, payload) {
  const A = window.SunnyAPI;
  const me = state.account;
  const signal = {
    call_id: call.callId, from_uid: String(me.id), from_name: me.name || '',
    to_uid: String(call.peerId), kind,
    payload: payload && typeof payload === 'object' ? JSON.stringify(payload) : (payload || ''),
  };
  if (call.mode === 'real' && window.cloud) {
    try {
      const { error } = await callSignalInsert(signal).select();
      if (error) { console.warn('[Sunshine个人工作站] 通话信令写入失败', error.message); return false; }
      return true;
    } catch (e) { console.warn('[Sunshine个人工作站] 通话信令写入异常', e && e.message); return false; }
  }
  // 演示降级：写入共享 localStorage，storage 事件通知同一浏览器其它标签
  try {
    const list = JSON.parse(localStorage.getItem(callStorageKey()) || '[]');
    list.push(Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), created_at: new Date().toISOString() }, signal));
    localStorage.setItem(callStorageKey(), JSON.stringify(list.slice(-200)));
    return true;
  } catch (e) { return false; }
}
async function pollCallSignals() {
  if (!call.active || !call.callId) return;
  let raw = [];
  if (call.mode === 'real' && window.cloud) {
    try {
      const { data, error } = await window.cloud.database.from('call_signals')
        .select('*').eq('call_id', call.callId).order('created_at', { ascending: true }).limit(200);
      if (error) return;
      raw = data || [];
    } catch (e) { return; }
  } else {
    try { raw = JSON.parse(localStorage.getItem(callStorageKey()) || '[]'); } catch (e) { raw = []; }
  }
  const A = window.SunnyAPI;
  const myUid = String(state.account.id);
  // 接收发给我自己的信令；主叫不处理自己发出的 invite/offer
  const mine = A && A.signalsFor ? A.signalsFor(raw, call.callId, myUid, 0)
    : raw.filter(s => s && s.call_id === call.callId && String(s.to_uid) === myUid);
  mine.forEach(handleCallSignal);
}
function startCallPolling() {
  stopCallPolling();
  call.pollTimer = setInterval(() => { pollCallSignals(); }, 1000);
}
function stopCallPolling() {
  if (call.pollTimer) { clearInterval(call.pollTimer); call.pollTimer = null; }
}
function handleCallSignal(s) {
  if (!s || !s.kind) return;
  // 去重：同一 id（或 kind+时间）的信令只处理一次，避免轮询重复触发
  const dedupKey = s.id || (s.kind + '|' + s.created_at);
  if (call.lastSignalKinds[dedupKey]) return;
  call.lastSignalKinds[dedupKey] = true;
  switch (s.kind) {
    case 'invite':
      if (call.phase === 'idle') showIncoming(s);
      break;
    case 'accept':
      if (call.direction === 'out' && (call.phase === 'calling' || call.phase === 'ringing')) {
        if (call.mode === 'real') connectAsCaller(); // 收到接听后再发 offer，避免被叫尚未就绪
        else onCallConnected();
      }
      break;
    case 'reject': case 'busy':
      if (call.direction === 'out') endCall('对方暂不便接听', true);
      break;
    case 'hangup':
      endCall(call.phase === 'connected' ? '对方已挂断' : '通话已结束', true);
      break;
    case 'offer':
      if (call.direction === 'in' && call.pc) handleOffer(JSON.parse(s.payload || '{}'));
      break;
    case 'answer':
      if (call.direction === 'out' && call.pc) handleAnswer(JSON.parse(s.payload || '{}'));
      break;
    case 'ice':
      if (call.pc) {
        const cand = JSON.parse(s.payload || 'null');
        if (cand) addRemoteIce(cand);
      }
      break;
  }
}

/* ---------- WebRTC 连接 ---------- */
function createPeer() {
  if (call.pc) return call.pc;
  const pc = new RTCPeerConnection({ iceServers: CALL_STUN });
  call.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate) sendCallSignal('ice', { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
  };
  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : (call.remoteStream || new MediaStream());
    call.remoteStream = stream;
    const v = $('#call-remote');
    if (v) {
      v.srcObject = stream;
      v.play().catch(() => {});
      // 只有视频通话才显示远端画面；语音通话保留头像、仅播放音频
      if (call.type === 'video') {
        v.classList.add('is-on');
        const stageAvatar = $('#call-stage-avatar'); if (stageAvatar) stageAvatar.classList.add('hidden');
        const badge = $('#call-remote-badge'); if (badge) badge.classList.remove('hidden');
      }
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') onCallConnected();
    else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (call.phase === 'calling' || call.phase === 'ringing') endCall('网络连接失败，已切换演示模式', true);
    }
  };
  return pc;
}
function attachLocalStream(stream) {
  call.localStream = stream;
  const pc = createPeer();
  (stream.getTracks() || []).forEach(track => {
    try { pc.addTrack(track, stream); } catch (e) { console.warn('[Sunshine个人工作站] 添加轨道失败', e && e.message); }
  });
  const v = $('#call-local');
  if (v) { v.srcObject = stream; v.play().catch(() => {}); }
  const box = $('#call-local-box'); if (box) box.classList.remove('is-hidden');
}
async function getUserMediaSafe(type) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  const wantVideo = type === 'video';
  const constraints = {
    audio: true,
    video: wantVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
  };
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    // 视频权限被拒时退化为纯音频，若音频也拒绝则返回 null（进入纯演示）
    if (wantVideo) { try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch (_) {} }
    return null;
  }
}
async function connectAsCaller() {
  try {
    const pc = createPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendCallSignal('offer', { sdp: pc.localDescription });
  } catch (e) {
    console.warn('[Sunshine个人工作站] 发起 Offer 失败', e && e.message);
    onCallConnected(); // 连接失败直接进演示通话，保证界面可用
  }
}
async function handleOffer(payload) {
  try {
    const pc = createPeer();
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp || payload));
    await flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendCallSignal('answer', { sdp: pc.localDescription });
    onCallConnected();
  } catch (e) { console.warn('[Sunshine个人工作站] 处理 Offer 失败', e && e.message); onCallConnected(); }
}
async function handleAnswer(payload) {
  try {
    const pc = createPeer();
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp || payload));
    await flushPendingIce();
    onCallConnected();
  } catch (e) { console.warn('[Sunshine个人工作站] 处理 Answer 失败', e && e.message); onCallConnected(); }
}
async function addRemoteIce(cand) {
  try {
    if (!call.pc || !call.pc.remoteDescription) { call.pendingIce.push(cand); return; }
    await call.pc.addIceCandidate(new RTCIceCandidate(cand));
  } catch (e) { console.warn('[Sunshine个人工作站] 添加 ICE 失败', e && e.message); }
}
async function flushPendingIce() {
  const list = call.pendingIce.slice(); call.pendingIce = [];
  for (const c of list) { try { await call.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
}

/* ---------- 通话发起 / 接听 / 挂断 ---------- */
async function startCall(type, peerId) {
  const A = window.SunnyAPI;
  const peer = findDirectoryMember(peerId) || state.users.find(m => String(m.id) === String(peerId));
  const check = A && A.canStartCall ? A.canStartCall(state.account, peer) : { ok: true };
  if (!check.ok) { toast(check.message || '无法发起通话', 'error'); return; }
  if (call.active) { toast('已有通话进行中', 'error'); return; }

  const mode = callModeNow();
  const id = A && A.newCallId ? A.newCallId() : ('call' + Date.now());
  Object.assign(call, {
    active: true, callId: id, direction: 'out', type: type || 'voice', mode,
    phase: 'calling', peerId: String(peerId), peerName: peer.name || '成员',
    peerAvatar: peer.avatar || (peer.name || '友').slice(0, 1), peerColor: peer.color || 'avatar--sky',
    micOn: true, camOn: true, connectedAt: 0, pc: null, localStream: null, remoteStream: null,
    pendingIce: [], sinceId: 0, lastSignalKinds: {},
  });
  renderCallLayer();
  startCallPolling();

  // 先尝试获取真实媒体（实时预览）；失败则降级为界面演示，流程照常
  const stream = await getUserMediaSafe(call.type);
  if (!call.active) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
  if (stream) attachLocalStream(stream);
  else { call.mode = 'demo'; renderCallLayer(); }

  await sendCallSignal('invite', { type: call.type, fromName: state.account.name });
  call.ringTimer = setTimeout(() => {
    if (call.phase === 'calling') endCall('对方暂时无应答', true);
  }, 45000);
}

function showIncoming(s) {
  let type = 'voice', fromName = s.from_name || '成员';
  try { const p = JSON.parse(s.payload || '{}'); if (p.type) type = p.type; if (p.fromName) fromName = p.fromName; } catch (e) {}
  const peer = findDirectoryMember(s.from_uid) || state.users.find(m => String(m.id) === String(s.from_uid));
  Object.assign(call, {
    active: true, callId: s.call_id, direction: 'in', type,
    mode: callModeNow(), phase: 'ringing', peerId: String(s.from_uid),
    peerName: peer ? peer.name : fromName,
    peerAvatar: peer ? (peer.avatar || peer.name.slice(0, 1)) : fromName.slice(0, 1),
    peerColor: peer ? (peer.color || 'avatar--sky') : 'avatar--sky',
    micOn: true, camOn: true, connectedAt: 0, pc: null, localStream: null, remoteStream: null,
    pendingIce: [], sinceId: 0, lastSignalKinds: {},
  });
  renderCallLayer();
  startCallPolling();
  call.ringTimer = setTimeout(() => { if (call.phase === 'ringing') endCall('未接听', true); }, 45000);
}

async function acceptCall() {
  if (call.phase !== 'ringing') return;
  clearTimeout(call.ringTimer); call.ringTimer = null;
  await sendCallSignal('accept', {});

  const stream = await getUserMediaSafe(call.type);
  if (!call.active) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
  if (stream) attachLocalStream(stream);
  else call.mode = 'demo';

  // 演示模式无真实连接，接听即进入通话；真实模式等待 offer/answer 与 ICE 连接状态
  if (call.mode !== 'real') onCallConnected();
}

async function rejectCall() {
  if (call.phase !== 'ringing') return;
  await sendCallSignal('reject', {});
  endCall('已拒绝', true);
}

function onCallConnected() {
  if (!call.active) return;
  clearTimeout(call.ringTimer); call.ringTimer = null;
  call.phase = 'connected';
  call.connectedAt = Date.now();
  renderCallLayer();
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    const el = $('#call-timer');
    if (el) {
      const A = window.SunnyAPI;
      el.textContent = A && A.formatCallDuration ? A.formatCallDuration(Date.now() - call.connectedAt) : formatSimple(Date.now() - call.connectedAt);
    }
  }, 1000);
}
function formatSimple(ms) {
  const t = Math.floor(ms / 1000);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function endCall(message, notifyPeer) {
  // 结束前生成一条通话活动通知记录（写入聊天记录）：已接通记通话时长，未接/拒接记未接来电
  if (call.active && call.peerId) {
    const wasConnected = call.phase === 'connected';
    const baseKind = call.type === 'video' ? 'video' : 'voice';
    const kind = wasConnected ? (call.type === 'video' ? 'video_call' : 'voice_call')
      : (call.type === 'video' ? 'video_missed' : 'voice_missed');
    let detail = '';
    if (wasConnected && call.connectedAt) {
      const A = window.SunnyAPI;
      detail = '通话时长 ' + (A && A.formatCallDuration ? A.formatCallDuration(Date.now() - call.connectedAt) : formatSimple(Date.now() - call.connectedAt));
    } else if (call.direction === 'out' && !wasConnected) {
      detail = '主叫未接通';
    }
    try { recordActivityEvent(kind, call.peerId, detail); } catch (e) {}
  }
  if (notifyPeer && call.active) sendCallSignal('hangup', {});
  // 清理所有资源
  stopCallPolling();
  clearInterval(call.timer); call.timer = null;
  clearTimeout(call.ringTimer); call.ringTimer = null;
  try { if (call.localStream) call.localStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (call.pc) call.pc.close(); } catch (e) {}
  const wasActive = call.active;
  Object.assign(call, {
    active: false, callId: '', phase: 'idle', peerId: '', pc: null,
    localStream: null, remoteStream: null, pendingIce: [], lastSignalKinds: {},
  });
  const root = $('#call-root'); if (root) root.innerHTML = '';
  if (wasActive && message) toast(message, 'info');
}

function toggleMic() {
  call.micOn = !call.micOn;
  if (call.localStream) call.localStream.getAudioTracks().forEach(t => { t.enabled = call.micOn; });
  renderCallControls();
}
function toggleCam() {
  call.camOn = !call.camOn;
  if (call.localStream) call.localStream.getVideoTracks().forEach(t => { t.enabled = call.camOn; });
  const box = $('#call-local-box');
  if (box) box.classList.toggle('is-hidden', !call.camOn || call.type !== 'video');
  renderCallControls();
}

/* ---------- 通话 UI 渲染 ---------- */
function renderCallLayer() {
  const root = $('#call-root');
  if (!root) return;
  const isVideo = call.type === 'video';
  const demoBadge = call.mode === 'demo' ? '<span class="call-layer__badge">演示模式</span>' : '<span class="call-layer__badge">加密通话</span>';
  const statusText = call.phase === 'calling' ? '正在呼叫…'
    : call.phase === 'ringing' ? '来电邀请'
    : call.phase === 'connected' ? '<span id="call-timer" class="call-timer">00:00</span>' : '';
  root.innerHTML = `
    <div class="call-layer" data-stop>
      <div class="call-layer__top">
        ${demoBadge}
        <button class="icon-btn" data-action="call-hangup" aria-label="挂断" style="color:#fff">${icon('i-minimize')}</button>
      </div>
      <div class="call-stage">
        <video id="call-remote" class="call-remote" autoplay playsinline></video>
        <div id="call-stage-avatar" class="call-avatar-stage">
          <div class="avatar ${esc(call.peerColor)}">${esc(call.peerAvatar)}</div>
          <h2>${esc(call.peerName)}</h2>
          <p>${statusText}</p>
          ${call.phase === 'connected' ? `<p class="muted" style="color:rgba(255,255,255,.55)">${isVideo ? '视频通话中' : '语音通话中'}</p>` : ''}
        </div>
        <span id="call-remote-badge" class="call-layer__badge hidden" style="position:absolute;top:12px;left:12px">${esc(call.peerName)}</span>
        ${isVideo ? `<div id="call-local-box" class="call-local ${call.camOn ? '' : 'is-hidden'}">
          <video id="call-local" autoplay playsinline muted></video>
          <div class="call-local__ph hidden">${icon('i-video-off','icon--sm')}</div>
          <span class="call-local__label">我</span>
        </div>` : ''}
      </div>
      <div id="call-controls-slot"></div>
      <p class="call-hint">${call.mode === 'demo' ? '演示模式：可控摄像头/麦克风与接听挂断，但不传输真实音视频' : '真实通话：需双方在线且网络环境良好'}</p>
    </div>
    ${call.phase === 'ringing' ? renderIncomingCard() : ''}`;
  renderCallControls();
  // 来电时本地视频预览也应显示
  if (call.localStream && $('#call-local')) { $('#call-local').srcObject = call.localStream; $('#call-local').play().catch(() => {}); }
}
function renderIncomingCard() {
  const isVideo = call.type === 'video';
  return `<div class="incoming-wrap" data-stop>
    <div class="incoming-card">
      <div class="incoming-card__pulse"><div class="avatar ${esc(call.peerColor)}" style="width:80px;height:80px">${esc(call.peerAvatar)}</div></div>
      <h2>${esc(call.peerName)}</h2>
      <p>${icon('i-phone-incoming','icon--sm')} 邀请你进行${isVideo ? '视频' : '语音'}通话</p>
      <div class="incoming-actions">
        <div class="call-ctrl-wrap"><button class="call-ctrl call-ctrl--hang" data-action="call-reject" aria-label="拒绝">${icon('i-phone-off')}</button><span class="call-ctrl-label">拒绝</span></div>
        <div class="call-ctrl-wrap"><button class="call-ctrl call-ctrl--answer" data-action="call-accept" aria-label="接听">${icon('i-phone')}</button><span class="call-ctrl-label">接听</span></div>
      </div>
    </div>
  </div>`;
}
function renderCallControls() {
  const slot = $('#call-controls-slot');
  if (!slot || !call.active) return;
  const connected = call.phase === 'connected';
  slot.innerHTML = `<div class="call-controls">
    <div class="call-ctrl-wrap"><button class="call-ctrl ${call.micOn ? '' : 'is-off'}" data-action="call-mic" aria-label="${call.micOn ? '关闭麦克风' : '开启麦克风'}">${icon(call.micOn ? 'i-mic' : 'i-mic-off')}</button><span class="call-ctrl-label">${call.micOn ? '静音' : '取消静音'}</span></div>
    ${call.type === 'video' ? `<div class="call-ctrl-wrap"><button class="call-ctrl ${call.camOn ? '' : 'is-off'}" data-action="call-cam" aria-label="${call.camOn ? '关闭摄像头' : '开启摄像头'}">${icon(call.camOn ? 'i-video' : 'i-video-off')}</button><span class="call-ctrl-label">${call.camOn ? '关摄像头' : '开摄像头'}</span></div>` : ''}
    <div class="call-ctrl-wrap"><button class="call-ctrl call-ctrl--hang" data-action="call-hangup" aria-label="挂断">${icon('i-phone-off')}</button><span class="call-ctrl-label">挂断</span></div>
  </div>`;
}

/* ==========================================================================
   模块三点六：消息通知中心（全员广播 / 授权发布）
   ========================================================================== */
function noticesSorted() {
  const A = window.SunnyAPI;
  return A && A.sortNotices ? A.sortNotices(state.notices) : state.notices.slice();
}
function noticeIsRead(n) {
  const A = window.SunnyAPI;
  if (A && A.noticeReadBy) return A.noticeReadBy(n, state.account && state.account.id);
  return !!n.read;
}
function renderNotices(main) {
  const canPublish = hasPerm('publish_notice');
  const list = noticesSorted();
  const unread = list.filter(n => !noticeIsRead(n)).length;
  main.innerHTML = `
    <div class="page notices-page">
      <div class="section-head">
        <div><div class="eyebrow">NOTICE CENTER · 消息通知</div><h2>消息通知中心</h2><p>查看全体成员广播通知${canPublish ? '，并可向所有成员发布新通知' : ''}。</p></div>
        <span class="tag" style="background:var(--sky-soft);color:var(--sky)">${icon('i-bell','icon--sm')} ${unread} 条未读</span>
      </div>
      ${canPublish ? `
      <div class="card notice-compose">
        <div class="notice-compose__head">${icon('i-plus','icon--sm')} 发布新通知</div>
        <div class="field"><label class="field__label" for="nt-title">通知标题</label>
          <input class="input" id="nt-title" maxlength="80" placeholder="例如：本周五下午开展消防安全演练" /></div>
        <div class="field-row">
          <div class="field"><label class="field__label" for="nt-kind">通知类型</label>
            <select class="select" id="nt-kind">
              <option value="notice">通知</option><option value="announcement">公告</option><option value="alert">提醒</option>
            </select></div>
          <div class="field"><label class="field__label" for="nt-audience">接收范围</label>
            <select class="select" id="nt-audience"><option value="all">全体成员</option></select></div>
        </div>
        <div class="field"><label class="field__label" for="nt-body">通知内容</label>
          <textarea class="textarea" id="nt-body" rows="3" maxlength="2000" placeholder="填写通知正文…"></textarea></div>
        <div class="notice-compose__foot">
          <label class="checkline"><input type="checkbox" id="nt-pinned" /> 置顶显示</label>
          <button class="btn btn--primary" data-action="notice-publish">${icon('i-send','icon--sm')} 发布给全体成员</button>
        </div>
      </div>` : ''}
      <div class="notice-list" id="notice-list">
        ${list.length ? list.map(n => renderNoticeCard(n)).join('') : `<div class="empty card"><div class="empty__art">${icon('i-bell','icon--xl')}</div><p>暂无通知</p><small>发布的广播通知会显示在这里，并送达所有成员。</small></div>`}
      </div>
    </div>`;
}
function renderNoticeCard(n) {
  const A = window.SunnyAPI;
  const read = noticeIsRead(n);
  const kindLabel = (A && A.NOTICE_KIND_LABELS && A.NOTICE_KIND_LABELS[n.kind]) || '通知';
  const canPublish = hasPerm('publish_notice');
  const isMine = String(n.owner_id) === String(state.account && state.account.id) || canPublish;
  return `<div class="notice-card ${read ? '' : 'is-unread'} ${n.pinned ? 'is-pinned' : ''}" data-action="notice-open" data-id="${esc(n.id)}">
    <div class="notice-card__ic notice-card__ic--${esc(n.kind)}">${icon(n.kind === 'alert' ? 'i-info' : n.kind === 'announcement' ? 'i-star' : 'i-bell')}</div>
    <div class="notice-card__body">
      <div class="notice-card__top"><span class="notice-card__kind">${kindLabel}</span>${n.pinned ? '<span class="notice-card__pin">置顶</span>' : ''}${!read ? '<span class="notice-card__new">NEW</span>' : ''}</div>
      <strong>${esc(n.title)}</strong>
      ${n.body ? `<p>${esc(n.body)}</p>` : ''}
      <div class="notice-card__meta"><span>${esc(n.author_name || '系统')}</span><span>·</span><span>${esc(formatNoticeTime(n.created_at))}</span></div>
    </div>
    ${isMine ? `<button class="notice-card__del" data-action="notice-delete" data-id="${esc(n.id)}" title="删除通知" aria-label="删除通知">${icon('i-trash','icon--sm')}</button>` : ''}
  </div>`;
}
function formatNoticeTime(iso) {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return String(iso || '');
  const diff = Date.now() - t.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
}
async function publishNotice() {
  if (!hasPerm('publish_notice')) { toast('当前账号无权发布通知', 'error'); return; }
  const title = ($('#nt-title')?.value || '').trim();
  const body = ($('#nt-body')?.value || '').trim();
  const kind = $('#nt-kind')?.value || 'notice';
  const audience = $('#nt-audience')?.value || 'all';
  const pinned = !!$('#nt-pinned')?.checked;
  if (!title) { toast('请填写通知标题', 'error'); return; }
  const A = window.SunnyAPI;
  const notice = {
    id: A.newNoticeId(), title, body, kind, audience, pinned,
    author_name: state.account.name || '', owner_id: String(state.account.id || ''),
    created_at: new Date().toISOString(), read_by: '[]',
  };
  // 先本地落盘并刷新（即时可见），再异步写云端
  state.notices.unshift(notice);
  persist();
  syncNoticesToNotifications();
  if (state.view === 'notices') renderNotices($('#main'));
  toast('通知已发布给全体成员');
  if (state.cloudMode && !state.cloudStale && window.cloud) {
    try {
      const row = { title, body, kind, audience, pinned, author_name: notice.author_name, read_by: '[]' };
      const { error } = await window.cloud.database.from('notices').insert(row).select();
      if (error) console.warn('[Sunshine个人工作站] 通知云端写入失败', error && error.message);
      else loadCloudNotices();
    } catch (e) { console.warn('[Sunshine个人工作站] 通知云端写入异常', e && e.message); }
  }
}
// 将广播通知汇总进顶栏铃铛（保留原有系统通知，去重合并）
function syncNoticesToNotifications() {
  const existing = new Set(state.notifications.filter(n => n.source === 'notice' && n.refId).map(n => n.refId));
  noticesSorted().forEach(n => {
    if (existing.has(String(n.id))) return;
    state.notifications.unshift({
      id: 'nn_' + n.id, source: 'notice', refId: String(n.id), icon: n.kind === 'alert' ? 'i-info' : 'i-bell',
      title: n.title, text: (n.body || '').slice(0, 60), time: formatNoticeTime(n.created_at),
      read: noticeIsRead(n),
    });
  });
}
async function loadCloudNotices() {
  if (!(state.cloudMode && !state.cloudStale && window.cloud)) return;
  try {
    const { data, error } = await window.cloud.database.from('notices').select('*').order('created_at', { ascending: false });
    if (error || !Array.isArray(data)) return;
    const A = window.SunnyAPI;
    state.notices = data.map(n => A.normalizeNotice(n)).filter(Boolean);
    syncNoticesToNotifications();
    persist();
    if (state.view === 'notices') renderNotices($('#main'));
    renderNotifications();
  } catch (e) { /* 静默：保持本地快照 */ }
}
async function openNotice(id) {
  const idx = state.notices.findIndex(n => String(n.id) === String(id));
  if (idx < 0) return;
  const A = window.SunnyAPI;
  state.notices[idx] = A.markNoticeRead(state.notices[idx], state.account && state.account.id);
  // 同步铃铛已读
  state.notifications.forEach(n => { if (n.source === 'notice' && String(n.refId) === String(id)) n.read = true; });
  persist();
  renderNotifications();
  if (state.view === 'notices') renderNotices($('#main'));
  // 云端回写 read_by（JSON 文本）
  if (state.cloudMode && !state.cloudStale && window.cloud) {
    try {
      const readBy = A.markNoticeRead(state.notices[idx], state.account.id).read_by;
      await window.cloud.database.from('notices').update({ read_by: JSON.stringify(readBy) }).eq('id', id).select();
    } catch (e) { /* 忽略 */ }
  }
}
async function deleteNotice(id) {
  if (!hasPerm('publish_notice')) { toast('无权删除通知', 'error'); return; }
  state.notices = state.notices.filter(n => String(n.id) !== String(id));
  state.notifications = state.notifications.filter(n => !(n.source === 'notice' && String(n.refId) === String(id)));
  persist();
  renderNotifications();
  if (state.view === 'notices') renderNotices($('#main'));
  if (state.cloudMode && !state.cloudStale && window.cloud) {
    try { await window.cloud.database.from('notices').delete().eq('id', id).select(); } catch (e) {}
  }
  toast('通知已删除', 'info');
}

/* ==========================================================================
   模块三点七：备份与还原（超管专属）
   备份目标：系统内部(localStorage) / NAS(WebDAV) / 本地电脑(下载)
   ========================================================================== */
function currentSnapshotForBackup() {
  // 汇总需要备份的数据域（与 API 层 buildBackup 的 domains 对齐）
  return {
    users: state.users, roles: state.roles, permissions: state.permissions,
    viewPerms: state.viewPerms, directoryMembers: state.directory.members,
    conversations: state.conversations, notifications: state.notifications,
    notices: state.notices, learning: state.learning, materials: state.materials,
    shares: state.shares, account: state.account, sessions: state.sessions,
  };
}
function backupJson(backup) { return JSON.stringify(backup, null, 2); }
function downloadBackupFile(backup) {
  const text = backupJson(backup);
  const blob = new Blob([text], { type:'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(backup.created_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `Sunshine个人工作站备份_${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return blob.size;
}
// 保存备份到系统内部：以独立 localStorage 键存入，保留最近 20 份
function saveBackupInternal(backup) {
  const KEY = 'sunny-classroom-backups';
  let list = [];
  try { list = JSON.parse(window.localStorage.getItem(KEY) || '[]'); if (!Array.isArray(list)) list = []; } catch (e) { list = []; }
  list.unshift(backup);
  list = list.slice(0, 20);
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); return { ok:true, count:list.length }; }
  catch (e) { return { ok:false, message:'系统内部存储空间不足' }; }
}
function listInternalBackups() {
  const KEY = 'sunny-classroom-backups';
  try { const l = JSON.parse(window.localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
}
function renderAdminBackup(c) {
  const A = window.SunnyAPI;
  const b = state.backup;
  const targets = A && A.BACKUP_TARGETS ? A.BACKUP_TARGETS : ['internal','nas','local'];
  const labels = A && A.BACKUP_TARGET_LABELS ? A.BACKUP_TARGET_LABELS : {};
  const last = b.lastBackupAt ? formatNoticeTime(b.lastBackupAt) : '从未备份';
  const internal = listInternalBackups();
  c.innerHTML = `
    <div class="backup-panel">
      <div class="card backup-card">
        <div class="backup-card__head">${icon('i-shield','icon--sm')} 数据备份与还原 <span class="tag" style="margin-left:auto;background:var(--berry-soft);color:var(--berry)">仅超级管理员</span></div>
        <p class="backup-hint">将账户、角色权限、通讯录、会话、资料、感悟、通知等数据打包为 JSON 快照。备份文件可保存到系统内部、NAS 或本地电脑，并支持从备份还原。</p>
        <div class="backup-status">
          <div><small>上次备份</small><strong>${esc(last)}</strong></div>
          <div><small>内部快照</small><strong>${internal.length} 份</strong></div>
          <div><small>自动备份</small><strong>${b.autoEnabled ? `开启 · 每 ${b.autoIntervalHours} 小时` : '关闭'}</strong></div>
        </div>
      </div>

      <div class="card backup-card">
        <div class="backup-card__head">${icon('i-download','icon--sm')} 立即备份</div>
        <div class="field"><label class="field__label" for="bk-label">备份备注</label>
          <input class="input" id="bk-label" maxlength="60" placeholder="例如：学期初全量备份" /></div>
        <div class="field"><label class="field__label">备份目标（可多选）</label>
          <div class="backup-targets">
            ${targets.map(t => `<label class="checkline backup-target"><input type="checkbox" class="bk-target" value="${t}" ${t === b.target ? 'checked' : ''}/> ${labels[t] || t}</label>`).join('')}
          </div>
        </div>
        <div class="field" id="bk-webdav-field"><label class="field__label">NAS / WebDAV 设置</label>
          <div class="backup-webdav">
            <input class="input" id="bk-dav-url" placeholder="WebDAV 地址，如 https://nas.local/webdav" value="${esc(b.webdav.url)}" />
            <input class="input" id="bk-dav-user" placeholder="账号" value="${esc(b.webdav.username)}" />
            <input class="input" id="bk-dav-pass" type="password" placeholder="密码" value="${esc(b.webdav.password)}" />
            <input class="input" id="bk-dav-path" placeholder="远程目录（可选），如 /backups" value="${esc(b.webdav.remotePath)}" />
          </div>
          <small class="field__hint">需 NAS 开启 WebDAV 且允许跨域(CORS)；上传失败时会自动改为下载备份文件，你可手动存入 NAS。</small>
        </div>
        <div class="backup-actions">
          <button class="btn btn--primary" data-action="backup-now">${icon('i-download','icon--sm')} 生成并保存备份</button>
        </div>
        <div id="backup-result" class="backup-result"></div>
      </div>

      <div class="card backup-card">
        <div class="backup-card__head">${icon('i-clock','icon--sm')} 定时自动备份</div>
        <p class="backup-hint">页面保持打开时，按设定间隔自动备份到系统内部。关闭页面期间不会执行。</p>
        <div class="field-row">
          <label class="checkline"><input type="checkbox" id="bk-auto" ${b.autoEnabled ? 'checked' : ''}/> 启用自动备份</label>
          <div class="field"><label class="field__label" for="bk-interval">间隔（小时）</label>
            <input class="input" id="bk-interval" type="number" min="1" max="720" value="${b.autoIntervalHours}" /></div>
        </div>
        <div class="backup-actions"><button class="btn btn--ghost" data-action="backup-save-schedule">保存定时设置</button></div>
      </div>

      <div class="card backup-card">
        <div class="backup-card__head">${icon('i-file','icon--sm')} 备份记录</div>
        ${internal.length ? `<div class="backup-list">${internal.map(bk => `
          <div class="backup-item">
            <div class="backup-item__ic">${icon('i-file')}</div>
            <div class="backup-item__meta"><strong>${esc(bk.label || '备份')}</strong>
              <small>${esc(formatNoticeTime(bk.created_at))} · ${esc(A && A.formatBackupSize ? A.formatBackupSize(backupJson(bk).length) : (backupJson(bk).length + ' B'))}</small></div>
            <div class="backup-item__acts">
              <button class="btn btn--ghost btn--sm" data-action="backup-download" data-id="${esc(bk.backupId)}">${icon('i-download','icon--sm')} 下载</button>
              <button class="btn btn--primary btn--sm" data-action="backup-restore" data-id="${esc(bk.backupId)}">${icon('i-refresh','icon--sm')} 还原</button>
              <button class="btn btn--ghost btn--sm" data-action="backup-delete" data-id="${esc(bk.backupId)}" title="删除">${icon('i-trash','icon--sm')}</button>
            </div>
          </div>`).join('')}</div>` : `<div class="empty" style="padding:var(--s6)"><p>暂无内部备份</p></div>`}
      </div>

      <div class="card backup-card">
        <div class="backup-card__head">${icon('i-refresh','icon--sm')} 从文件还原</div>
        <p class="backup-hint">选择此前下载的备份 JSON 文件，校验后确认还原。还原会覆盖当前数据，请先做好现有数据备份。</p>
        <div class="backup-actions">
          <input type="file" id="bk-file" accept="application/json,.json" class="file-input" />
          <button class="btn btn--ghost" data-action="backup-restore-file">${icon('i-file','icon--sm')} 选择文件并还原</button>
        </div>
      </div>
    </div>`;
  refreshBackupTargetFields();
}
function refreshBackupTargetFields() {
  const wrap = $('#bk-webdav-field');
  if (!wrap) return;
  const nasChecked = !!($('.bk-target[value="nas"]') && $('.bk-target[value="nas"]').checked);
  wrap.style.display = nasChecked ? '' : 'none';
}
async function runBackupNow() {
  const A = window.SunnyAPI;
  const label = ($('#bk-label')?.value || '').trim() || '手动备份';
  const targets = Array.from(document.querySelectorAll('.bk-target:checked')).map(el => el.value);
  if (!targets.length) { toast('请至少选择一个备份目标', 'error'); return; }
  const cfg = A.normalizeWebDavConfig({
    url: $('#bk-dav-url')?.value, username: $('#bk-dav-user')?.value,
    password: $('#bk-dav-pass')?.value, remotePath: $('#bk-dav-path')?.value,
  });
  state.backup.webdav = cfg;
  state.backup.target = targets[0];
  const backup = A.buildBackup(currentSnapshotForBackup(), { label, targets });
  const result = [];
  let downloaded = false;
  for (const t of targets) {
    if (t === 'internal') {
      const r = saveBackupInternal(backup);
      result.push(r.ok ? '系统内部 ✓' : '系统内部 ✗ ' + (r.message || ''));
    } else if (t === 'local') {
      const size = downloadBackupFile(backup);
      downloaded = true;
      result.push('本地下载 ✓ ' + (A.formatBackupSize ? A.formatBackupSize(size) : ''));
    } else if (t === 'nas') {
      if (!A.isValidWebDavUrl(cfg.url)) { result.push('NAS ✗ 地址无效'); continue; }
      const ok = await uploadBackupToWebDav(backup, cfg);
      if (ok) result.push('NAS(WebDAV) ✓');
      else { downloadBackupFile(backup); downloaded = true; result.push('NAS ✗ 上传失败，已改为下载备份文件（请手动存入 NAS）'); }
    }
  }
  state.backup.lastBackupAt = backup.created_at;
  state.backup.history.unshift({ id: backup.backupId, label, at: backup.created_at, targets });
  state.backup.history = state.backup.history.slice(0, 50);
  persist();
  renderAdminBackup($('#admin-content'));
  toast('备份完成：' + result.join('，'), downloaded ? 'info' : 'success');
}
// WebDAV PUT 上传；返回是否成功。PUT 目标 = url + remotePath + 文件名
async function uploadBackupToWebDav(backup, cfg) {
  try {
    const text = backupJson(backup);
    const stamp = new Date(backup.created_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `Sunshine个人工作站备份_${stamp}.json`;
    const base = cfg.remotePath ? cfg.url + '/' + cfg.remotePath.replace(/^\/+/, '') : cfg.url;
    const target = base + '/' + encodeURIComponent(fileName);
    const headers = { 'Content-Type':'application/json;charset=utf-8' };
    if (cfg.username) headers['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(cfg.username + ':' + cfg.password)));
    const res = await fetch(target, { method:'PUT', headers, body:text, mode:'cors' });
    return res.ok || res.status === 201 || res.status === 204;
  } catch (e) { return false; }
}
function saveBackupSchedule() {
  state.backup.autoEnabled = !!$('#bk-auto')?.checked;
  state.backup.autoIntervalHours = Math.min(720, Math.max(1, Number($('#bk-interval')?.value) || 24));
  persist();
  restartBackupTimer();
  toast(state.backup.autoEnabled ? `已开启自动备份，每 ${state.backup.autoIntervalHours} 小时一次` : '已关闭自动备份');
  renderAdminBackup($('#admin-content'));
}
let backupTimer = null;
function restartBackupTimer() {
  clearInterval(backupTimer); backupTimer = null;
  if (!state.backup.autoEnabled) return;
  const ms = Math.max(1, Number(state.backup.autoIntervalHours) || 24) * 3600 * 1000;
  backupTimer = setInterval(() => {
    if (!state.authed || state.role !== 'admin') return;
    const A = window.SunnyAPI;
    const backup = A.buildBackup(currentSnapshotForBackup(), { label:'自动备份', targets:['internal'] });
    saveBackupInternal(backup);
    state.backup.lastBackupAt = backup.created_at;
    persist();
    if (state.view === 'admin' && state.admin.tab === 'backup') renderAdminBackup($('#admin-content'));
  }, ms);
}
function confirmRestore(backup) {
  const A = window.SunnyAPI;
  const v = A.validateBackup(backup);
  if (!v.ok) { toast(v.message, 'error'); return; }
  openModal({
    title:'确认还原备份',
    body:`<div class="restore-confirm">
      <p>即将用以下备份覆盖当前数据，此操作不可撤销：</p>
      <div class="restore-confirm__meta"><span>备份备注</span><strong>${esc(backup.label || (v.data && v.data.label) || '备份')}</strong></div>
      <div class="restore-confirm__meta"><span>备份时间</span><strong>${esc(formatNoticeTime(backup.created_at))}</strong></div>
      <div class="restore-confirm__meta"><span>数据域</span><strong>${Object.keys(backup.data || {}).length} 项</strong></div>
      <p class="restore-confirm__warn">${icon('i-info','icon--sm')} 建议先对当前数据做一次备份，再执行还原。</p>
    </div>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="backup-restore-confirm">确认还原</button>`,
  });
  window.__pendingRestoreBackup = backup;
}
function applyRestore() {
  const backup = window.__pendingRestoreBackup;
  if (!backup || !backup.data) { toast('没有待还原的备份', 'error'); return; }
  const d = backup.data;
  const S = window.SunnyStore;
  if (!S) { toast('本地存储不可用', 'error'); return; }
  // 将备份中的数据域写回本地存储（覆盖当前），随后重载应用使生效
  S.save(d);
  window.__pendingRestoreBackup = null;
  closeModal();
  toast('还原成功，正在重新加载…');
  setTimeout(() => { try { location.reload(); } catch (e) {} }, 600);
}
async function restoreFromFile() {
  const input = $('#bk-file');
  const file = input && input.files && input.files[0];
  if (!file) { toast('请先选择备份文件', 'error'); return; }
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    confirmRestore(backup);
  } catch (e) { toast('备份文件解析失败', 'error'); }
}

/* ==========================================================================
   模块四：超级管理员后台
   ========================================================================== */
const ROLE_META = {
  admin:{ label:'超级管理员', cls:'role-tag--admin' }, teacher:{ label:'教师', cls:'role-tag--teacher' },
  headteacher:{ label:'班级主任', cls:'role-tag--teacher' },
  student:{ label:'学生', cls:'role-tag--student' }, parent:{ label:'家长', cls:'role-tag--parent' },
};
// 内置角色用短名，自定义角色用 r_ 开头的 id；统一映射为展示信息
function roleViewOf(role) {
  const builtin = { admin:'r_admin', teacher:'r_teacher', headteacher:'r_headteacher', student:'r_student', parent:'r_parent' };
  if (builtin[role]) return ROLE_META[role];
  const custom = state.roles.find(r => r.id === role);
  if (!custom) return ROLE_META.student;
  const clsMap = { berry:'role-tag--admin', sky:'role-tag--teacher', mint:'role-tag--student', sun:'role-tag--parent' };
  return { label: custom.name, cls: clsMap[custom.color] || 'role-tag--student' };
}
// 角色下拉值：内置角色保持短名（兼容历史数据），自定义角色保留 r_ id
function roleOptions(selected) {
  const builtin = { r_admin:'admin', r_teacher:'teacher', r_headteacher:'headteacher', r_student:'student', r_parent:'parent' };
  return state.roles.map(r => {
    const val = builtin[r.id] || r.id;
    return `<option value="${esc(val)}" ${selected === val ? 'selected' : ''}>${esc(r.name)}</option>`;
  }).join('');
}
// 部门 / 身份下拉：内置选项含「学生家长」；历史自由文本保留在首位以兼容旧数据
function deptOptions(role, current) {
  const list = Array.isArray(DEPARTMENT_OPTIONS) ? DEPARTMENT_OPTIONS.slice() : [];
  if (role === 'parent' && list.indexOf('学生家长') < 0) list.unshift('学生家长');
  const value = String(current == null ? '' : current).trim().slice(0, 40);
  if (value && list.indexOf(value) < 0) list.unshift(value);
  return `<option value="">未设置</option>` + list.map(d =>
    `<option value="${esc(d)}" ${value === d ? 'selected' : ''}>${esc(d)}</option>`
  ).join('');
}

// 班级多选框：1–6 年级 × 1–3 班，可多选；班级主任据此获得对应班级课程表编辑权
function classOptionsHTML(selected) {
  const chosen = Array.isArray(selected) ? selected : [];
  let out = '';
  for (let g = 1; g <= 6; g++) {
    out += `<div class="class-check-group"><span class="class-check-group__label">${gradeLabel(g)}</span><div class="class-check-row">`;
    for (let c = 1; c <= 3; c++) {
      const key = `${g}-${c}班`;
      out += `<label class="class-check"><input type="checkbox" data-managed-class value="${key}" ${chosen.indexOf(key) >= 0 ? 'checked' : ''} /> ${c}班</label>`;
    }
    out += `</div></div>`;
  }
  return out;
}

/* ==========================================================================
   模块：课程表（各年级各班级独立配置，班级主任可编辑其管理班级）
   ========================================================================== */
function scheduleClasses() {
  // 可查看的班级：超管/教师看全部；班级主任看其管理班级；学生按其年级；家长看全部
  const all = [];
  for (let g = 1; g <= 6; g++) for (let c = 1; c <= 3; c++) all.push(`${g}-${c}班`);
  const account = state.account || {};
  if (account.role === 'headteacher' || account.role === 'r_headteacher') {
    const managed = window.SunnyAPI.normalizeManagedClasses(account.managedClasses);
    return managed.length ? managed : all;
  }
  return all;
}
function scheduleCurrentClass() {
  const classes = scheduleClasses();
  const chosen = state.workspaceScheduleClass;
  return classes.indexOf(chosen) >= 0 ? chosen : (classes[0] || '1-1班');
}
function scheduleEditable(classKey) {
  return hasPerm('manage_schedule') && window.SunnyAPI.canManageClass(state.account, classKey);
}
function renderSchedule(main) {
  const classes = scheduleClasses();
  const classKey = scheduleCurrentClass();
  const editable = scheduleEditable(classKey);
  const parsed = parseClassKey(classKey) || { grade:1, className:'1班' };
  const savedSlots = sortScheduleSlotsLocal(state.schedules.filter(s => s.classKey === classKey));
  // 云端与本地都没有数据时，用内置作息模板兜底展示，避免登录后看到空白课程表
  const slots = savedSlots.length ? savedSlots : window.SunnyAPI.buildScheduleTemplate(parsed.grade, parsed.className);
  state.scheduleDisplaySlots = slots; // 内存展示缓存（不落盘）：供编辑弹窗带出模板默认内容
  const WEEKDAYS = window.SunnyAPI.WEEKDAYS, PERIODS = window.SunnyAPI.SCHEDULE_PERIODS;
  main.innerHTML = `
    <div class="page schedule-page">
      <div class="section-head">
        <div><div class="eyebrow">CLASS SCHEDULE · 课程安排</div><h2>课程表</h2><p>按班级查看每周课程，内置通用作息模板可由班级主任逐节调整。</p></div>
        <div class="section-head__actions">
          <button class="btn btn--ghost" data-action="schedule-print" data-class="${esc(classKey)}">${icon('i-print','icon--sm')} 打印 / PDF</button>
          ${editable ? `<button class="btn btn--primary" data-action="schedule-init" data-class="${esc(classKey)}">${icon('i-sparkles','icon--sm')} 套用模板</button>` : ''}
        </div>
      </div>
      <div class="filterbar">
        <div class="filterbar__group"><label class="field__label">选择班级</label>
          <select class="select" id="schedule-class">${classes.map(k => `<option value="${esc(k)}" ${k===classKey?'selected':''}>${gradeLabel(parseClassKey(k)?.grade)} ${parseClassKey(k)?.className}</option>`).join('')}</select>
        </div>
        <div class="filterbar__group"><span class="tag">${esc(gradeLabel(parsed.grade))} · ${esc(parsed.className)}</span></div>
      </div>
      <div class="table-wrap schedule-wrap">
        <table class="table schedule-table">
          <thead><tr><th class="schedule-period-col">节次 / 时间</th>${WEEKDAYS.map(d => `<th>${d.label}</th>`).join('')}</tr></thead>
          <tbody>
            ${PERIODS.map(p => `<tr>
              <td class="schedule-period-col"><b>${p.label}</b><span class="schedule-time">${esc(p.time)}</span></td>
              ${WEEKDAYS.map(d => {
                const slot = slotAtLocal(slots, d.key, p.period);
                return `<td class="schedule-cell ${slot && slot.subject ? 'has-course' : ''}" ${editable ? `data-action="schedule-edit" data-class="${esc(classKey)}" data-day="${d.key}" data-period="${p.period}"` : ''}>
                  ${slot && slot.subject ? `<b>${esc(slot.subject)}</b><span class="schedule-teacher">${esc(slot.teacher || '待定教师')}</span>${slot.remark ? `<span class="schedule-remark">${esc(slot.remark)}</span>` : ''}`
                    : `<span class="muted">${editable ? '+ 添加' : '—'}</span>`}
                </td>`;
              }).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="field__hint">${editable ? '点击任意节次可编辑课程、任课教师与备注；「套用模板」会补齐未设置的节次，不会覆盖已有课程。' : '仅班级主任（管理该班级）或超级管理员可修改课程表。'}</p>
    </div>`;
  const sel = $('#schedule-class');
  if (sel) sel.addEventListener('change', e => {
    state.workspaceScheduleClass = e.target.value;
    renderSchedule($('#main'));
    loadScheduleCloud(e.target.value);
  });
  loadScheduleCloud(classKey);
}
function sortScheduleSlotsLocal(list) {
  return window.SunnyAPI.sortScheduleSlots(list);
}
function slotAtLocal(slots, day, period) {
  return window.SunnyAPI.slotAt(slots, day, period);
}
async function loadScheduleCloud(classKey) {
  if (!state.cloudMode || !window.SunnyAPI || !window.SunnyAPI.listSchedules) return;
  const res = await window.SunnyAPI.listSchedules(classKey);
  if (res.ok && Array.isArray(res.data)) {
    // 云端无该班数据时保留本地内容（可能来自跨设备同步/尚未上传的编辑），避免被空结果清空
    if (res.data.length) {
      const others = state.schedules.filter(s => s.classKey !== classKey);
      state.schedules = others.concat(res.data);
    }
    if (state.view === 'schedule') renderSchedule($('#main'));
  }
}
function scheduleEditModal(classKey, weekday, period) {
  // 优先取已保存节次；若当前展示的是内置模板，则从展示缓存带出模板默认内容
  const saved = slotAtLocal(state.schedules.filter(s => s.classKey === classKey), weekday, period);
  const slot = saved || slotAtLocal(state.scheduleDisplaySlots || [], weekday, period);
  const parsed = parseClassKey(classKey) || { grade:1 };
  const teachers = state.users.filter(u => u.status !== 'disabled' && (u.role === 'teacher' || u.role === 'headteacher' || u.role === 'admin'));
  const subjects = window.SunnyAPI.SUBJECTS_BY_GRADE[parsed.grade] || window.SunnyAPI.SUBJECTS_BY_GRADE[1];
  openModal({
    title: `编辑课程 · ${gradeLabel(parsed.grade)} ${parsed.className} · ${window.SunnyAPI.WEEKDAYS.find(d=>d.key===Number(weekday))?.label} 第${period}节`,
    body: `
      <div class="field"><label class="field__label" for="sl-subject">课程</label>
        <select class="select" id="sl-subject">${subjects.map(s => `<option value="${esc(s)}" ${slot?.subject===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="field"><label class="field__label" for="sl-teacher">当科老师</label>
        <select class="select" id="sl-teacher"><option value="">待定</option>${teachers.map(t => `<option value="${esc(t.name)}" data-uid="${esc(t.id)}" ${slot?.teacher===t.name?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="field__label" for="sl-time">上课时间</label><input class="input" id="sl-time" value="${esc(slot?.time || (window.SunnyAPI.SCHEDULE_PERIODS[Number(period)-1]||{}).time || '')}" /></div>
      <div class="field"><label class="field__label" for="sl-remark">备注</label><input class="input" id="sl-remark" value="${esc(slot?.remark||'')}" maxlength="120" placeholder="如：实验室上课 / 单元测试（选填）" /></div>
      <span class="field__error" id="sl-err"></span>`,
    footer: `${slot ? `<button class="btn btn--ghost" data-action="schedule-delete" data-id="${esc(slot.id)}">删除本节</button>` : ''}
      <button class="btn btn--primary" data-action="schedule-save" data-class="${esc(classKey)}" data-day="${weekday}" data-period="${period}" data-id="${esc(slot?.id||'')}">保存</button>`,
  });
}
async function scheduleSave(classKey, weekday, period, id) {
  const err = $('#sl-err'); if (err) err.textContent = '';
  const teacherSel = $('#sl-teacher');
  const selectedOpt = teacherSel && teacherSel.selectedOptions[0];
  const payload = {
    id: id || window.SunnyAPI.newSlotId(), classKey, weekday:Number(weekday), period:Number(period),
    subject: $('#sl-subject')?.value || '', teacher: teacherSel?.value || '',
    teacherId: selectedOpt ? (selectedOpt.getAttribute('data-uid') || '') : '',
    time: $('#sl-time')?.value.trim() || '', remark: $('#sl-remark')?.value.trim() || '',
  };
  if (!window.SunnyAPI.canManageClass(state.account, classKey)) {
    if (err) err.textContent = '您无权修改该班级课程表';
    return;
  }
  if (!state.cloudMode) {
    // 本地模式：仅写入本地状态与存储（本地演示无云端账户）
    const slot = window.SunnyAPI.normalizeScheduleSlot(payload);
    state.schedules = state.schedules.filter(s => !(s.classKey===classKey && s.weekday===Number(weekday) && s.period===Number(period)));
    state.schedules.push(slot);
    persist(); closeModal(); renderSchedule($('#main')); toast('课程表已保存（本地）'); return;
  }
  const btn = $('[data-action="schedule-save"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = await window.SunnyAPI.saveScheduleSlot(payload);
    if (!res.ok) { if (err) err.textContent = res.message; toast(res.message, 'error'); return; }
    const slot = window.SunnyAPI.normalizeScheduleSlot(payload);
    state.schedules = state.schedules.filter(s => !(s.classKey===classKey && s.weekday===Number(weekday) && s.period===Number(period)));
    state.schedules.push(slot);
    persist(); closeModal(); renderSchedule($('#main')); toast('课程表已保存');
  } catch (e) { if (err) err.textContent = '保存失败，请检查网络'; toast('保存失败，请检查网络', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '保存'; } }
}
async function scheduleDelete(id) {
  if (!confirm('确定删除这一节课程吗？')) return;
  if (state.cloudMode) {
    const res = await window.SunnyAPI.deleteScheduleSlot(id);
    if (!res.ok) { toast(res.message, 'error'); return; }
  }
  state.schedules = state.schedules.filter(s => s.id !== id);
  persist(); closeModal(); renderSchedule($('#main')); toast('已删除该节课程');
}
function scheduleInitTemplate(classKey) {
  if (!window.SunnyAPI.canManageClass(state.account, classKey)) { toast('您无权修改该班级课程表', 'error'); return; }
  const parsed = parseClassKey(classKey) || { grade:1, className:'1班' };
  const template = window.SunnyAPI.buildScheduleTemplate(parsed.grade, parsed.className);
  let added = 0;
  template.forEach(slot => {
    const exists = slotAtLocal(state.schedules.filter(s => s.classKey === classKey), slot.weekday, slot.period);
    if (!exists && state.cloudMode) {
      // 云端仅补写尚未设置的节次
      window.SunnyAPI.saveScheduleSlot(slot);
      state.schedules.push(slot); added++;
    } else if (!exists) { state.schedules.push(slot); added++; }
  });
  persist(); renderSchedule($('#main'));
  toast(added ? `已套用模板，补齐 ${added} 节课程` : '课程表已完整，无需补充');
}
function printSchedule(classKey) {
  const parsed = parseClassKey(classKey) || { grade:1, className:'1班' };
  const saved = sortScheduleSlotsLocal(state.schedules.filter(s => s.classKey === classKey));
  const slots = saved.length ? saved : window.SunnyAPI.buildScheduleTemplate(parsed.grade, parsed.className);
  const html = window.SunnyAPI.buildSchedulePrintHtml({
    slots, classKey,
    gradeLabel: gradeLabel(parsed.grade),
    className: parsed.className,
    printedAt: new Date(),
  });
  // 通过隐藏 iframe 打印，避免依赖弹窗；打印对话框可选「另存为 PDF」
  let frame = document.getElementById('schedule-print-frame');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'schedule-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:0;';
    document.body.appendChild(frame);
  }
  const doc = frame.contentWindow && frame.contentWindow.document;
  if (!doc) { toast('打印窗口不可用，请检查浏览器设置', 'error'); return; }
  doc.open(); doc.write(html); doc.close();
  const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { toast('打印失败，请检查浏览器设置', 'error'); } };
  if (doc.readyState === 'complete') setTimeout(go, 120); else frame.addEventListener('load', go, { once:true });
}

function renderAdmin(main) {
  const tab = state.admin.tab;
  main.innerHTML = `
    <div class="page">
      <div class="section-head">
        <div><div class="eyebrow">ADMIN CONSOLE · 管理中心</div><h2>超级管理员后台</h2><p>实时监测平台动态，管理用户、学习资料与角色权限。</p></div>
        <div class="section-head__actions">
          <button class="btn btn--soft btn--sm" id="btn-realtime-sync" data-action="realtime-sync" title="与云端校验并同步所有数据，确保各端一致">${icon('i-refresh','icon--sm')} 实时同步</button>
          <span class="tag" style="background:var(--berry-soft);color:var(--berry)">${icon('i-shield','icon--sm')} 超级管理员</span>
        </div>
      </div>
      <div id="realtime-sync-bar" class="realtime-sync-bar hidden"></div>
      <div class="roles-tabs">
        ${[['monitor','实时监测'],['overview','数据概括'],['users','人员管理'],['materials','资料管理'],['roles','角色权限'],['backup','备份管理']].map(([k,l]) => `<button class="chip ${tab === k ? 'is-active' : ''}" data-action="admin-tab" data-tab="${k}">${l}</button>`).join('')}
      </div>
      <div id="admin-content"></div>
    </div>`;
  renderRealtimeSyncBar(); // 重渲染后台时保留同步状态条
  const c = $('#admin-content');
  if (tab === 'monitor') renderAdminMonitor(c);
  else if (tab === 'overview') renderAdminOverview(c);
  else if (tab === 'users') renderAdminUsers(c);
  else if (tab === 'materials') renderAdminMaterials(c);
  else if (tab === 'backup') renderAdminBackup(c);
  else renderAdminRoles(c);
}

/* ---------- 实时监测面板（自动刷新） ---------- */
function renderAdminMonitor(c) {
  const stats = window.SunnyAPI.getRealtimeStats();
  if (!stats.ok) { c.innerHTML = `<div class="empty card"><p>${esc(stats.message)}</p></div>`; return; }
  const d = stats.data;
  const hourMax = Math.max(1, ...d.hourly.map(h => Math.max(h.users, h.msgs)));
  c.innerHTML = `
    <div class="panel" style="margin-bottom:var(--s5)">
      <div class="panel__head">
        <div><h3>今日实时动态 <span class="live-badge"><span class="live-dot"></span>实时</span></h3><small>平台用户活跃情况与消息互动监测</small></div>
        <div class="row">
          <span class="muted" style="font-size:var(--fs-xs)" id="monitor-updated">更新于 ${esc(new Date(d.updatedAt).toLocaleTimeString('zh-CN',{hour12:false}))}</span>
          <button class="btn btn--ghost btn--sm" data-action="monitor-refresh">${icon('i-refresh','icon--sm')} 刷新</button>
          <button class="btn ${state.admin.monitorAuto ? 'btn--soft' : 'btn--ghost'} btn--sm" data-action="monitor-toggle">${state.admin.monitorAuto ? '自动刷新：开' : '自动刷新：关'}</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-card__top"><span class="stat-card__ic" style="background:var(--mint-soft);color:var(--mint)">${icon('i-users')}</span><span class="stat-card__trend stat-card__trend--up">${esc(d.activeTrend)}</span></div>
          <div class="stat-card__num">${d.todayActive}</div><div class="stat-card__label">今日活跃用户</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__top"><span class="stat-card__ic" style="background:var(--lilac-soft);color:var(--lilac)">${icon('i-message')}</span><span class="stat-card__trend stat-card__trend--up">${esc(d.messageTrend)}</span></div>
          <div class="stat-card__num">${d.todayMessages}</div><div class="stat-card__label">今日消息互动</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__top"><span class="stat-card__ic" style="background:var(--sun-soft);color:#96701C">${icon('i-heart')}</span><span class="stat-card__trend">${d.shareInteractions}</span></div>
          <div class="stat-card__num">${d.todayShares}</div><div class="stat-card__label">今日感悟 / 点赞</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__top"><span class="stat-card__ic" style="background:var(--sky-soft);color:var(--sky)">${icon('i-activity')}</span><span class="stat-card__trend stat-card__trend--up"><span class="dot"></span> 在线</span></div>
          <div class="stat-card__num">${d.onlineNow}</div><div class="stat-card__label">当前在线用户</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel__head"><div><h3>实时变化趋势</h3><small>按时段统计 · 活跃用户与消息互动</small></div>
        <div class="legend"><span><i style="background:var(--brand)"></i>活跃用户</span><span><i style="background:var(--sky)"></i>消息互动</span></div>
      </div>
      <div class="chart-bars chart-bars--monitor">
        ${d.hourly.map(h => `<div class="chart-bar">
          <div style="display:flex;gap:4px;width:100%;height:100%;align-items:flex-end;justify-content:center">
            <div class="chart-bar__fill" style="height:${Math.round(h.users/hourMax*100)}%" title="活跃 ${h.users}"></div>
            <div class="chart-bar__fill chart-bar__fill--alt" style="height:${Math.round(h.msgs/hourMax*100)}%" title="互动 ${h.msgs}"></div>
          </div><span>${h.label}</span>
        </div>`).join('')}
      </div>
      <p class="field__hint" style="margin-top:var(--s4)">数据基于本地演示会话实时计算；${state.cloudMode ? '当前为云端账号，感悟互动数据来自云端同步。' : '演示模式下按账户与站内消息样本统计。'}</p>
    </div>`;
  startMonitorTimer();
}

function stopMonitorTimer() {
  if (state.admin.monitorTimer) { clearInterval(state.admin.monitorTimer); state.admin.monitorTimer = null; }
}
function startMonitorTimer() {
  stopMonitorTimer();
  if (!state.admin.monitorAuto || state.admin.tab !== 'monitor' || state.view !== 'admin') return;
  state.admin.monitorTimer = setInterval(() => {
    if (state.admin.tab !== 'monitor' || state.view !== 'admin') { stopMonitorTimer(); return; }
    const c = $('#admin-content');
    if (!c) { stopMonitorTimer(); return; }
    const active = document.activeElement;
    const typing = active && ['INPUT','TEXTAREA'].includes(active.tagName);
    if (typing) return; // 不打断用户正在输入
    renderAdminMonitor(c);
  }, 5000);
}

/* ---------- 资料管理（走接口层） ---------- */
function renderAdminMaterials(c) {
  const q = state.admin.materialQuery.trim().toLowerCase();
  const res = window.SunnyAPI.listMaterials({ query: q });
  const list = res.ok ? res.data.items : [];
  c.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div><h3>学习资料管理 <span class="muted" style="font-size:var(--fs-sm)">(${list.length})</span></h3><small>新增、编辑与删除平台学习资料</small></div>
        <div class="row"><div class="search-sm" style="width:240px">${icon('i-search')}<input id="material-search" type="search" placeholder="搜索资料…" value="${esc(state.admin.materialQuery)}" /></div>
        <button class="btn btn--primary btn--sm" data-action="add-material">${icon('i-plus','icon--sm')} 新建资料</button></div>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th scope="col">资料</th><th scope="col">学科</th><th scope="col">年级</th><th scope="col">类型</th><th scope="col">时长</th><th scope="col" style="text-align:right">操作</th></tr></thead><tbody>
        ${list.length ? list.map(m => `<tr>
          <td><div class="user-cell"><div><strong>${esc(m.title)}</strong><small>${esc(m.desc||'')}</small></div></div></td>
          <td>${esc((SUBJECTS[m.subject]||{}).name||m.subject)}</td>
          <td>${gradeLabel(m.grade)}</td>
          <td class="muted" style="font-size:var(--fs-sm)">${esc(m.type||'—')}</td>
          <td class="muted" style="font-size:var(--fs-sm)">${m.minutes} 分钟</td>
          <td><div class="row-actions" style="justify-content:flex-end">
            <button class="icon-btn" data-action="edit-material" data-id="${esc(m.id)}" aria-label="编辑">${icon('i-edit','icon--sm')}</button>
            <button class="icon-btn" data-action="delete-material" data-id="${esc(m.id)}" aria-label="删除">${icon('i-trash','icon--sm')}</button>
          </div></td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty"><p>没有匹配的资料</p></div></td></tr>`}
      </tbody></table></div>
    </div>`;
  $('#material-search').addEventListener('input', e => {
    state.admin.materialQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderAdminMaterials(c);
    const ne = $('#material-search'); ne.focus(); ne.setSelectionRange(pos, pos);
  });
}

async function refreshOverviewSources() {
  if (!state.cloudMode || !window.cloud || !window.SunnyAPI) return;
  try {
    await Promise.allSettled([
      window.SunnyAPI.listPersons(),
      loadCloudMaterials(),
      loadCloudShares(),
    ]);
  } catch (e) {
    // 刷新失败时沿用当前已加载数据，页面会展示最近一次统计结果
  }
}

async function renderAdminOverview(c) {
  const renderError = (message, detail) => {
    c.innerHTML = `
      <div class="panel">
        <div class="panel__head"><div><h3>数据概括</h3><small>账户、资料与互动数据汇总</small></div></div>
        <div class="empty">${icon('i-info','icon--xl')}<p>${esc(message)}</p>
          ${detail ? `<p class="muted" style="font-size:var(--fs-sm)">${esc(detail)}</p>` : ''}
          <button class="btn btn--soft" data-action="overview-refresh">${icon('i-refresh','icon--sm')} 重新加载</button>
        </div>
      </div>`;
  };
  c.innerHTML = `<div class="panel"><div class="empty"><p>正在加载数据概括…</p></div></div>`;

  let res;
  try {
    res = await window.SunnyAPI.getOverviewStats();
  } catch (e) {
    renderError('数据概括加载失败，请稍后重试', e && e.message ? e.message : '');
    return;
  }
  if (!res.ok) { renderError(res.message || '数据概括加载失败，请稍后重试'); return; }
  if (state.admin.tab !== 'overview' || $('#admin-content') !== c) return;

  const d = res.data;
  const updated = d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  const head = `
    <div class="panel" style="margin-bottom:var(--s5)">
      <div class="panel__head">
        <div><h3>数据概括</h3><small>账户、学习资料与互动数据汇总</small></div>
        <div class="row"><span class="muted" style="font-size:var(--fs-xs)">更新于 ${esc(updated)}</span>
          <button class="btn btn--ghost btn--sm" data-action="overview-refresh">${icon('i-refresh','icon--sm')} 刷新</button></div>
      </div>
    </div>`;

  if (d.empty) {
    c.innerHTML = `${head}<div class="panel"><div class="empty">${icon('i-chart','icon--xl')}
      <h3>暂无可统计的数据</h3><p>当前还没有账户、学习资料或互动记录。数据产生后，概括面板会自动展示。</p>
      <button class="btn btn--soft" data-action="overview-refresh">${icon('i-refresh','icon--sm')} 重新加载</button>
    </div></div>`;
    return;
  }

  let acc = 0;
  const segments = d.roles.map(r => {
    const start = acc;
    acc += d.totals.users ? (r.count / d.totals.users * 100) : 0;
    return `var(--${r.color}) ${start.toFixed(2)}% ${Math.min(100, acc).toFixed(2)}%`;
  });
  const donutBg = segments.length ? `conic-gradient(${segments.join(',')})` : 'var(--line-2)';
  const chartMax = Math.max(1, ...d.chart.map(p => Math.max(Number(p.a) || 0, Number(p.b) || 0)));

  c.innerHTML = `${head}
    <div class="stat-grid">
      ${d.stats.map(s => `<div class="stat-card">
        <div class="stat-card__top">
          <span class="stat-card__ic" style="background:var(--${s.soft});color:var(--${s.color})">${icon(s.icon)}</span>
          <span class="stat-card__trend${String(s.trend).startsWith('+') ? ' stat-card__trend--up' : ''}" title="${s.trend === '—' ? '暂无历史对比数据' : '较昨日'}">${esc(s.trend)}</span>
        </div>
        <div class="stat-card__num">${esc(s.num)}</div><div class="stat-card__label">${esc(s.label)}</div>
      </div>`).join('')}
    </div>
    <div class="admin-grid">
      <div class="panel">
        <div class="panel__head"><div><h3>学习活跃趋势</h3><small>近 7 天内容发布与消息互动</small></div></div>
        ${d.chartEmpty
          ? `<div class="empty"><p>当前暂无带日期的记录，趋势数据将在产生后自动展示。</p></div>`
          : `<div class="chart-bars">
              ${d.chart.map(p => `<div class="chart-bar">
                <div style="display:flex;gap:4px;width:100%;height:100%;align-items:flex-end;justify-content:center">
                  <div class="chart-bar__fill" style="height:${Math.round((Number(p.a)||0)/chartMax*100)}%" title="内容发布 ${Number(p.a)||0}"></div>
                  <div class="chart-bar__fill chart-bar__fill--alt" style="height:${Math.round((Number(p.b)||0)/chartMax*100)}%" title="消息互动 ${Number(p.b)||0}"></div>
                </div><span>${esc(p.label)}</span>
              </div>`).join('')}
            </div>`}
        <div class="legend"><span><i style="background:var(--brand)"></i>内容发布</span><span><i style="background:var(--sky)"></i>消息互动</span></div>
      </div>
      <div class="panel">
        <div class="panel__head"><div><h3>用户构成</h3><small>按角色分布</small></div></div>
        <div class="donut-wrap">
          <div class="donut-box"><div class="donut" style="background:${donutBg}"></div>
            <div class="donut__label"><strong style="font-family:var(--font-display);font-size:1.2rem">${d.totals.users}</strong><br><small class="muted">账户总数</small></div>
          </div>
          <div class="donut-legend">
            ${d.roles.length ? d.roles.map(r => `<div><i style="background:var(--${r.color})"></i>${esc(r.name)} ${r.percent}% · ${r.count} 人</div>`).join('')
              : '<div class="muted">暂无角色数据</div>'}
          </div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel__head"><div><h3>最近加入账户</h3><small>按创建时间排序，最多展示 5 条</small></div>
        <button class="btn btn--ghost btn--sm" data-action="admin-tab" data-tab="users">查看全部 ${icon('i-chevron-right','icon--sm')}</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">联系方式</th><th scope="col">验证状态</th><th scope="col">账户状态</th></tr></thead><tbody>
        ${d.recentUsers.length ? d.recentUsers.map(u => userRow(u)).join('')
          : `<tr><td colspan="5"><div class="empty"><p>暂无账户记录</p></div></td></tr>`}
      </tbody></table></div>
    </div>`;
}

function userRow(u) {
  const rm = ROLE_META[u.role] || ROLE_META.student;
  return `<tr>
    <td><div class="user-cell">${avatarHTML(u,'avatar--sm')}<div><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></div></div></td>
    <td><span class="role-tag ${rm.cls}">${rm.label}</span></td>
    <td class="muted" style="font-size:var(--fs-sm)">${esc(u.phone)}</td>
    <td>${u.verified ? `<span class="status-tag" style="color:var(--mint)">${icon('i-shield-check','icon--sm')} 已验证</span>` : `<span class="status-tag" style="color:var(--warning)">${icon('i-info','icon--sm')} 未验证</span>`}</td>
    <td><span class="status-tag" style="color:${u.status==='active'?'var(--mint)':'var(--ink-3)'}"><span class="dot ${u.status==='active'?'':'dot--off'}"></span>${u.status==='active'?'正常':u.status==='pending'?'待审核':'已禁用'}</span></td>
  </tr>`;
}

function renderAdminUsers(c) {
  const q = state.admin.userQuery.trim().toLowerCase();
  const list = state.users.filter(u => !q || `${u.name} ${u.email} ${u.phone}`.toLowerCase().includes(q));
  c.innerHTML = `
    <div class="panel">
      <div class="panel__head">
        <div><h3>人员管理 <span class="muted" style="font-size:var(--fs-sm)">(${list.length})</span></h3><small>超级管理员创建与管理人员，配置角色与权限</small></div>
        <div class="row"><div class="search-sm" style="width:240px">${icon('i-search')}<input id="user-search" type="search" placeholder="搜索人员…" value="${esc(state.admin.userQuery)}" /></div>
        <button class="btn btn--primary btn--sm" data-action="add-user">${icon('i-plus','icon--sm')} 新建人员</button></div>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">联系方式</th><th scope="col">验证状态</th><th scope="col">账户状态</th><th scope="col" style="text-align:right">操作</th></tr></thead><tbody>
        ${list.length ? list.map(u => `<tr>
          <td><div class="user-cell">${avatarHTML(u,'avatar--sm')}<div><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></div></div></td>
          <td><span class="role-tag ${roleViewOf(u.role).cls}">${esc(roleViewOf(u.role).label)}</span></td>
          <td class="muted" style="font-size:var(--fs-sm)">${esc(u.phone)}</td>
          <td>${u.verified ? `<span class="status-tag" style="color:var(--mint)">${icon('i-shield-check','icon--sm')} 已验证</span>` : `<span class="status-tag" style="color:var(--warning)">${icon('i-info','icon--sm')} 未验证</span>`}</td>
          <td><span class="status-tag" style="color:${u.status==='active'?'var(--mint)':'var(--ink-3)'}"><span class="dot ${u.status==='active'?'':'dot--off'}"></span>${u.status==='active'?'正常':u.status==='pending'?'待审核':'已禁用'}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end">
            <button class="icon-btn" data-action="edit-user" data-id="${u.id}" aria-label="编辑">${icon('i-edit','icon--sm')}</button>
            <button class="icon-btn" data-action="toggle-user-status" data-id="${u.id}" aria-label="切换状态">${icon('i-toggle','icon--sm')}</button>
            <button class="icon-btn" data-action="delete-user" data-id="${u.id}" aria-label="删除">${icon('i-trash','icon--sm')}</button>
          </div></td>
        </tr>`).join('') : `<tr><td colspan="6"><div class="empty"><p>没有匹配的用户</p></div></td></tr>`}
      </tbody></table></div>
    </div>
    <div class="panel" style="margin-top:var(--s4);border-color:rgba(224,82,82,.35)">
      <div class="panel__head">
        <div><h3 style="color:var(--danger)">危险操作 · 账户清理</h3><small>仅保留 admin 账户，删除其余账户及其所有关联数据；不可撤销</small></div>
        <button class="btn btn--danger btn--sm" data-action="cleanup-accounts">清理非 admin 账户</button>
      </div>
      <p class="muted" style="font-size:var(--fs-sm);margin:0">执行前校验 admin 账户存在且状态正常，并经过「影响范围预览 + 输入确认短语」两道确认。</p>
    </div>`;
  $('#user-search').addEventListener('input', e => {
    state.admin.userQuery = e.target.value;
    const pos = e.target.selectionStart;
    renderAdminUsers(c);
    const ne = $('#user-search'); ne.focus(); ne.setSelectionRange(pos, pos);
  });
}

function syncUserRoleFields() {
  const role = $('#uf-role')?.value;
  const isStudent = role === 'student';
  const gf = $('#uf-grade-field'), df = $('#uf-dept-field');
  if (gf) gf.classList.toggle('hidden', !isStudent);
  if (df) df.classList.toggle('hidden', isStudent);
  const dept = $('#uf-dept');
  if (dept) {
    const current = dept.value || (role === 'parent' ? '学生家长' : '');
    dept.innerHTML = deptOptions(role, current);
  }
}

function userFormModal(user) {
  const isEdit = !!user;
  openModal({
    title: isEdit ? `编辑人员 · ${user.name}` : '新建人员账户',
    body:`
      <div class="field"><label class="field__label" for="uf-name">姓名</label><input class="input" id="uf-name" value="${esc(user?.name||'')}" placeholder="请输入姓名" /></div>
      <div class="field"><label class="field__label" for="uf-email">邮箱（登录账号）</label><input class="input" id="uf-email" type="email" value="${esc(user?.email||'')}" placeholder="name@example.com" /></div>
      <div class="field"><label class="field__label" for="uf-phone">手机号</label><input class="input" id="uf-phone" value="${esc(user?.phone||'')}" placeholder="11 位手机号" /></div>
      <div class="field"><label class="field__label" for="uf-role">角色 / 职位</label><select class="select" id="uf-role">
        ${roleOptions(isEdit ? user.role : 'student')}
      </select></div>
      <div class="field" id="uf-grade-field"><label class="field__label" for="uf-grade">年级</label><select class="select" id="uf-grade">
        ${GRADES.map(g => `<option value="${g}" ${Number(user?.grade)===g?'selected':''}>${gradeLabel(g)}</option>`).join('')}
      </select></div>
      <div class="field" id="uf-dept-field"><label class="field__label" for="uf-dept">部门 / 身份</label><select class="select" id="uf-dept">${deptOptions(isEdit ? user.role : 'student', user?.dept || '')}</select></div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="uf-gender">性别</label><select class="select" id="uf-gender">
          ${[['','未填写'],['男','男'],['女','女'],['保密','保密']].map(([v,l]) => `<option value="${v}" ${(user?.gender||'')===v?'selected':''}>${l}</option>`).join('')}
        </select></div>
        <div class="field grow"><label class="field__label" for="uf-age">年龄</label><input class="input" id="uf-age" type="number" min="1" max="120" value="${user?.age || ''}" placeholder="选填" /></div>
      </div>
      <div class="field"><label class="field__label" for="uf-signature">个人签名</label><input class="input" id="uf-signature" value="${esc(user?.signature||'')}" maxlength="80" placeholder="一句话介绍自己（选填）" /></div>
      <div class="field" id="uf-managed-field"><label class="field__label">管理班级（班级主任可多选，可同时管理多个班级）</label>
        <div class="class-check-grid">${classOptionsHTML(window.SunnyAPI.normalizeManagedClasses(user?.managedClasses))}</div>
        <span class="field__hint">仅「班级主任」角色的选择生效；超管默认可管理全部班级。</span>
      </div>
      <div class="field"><label class="field__label" for="uf-presence">在线状态</label><select class="select" id="uf-presence">
        ${[['online','在线'],['away','离开'],['offline','离线']].map(([v,l]) => `<option value="${v}" ${(user?.presenceStored || user?.presence || 'offline')===v?'selected':''}>${l}</option>`).join('')}
      </select></div>
      <div class="field"><label class="field__label" for="uf-verified">验证状态</label><select class="select" id="uf-verified">
        <option value="0" ${!user?.verified?'selected':''}>未验证（首次登录需完成绑定验证）</option>
        <option value="1" ${user?.verified?'selected':''}>已验证（可直接使用）</option>
      </select></div>
      <div class="field"><label class="field__label" for="uf-password">${isEdit?'重设登录密码（留空不修改）':'初始登录密码（留空默认 123456）'}</label><input class="input" id="uf-password" type="password" placeholder="至少 6 位" autocomplete="new-password" /></div>
      <p class="field__hint">账户由超级管理员创建，系统不开放自助注册。该邮箱用于接收忘记密码时的身份验证验证码。</p>
      <span class="field__error" id="uf-err"></span>`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="save-user" data-id="${user?.id||''}">${isEdit?'保存修改':'创建账户'}</button>`,
  });
  $('#uf-role')?.addEventListener('change', syncUserRoleFields);
  syncUserRoleFields();
}

async function saveUser(id) {
  const err = $('#uf-err');
  if (err) err.textContent = '';
  const payload = {
    name: $('#uf-name').value.trim(),
    email: $('#uf-email').value.trim(),
    phone: $('#uf-phone').value.trim(),
    role: $('#uf-role').value,
    grade: Number($('#uf-grade').value) || 1,
    dept: $('#uf-dept').value.trim(),
    gender: $('#uf-gender')?.value || '',
    age: $('#uf-age')?.value || '',
    signature: $('#uf-signature')?.value.trim() || '',
    managedClasses: Array.from($$('[data-managed-class]:checked')).map(el => el.value),
    presence: $('#uf-presence')?.value || 'offline',
    verified: $('#uf-verified')?.value === '1',
  };
  const password = $('#uf-password')?.value || '';
  if (password) payload.password = password;
  // 编辑时保留已脱敏且未修改的手机号，避免重复校验失败
  if (id && payload.phone.includes('*')) delete payload.phone;
  if (payload.role === 'student') payload.dept = '';
  else payload.grade = 1;

  if (!payload.name) { if (err) err.textContent = '请输入姓名'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) { if (err) err.textContent = '请输入有效邮箱'; return; }
  if (payload.phone && !/^1\d{10}$/.test(payload.phone.replace(/\*/g, ''))) { if (err) err.textContent = '请输入有效手机号'; return; }
  if (password && password.length < 6) { if (err) err.textContent = '密码至少 6 位'; return; }

  const btn = $('[data-action="save-user"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = id
      ? await window.SunnyAPI.updatePerson(id, payload)
      : await window.SunnyAPI.createPerson(payload);
    if (!res.ok) {
      if (err) err.textContent = res.message;
      toast(res.message, 'error');
      return;
    }
    renderAdmin($('#main'));
    toast(res.message);
    // 新建工号成功后展示"立即同步"入口，使该工号可马上推送到另一端；编辑时保持原流程。
    if (!id) showCreatedPersonSyncCard(res.data && res.data.person ? res.data.person : null);
    else closeModal();
  } catch (e) {
    if (err) err.textContent = '保存失败，请检查网络后重试';
    toast('保存失败，请检查网络后重试', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = id ? '保存修改' : '创建账户'; }
  }
}

/* 新建工号成功后的"立即同步"卡片：展示同步中/成功/失败状态，防重复点击，
   网络异常与同步失败均有明确提示。用户可稍后关闭，不影响已完成的创建。 */
let personSyncInFlight = false;
function showCreatedPersonSyncCard(person) {
  const name = esc((person && person.name) || '该工号');
  openModal({
    title: '工号创建成功',
    body: `
      <div class="sync-card">
        <div class="sync-card__badge">${icon('i-check')}</div>
        <p class="sync-card__title">${name} 已创建</p>
        <p class="sync-card__hint">现在可将该工号立即同步到另一端，确保电脑与手机数据一致。</p>
        <div class="sync-card__status" id="person-sync-status" role="status" aria-live="polite">
          <span class="sync-card__dot"></span><span class="sync-card__status-text">尚未同步</span>
        </div>
        <p class="sync-card__error" id="person-sync-error"></p>
      </div>`,
    footer: `
      <button class="btn btn--ghost" data-action="close-modal">稍后同步</button>
      <button class="btn btn--primary" id="btn-sync-person" data-action="sync-new-person">${icon('i-refresh','icon--sm')} 立即同步</button>`,
  });
}

async function syncNewPerson() {
  if (personSyncInFlight) return; // 防重复点击
  const btn = $('#btn-sync-person');
  const statusBox = $('#person-sync-status');
  const statusText = statusBox && statusBox.querySelector('.sync-card__status-text');
  const errBox = $('#person-sync-error');
  personSyncInFlight = true;
  if (btn) { btn.disabled = true; btn.classList.add('is-syncing'); }
  if (statusBox) statusBox.className = 'sync-card__status is-syncing';
  if (statusText) statusText.textContent = '同步中，请稍候…';
  if (errBox) errBox.textContent = '';
  try {
    if (!window.SunnyAPI || typeof window.SunnyAPI.syncPersonnel !== 'function') {
      throw new Error('同步接口未就绪');
    }
    const res = await window.SunnyAPI.syncPersonnel();
    if (!res || !res.ok) {
      const msg = (res && res.message) || '同步失败，请检查网络后重试';
      if (statusBox) statusBox.className = 'sync-card__status is-error';
      if (statusText) statusText.textContent = '同步失败';
      if (errBox) errBox.textContent = msg;
      toast(msg, 'error');
      return;
    }
    if (statusBox) statusBox.className = 'sync-card__status is-success';
    if (statusText) statusText.textContent = res.cloudMode ? '同步成功 · 已上传云端' : '同步成功';
    toast(res.message || '同步成功');
    // 同步后本机人员列表可能已从云端刷新，重载管理视图
    if (typeof renderAdmin === 'function' && state.view === 'admin') renderAdmin($('#main'));
  } catch (e) {
    const msg = '同步失败：' + ((e && e.message) ? e.message : '网络异常，请检查网络后重试');
    if (statusBox) statusBox.className = 'sync-card__status is-error';
    if (statusText) statusText.textContent = '同步失败';
    if (errBox) errBox.textContent = msg;
    toast(msg, 'error');
  } finally {
    personSyncInFlight = false;
    if (btn) { btn.disabled = false; btn.classList.remove('is-syncing'); }
  }
}

/* ---------- 账户清理：两步确认与结果报告 ---------- */
let cleanupPlan = null;
const CLEANUP_COUNT_LABELS = {
  accounts: '账户', orphanIdentities: '孤儿身份', personnel: '人员记录', profiles: '账户资料',
  shares: '学习感悟', shareLikes: '点赞记录', materials: '关联资料',
  conversations: '会话', likesRemoved: '点赞引用清理',
};
function cleanupCountText(counts) {
  return Object.keys(CLEANUP_COUNT_LABELS)
    .map(k => `${CLEANUP_COUNT_LABELS[k]} ${Number(counts?.[k]) || 0}`)
    .join(' · ');
}
async function previewAccountCleanup() {
  const btn = $('[data-action="cleanup-accounts"]');
  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  try {
    const res = await window.SunnyAPI.getAccountCleanupPlan();
    if (!res.ok) { toast(res.message, 'error'); return; }
    cleanupPlan = res.data;
    const d = res.data;
    openModal({
      title: '账户清理 · 第一步：确认影响范围', wide: true,
      body: `
        <p>预检已通过。以下 <b style="color:var(--danger)">${d.targets.length}</b> 个账户及其关联数据将被永久删除，请仔细核对。</p>
        <div class="panel" style="box-shadow:none;border-color:rgba(52,199,150,.45);margin-bottom:var(--s3)">
          <div class="panel__head"><div><h3>保留账户（不受影响）</h3><small>admin 账户将完整保留，角色、状态与凭据均不修改</small></div><span class="status-tag" style="color:var(--mint)">${esc(d.keep.name)}</span></div>
          <p class="muted" style="font-size:var(--fs-sm);margin:0">${esc(d.keep.email)} · ${esc(d.keep.role)} · ${esc(d.keep.status)}</p>
        </div>
        ${d.targets.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>待删除账户</th><th>角色</th><th>关联数据</th></tr></thead><tbody>
          ${d.targets.map(u => `<tr><td><strong>${esc(u.name)}</strong><br><small class="muted">${esc(u.email)}</small></td>
            <td>${esc(u.role)}</td><td class="muted" style="font-size:var(--fs-sm)">${esc(cleanupCountText(u.relations))}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty"><p>没有其他账户需要清理，当前已仅保留 admin 账户。</p></div>'}
        ${d.counts.orphanIdentities ? `<p class="field__error" style="font-weight:500">另有 ${d.counts.orphanIdentities} 个仅存在于关联数据中的旧身份，将一并清理其数据。</p>` : ''}
        <p class="muted" style="font-size:var(--fs-sm)">合计：${esc(cleanupCountText(d.counts))}</p>
        ${(d.warnings || []).map(w => `<p class="field__error" style="font-weight:500">${esc(w)}</p>`).join('')}`,
      footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button>
        <button class="btn btn--danger" data-action="cleanup-step2" ${d.targets.length ? '' : 'disabled'}>继续第二步确认</button>`,
    });
  } catch (e) {
    toast('预检失败，请检查网络后重试', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '清理非 admin 账户'; }
  }
}
function accountCleanupStep2() {
  if (!cleanupPlan) { toast('预检结果已失效，请重新检查', 'error'); return; }
  const phrase = cleanupPlan.phrase;
  openModal({
    title: '账户清理 · 第二步：最终确认',
    body: `
      <p>即将删除 <b style="color:var(--danger)">${cleanupPlan.targets.length}</b> 个账户及全部关联数据，保留 <b>${esc(cleanupPlan.keep.name)}</b>。此操作不可撤销。</p>
      <div class="field"><label class="field__label" for="cleanup-phrase">请输入确认短语：<code>${esc(phrase)}</code></label>
        <input class="input" id="cleanup-phrase" autocomplete="off" placeholder="${esc(phrase)}" /></div>
      <label class="row" style="align-items:flex-start"><input type="checkbox" class="checkbox" id="cleanup-confirm" />
        <span>我已核对上述影响范围，确认删除这些账户及其关联数据。</span></label>
      <span class="field__error" id="cleanup-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button>
      <button class="btn btn--danger" id="cleanup-execute" data-action="confirm-cleanup-accounts" disabled>确认清理</button>`,
  });
  const input = $('#cleanup-phrase'), box = $('#cleanup-confirm'), exec = $('#cleanup-execute');
  const sync = () => { exec.disabled = !(box && box.checked && input && input.value.trim() === phrase); };
  input?.addEventListener('input', sync);
  box?.addEventListener('change', sync);
  sync();
}
async function executeAccountCleanup() {
  if (!cleanupPlan) { toast('预检结果已失效，请重新检查', 'error'); return; }
  const input = $('#cleanup-phrase'), box = $('#cleanup-confirm'), err = $('#cleanup-err'), btn = $('#cleanup-execute');
  if (!box?.checked || input?.value.trim() !== cleanupPlan.phrase) {
    if (err) err.textContent = '请勾选确认并输入正确的确认短语';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '清理中…'; }
  try {
    const res = await window.SunnyAPI.cleanupAccounts({ confirm: true, confirmPhrase: input.value.trim() });
    if (!res.ok) {
      if (err) err.textContent = res.message;
      toast(res.message, 'error');
      return;
    }
    const report = res.data;
    cleanupPlan = null;
    closeModal();
    renderAdmin($('#main'));
    openModal({
      title: '账户清理报告', wide: true,
      body: `
        <p>${esc(res.message)}</p>
        <div class="panel" style="box-shadow:none"><div class="panel__head"><div><h3>清理数量</h3><small>${esc(cleanupCountText(report.counts))}</small></div></div></div>
        <p><strong>已删除账户：</strong>${report.deletedAccounts.length ? esc(report.deletedAccounts.map(u => u.name).join('、')) : '无'}</p>
        <p><strong>失败项：</strong>${report.failedItems.length
          ? `<ul>${report.failedItems.map(f => `<li class="field__error">${esc(f.account)} · ${esc(f.scope)}：${esc(f.message)}</li>`).join('')}</ul>`
          : '<span style="color:var(--mint)">无</span>'}</p>
        <p><strong>最终账户状态（共 ${report.finalAccounts.length} 个）：</strong></p>
        <div class="table-wrap"><table class="table"><thead><tr><th>账户</th><th>角色</th><th>状态</th></tr></thead><tbody>
          ${report.finalAccounts.map(u => `<tr><td>${esc(u.name)}<br><small class="muted">${esc(u.email)}</small></td><td>${esc(u.role)}</td><td>${esc(u.status)}</td></tr>`).join('')}
        </tbody></table></div>`,
      footer: `<button class="btn btn--primary" data-action="close-modal">完成</button>`,
    });
    toast(res.message, report.failedItems.length ? 'error' : 'success');
  } catch (e) {
    if (err) err.textContent = '清理失败，请检查网络后重试';
    toast('清理失败，请检查网络后重试', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '确认清理'; }
  }
}

function renderAdminRoles(c) {
  const sub = state.admin.permSub || 'assign'; // assign | perms | views
  const role = state.roles.find(r => r.id === state.admin.activeRole) || state.roles[0];
  const perms = state.permissions;
  const viewLabels = { library:'学习资料', shares:'学习感悟', directory:'内部通讯录' };

  const subTabs = `
    <div class="roles-tabs" style="margin-bottom:var(--s4)">
      <button class="chip ${sub==='assign'?'is-active':''}" data-action="perm-sub" data-sub="assign">角色权限分配</button>
      <button class="chip ${sub==='perms'?'is-active':''}" data-action="perm-sub" data-sub="perms">权限项维护</button>
      <button class="chip ${sub==='views'?'is-active':''}" data-action="perm-sub" data-sub="views">视图访问控制</button>
    </div>`;

  let body = '';

  if (sub === 'assign') {
    body = `
      <div class="panel">
        <div class="panel__head"><div><h3>角色权限分配</h3><small>为角色勾选权限项，保存后立即对该角色下所有人员生效</small></div>
          <button class="btn btn--soft btn--sm" data-action="add-role">${icon('i-plus','icon--sm')} 新建角色</button></div>
        <div class="roles-tabs">
          ${state.roles.map(r => `<button class="chip ${role.id===r.id?'is-active':''}" data-action="select-role" data-id="${r.id}">
            <span class="chip__dot" style="background:var(--${r.color==='berry'?'berry':r.color==='sky'?'sky':r.color==='mint'?'mint':'sun'})"></span>${esc(r.name)}</button>`).join('')}
        </div>
        <div class="matrix-wrap"><table class="matrix">
          <thead><tr><th scope="col">权限项</th><th scope="col">状态</th><th scope="col">说明</th></tr></thead>
          <tbody>${perms.map(p => {
            const on = role.perms.includes(p.key);
            return `<tr><td><span class="perm-name">${esc(p.name)}<small>${esc(p.key)}</small></span></td>
              <td><input type="checkbox" class="checkbox" data-action="toggle-perm" data-perm="${esc(p.key)}" ${on?'checked':''} aria-label="${esc(p.name)}" /></td>
              <td class="muted" style="font-size:var(--fs-sm);text-align:left">${esc(p.desc)}${p.builtin?' · <b>内置</b>':''}</td></tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="row" style="margin-top:var(--s5);justify-content:flex-end">
          <span class="muted" style="font-size:var(--fs-sm);margin-right:auto">已启用 <b style="color:var(--brand)">${role.perms.length}</b> / ${perms.length} 项权限</span>
          ${!['r_admin','r_teacher','r_student','r_parent'].includes(role.id) ? `<button class="btn btn--danger btn--sm" data-action="delete-role" data-id="${role.id}">删除该角色</button>` : ''}
          <button class="btn btn--primary btn--sm" data-action="save-role">保存权限设置</button>
        </div>
      </div>`;
  } else if (sub === 'perms') {
    body = `
      <div class="panel">
        <div class="panel__head"><div><h3>权限项维护</h3><small>新增自定义权限项后可分配给角色；内置权限项不可删除</small></div>
          <button class="btn btn--soft btn--sm" data-action="add-perm">${icon('i-plus','icon--sm')} 新增权限项</button></div>
        <div class="matrix-wrap"><table class="matrix">
          <thead><tr><th scope="col">权限项</th><th scope="col">标识</th><th scope="col">说明</th><th scope="col">操作</th></tr></thead>
          <tbody>${perms.map(p => `
            <tr><td><span class="perm-name">${esc(p.name)}${p.builtin?' <span class="tag" style="font-size:10px">内置</span>':''}</span></td>
              <td><code style="font-size:var(--fs-sm)">${esc(p.key)}</code></td>
              <td class="muted" style="font-size:var(--fs-sm);text-align:left">${esc(p.desc)}</td>
              <td>${p.builtin
                ? `<button class="btn btn--ghost btn--sm" data-action="edit-perm" data-key="${esc(p.key)}">编辑</button>`
                : `<button class="btn btn--ghost btn--sm" data-action="edit-perm" data-key="${esc(p.key)}">编辑</button>
                   <button class="btn btn--danger btn--sm" data-action="delete-perm" data-key="${esc(p.key)}">删除</button>`}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="field__hint" style="margin-top:var(--s4)">权限标识（key）创建后不可修改，供角色分配与视图门禁引用。删除权限项前请先从所有角色和视图门禁中移除引用。</p>
      </div>`;
  } else {
    body = `
      <div class="panel">
        <div class="panel__head"><div><h3>视图访问控制</h3><small>为每个主视图指定所需权限项；未授权用户登录后该入口隐藏，直接访问也会被拦截</small></div></div>
        <div class="matrix-wrap"><table class="matrix">
          <thead><tr><th scope="col">功能视图</th><th scope="col">所需权限</th><th scope="col">说明</th></tr></thead>
          <tbody>${Object.keys(viewLabels).map(view => {
            const cur = state.viewPerms[view] === undefined ? (DEFAULT_VIEW_PERMISSIONS[view] || '') : (state.viewPerms[view] || '');
            return `<tr><td><span class="perm-name">${viewLabels[view]}<small>${esc(view)}</small></span></td>
              <td><select class="select" data-action="view-perm-select" data-view="${view}" style="min-width:170px">
                <option value="" ${cur===''?'selected':''}>不设门禁（所有人可见）</option>
                ${perms.map(p => `<option value="${esc(p.key)}" ${cur===p.key?'selected':''}>${esc(p.name)}（${esc(p.key)}）</option>`).join('')}
              </select></td>
              <td class="muted" style="font-size:var(--fs-sm);text-align:left">用户须拥有所选权限才能看到并访问该视图</td></tr>`;
          }).join('')}
          <tr><td><span class="perm-name">管理后台<small>admin</small></span></td>
              <td class="muted" style="text-align:left">固定仅超级管理员可见（不可配置）</td>
              <td class="muted" style="font-size:var(--fs-sm);text-align:left">始终由超管独占，不参与权限分配</td></tr>
          </tbody>
        </table></div>
        <div class="row" style="margin-top:var(--s5);justify-content:flex-end">
          <button class="btn btn--primary btn--sm" data-action="save-view-perms">保存视图门禁</button>
        </div>
      </div>`;
  }

  c.innerHTML = subTabs + body;
}

/* ---------- 权限项：新增 / 编辑 弹窗 ---------- */
function permModal(existingKey) {
  const p = existingKey ? state.permissions.find(x => x.key === existingKey) : null;
  const isEdit = !!p;
  openModal({
    title: isEdit ? `编辑权限项 · ${p.name}` : '新增权限项',
    body: `
      ${isEdit ? '' : `<div class="field"><label class="field__label" for="pm-key">权限标识（key）</label><input class="input" id="pm-key" placeholder="例如 export_data" /><p class="field__hint">仅小写字母、数字与下划线，创建后不可修改</p></div>`}
      <div class="field"><label class="field__label" for="pm-name">权限名称</label><input class="input" id="pm-name" value="${esc(p?.name||'')}" placeholder="例如 导出数据" /></div>
      <div class="field"><label class="field__label" for="pm-desc">说明</label><input class="input" id="pm-desc" value="${esc(p?.desc||'')}" placeholder="该权限允许做什么" /></div>
      <span class="field__error" id="pm-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="save-perm" data-key="${esc(existingKey||'')}">${isEdit?'保存修改':'创建权限项'}</button>`,
  });
}

async function savePerm(existingKey) {
  const err = $('#pm-err'); if (err) err.textContent = '';
  const name = $('#pm-name')?.value.trim() || '';
  const desc = $('#pm-desc')?.value.trim() || '';
  const key = existingKey || ($('#pm-key')?.value.trim() || '');
  if (!/^[a-z][a-z0-9_]*$/.test(key)) { if (err) err.textContent = '权限标识须以小写字母开头，仅含小写字母、数字与下划线'; return; }
  if (!name) { if (err) err.textContent = '请输入权限名称'; return; }
  const next = state.permissions.map(p => ({ ...p }));
  const idx = next.findIndex(p => p.key === key);
  if (existingKey && idx < 0) { if (err) err.textContent = '权限项不存在'; return; }
  if (!existingKey && idx >= 0) { if (err) err.textContent = '该权限标识已存在'; return; }
  const item = { key, name, desc, builtin: existingKey ? next[idx].builtin : false };
  if (idx >= 0) next[idx] = item; else next.push(item);
  const btn = $('[data-action="save-perm"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = await window.SunnyAPI.savePermissionDefs(next);
    if (!res.ok) { if (err) err.textContent = res.message; toast(res.message, 'error'); return; }
    closeModal(); renderAdmin($('#main')); toast(res.message);
  } catch (e) { if (err) err.textContent = '保存失败，请检查网络后重试'; }
  finally { if (btn) { btn.disabled = false; btn.textContent = existingKey ? '保存修改' : '创建权限项'; } }
}

async function deletePerm(key) {
  const p = state.permissions.find(x => x.key === key);
  if (!p || p.builtin) { toast('内置权限项不可删除', 'error'); return; }
  const usedRoles = state.roles.filter(r => r.perms.includes(key)).map(r => r.name);
  const usedViews = Object.keys(state.viewPerms).filter(v => state.viewPerms[v] === key);
  if (usedRoles.length || usedViews.length) {
    toast(`该权限仍被引用（角色：${usedRoles.join('、')||'无'}；视图：${usedViews.join('、')||'无'}），请先移除引用`, 'error');
    return;
  }
  const next = state.permissions.filter(x => x.key !== key).map(x => ({ ...x }));
  try {
    const res = await window.SunnyAPI.savePermissionDefs(next);
    if (!res.ok) { toast(res.message, 'error'); return; }
    renderAdmin($('#main')); toast('权限项已删除', 'info');
  } catch (e) { toast('删除失败，请检查网络后重试', 'error'); }
}

async function saveViewPerms() {
  const viewPerms = {};
  $$('[data-action="view-perm-select"]').forEach(sel => { viewPerms[sel.dataset.view] = sel.value || null; });
  const btn = $('[data-action="save-view-perms"]');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = await window.SunnyAPI.saveViewPerms(viewPerms);
    toast(res.message, res.ok ? 'success' : 'error');
    if (res.ok) { renderNav(); renderAdmin($('#main')); }
  } catch (e) { toast('保存失败，请检查网络后重试', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '保存视图门禁'; } }
}

/* ---------- 自定义角色：新建 / 删除 ---------- */
function addRoleModal() {
  openModal({
    title: '新建角色',
    body: `
      <div class="field"><label class="field__label" for="nr-name">角色名称</label><input class="input" id="nr-name" placeholder="例如 教研组长" /></div>
      <div class="field"><label class="field__label" for="nr-color">标识颜色</label><select class="select" id="nr-color">
        <option value="sky">天蓝</option><option value="mint">薄荷绿</option><option value="sun">暖橙</option><option value="berry">莓红</option>
      </select></div>
      <p class="field__hint">创建后可在权限矩阵中勾选该角色可访问的功能，并在人员管理中分配给成员。</p>
      <span class="field__error" id="nr-err"></span>`,
    footer: `<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--primary" data-action="confirm-add-role">创建角色</button>`,
  });
}
async function confirmAddRole() {
  const name = $('#nr-name')?.value.trim();
  const color = $('#nr-color')?.value || 'sky';
  const err = $('#nr-err');
  if (!name) { if (err) err.textContent = '请输入角色名称'; return; }
  const next = state.roles.map(r => ({ ...r, perms: [...r.perms] }));
  const added = { id: 'r_custom_' + Date.now(), name, color, perms: ['view_material'] };
  next.push(added);
  try {
    const res = await window.SunnyAPI.saveRoleConfigs(next);
    if (!res.ok) { if (err) err.textContent = res.message; toast(res.message, 'error'); return; }
    state.admin.activeRole = added.id;
    closeModal(); renderAdmin($('#main')); toast('角色已创建，请勾选权限');
  } catch (e) { if (err) err.textContent = '创建失败，请检查网络后重试'; }
}
async function deleteRole(id) {
  const builtin = ['r_admin','r_teacher','r_student','r_parent'];
  if (builtin.includes(id)) { toast('内置角色不可删除', 'error'); return; }
  const role = state.roles.find(r => r.id === id);
  if (!role) return;
  const used = state.users.filter(u => u.role === id).length;
  if (used > 0) { toast(`仍有 ${used} 名人员使用该角色，请先调整其角色`, 'error'); return; }
  const next = state.roles.filter(r => r.id !== id).map(r => ({ ...r, perms: [...r.perms] }));
  try {
    const res = await window.SunnyAPI.saveRoleConfigs(next);
    if (!res.ok) { toast(res.message, 'error'); return; }
    state.admin.activeRole = next[0]?.id || 'r_admin';
    renderAdmin($('#main')); toast('角色已删除', 'info');
  } catch (e) { toast('删除失败，请检查网络后重试', 'error'); }
}

/* ==========================================================================
   全局事件委托
   ========================================================================== */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) {
    // 点击空白处收起下拉
    if (!e.target.closest('.dropdown') && !e.target.closest('.user-chip') && !e.target.closest('.notify-btn') && !e.target.closest('.session-btn')) closeDropdowns();
    return;
  }
  const a = t.dataset.action;
  // 模态/抽屉遮罩：只有点遮罩本身才关闭；弹窗内的关闭按钮不受此拦截
  if (shouldIgnoreMaskClose(t, e.target, a)) return;

  switch (a) {
    case 'navigate': navigate(t.dataset.view); break;
    case 'open-image-to-doc': {
      // 统一用同页跳转：手机浏览器/微信内置浏览器会拦截 window.open(_blank) 导致点击无反应，
      // 且会造成"电脑开新页、手机打不开"的两端不一致。功能页已有返回按钮（带回 sharecode），
      // 因此同页跳转在电脑与手机上行为完全一致、且不会被拦截。
      window.location.href = 'image-to-doc.html' + window.location.search;
      break;
    }
    case 'open-text-to-doc': {
      // 与图片转文档保持完全一致的跳转与权限策略：所有成员可用、同页跳转、保留 sharecode。
      window.location.href = 'text-to-doc.html' + window.location.search;
      break;
    }
    case 'toggle-sidebar':
      $('#sidebar').classList.toggle('is-open');
      $('#scrim').classList.toggle('hidden');
      break;
    case 'toggle-usermenu': toggleDropdown('#usermenu'); break;
    case 'toggle-notifications': toggleDropdown('#notify-panel'); break;
    case 'mark-all-read':
      state.notifications.forEach(n => n.read = true); renderNotifications(); persist(); toast('已全部标记为已读', 'info'); break;
    case 'read-notification': {
      const n = state.notifications.find(x => x.id === t.dataset.id);
      if (n) {
        n.read = true; renderNotifications(); persist();
        if (n.source === 'notice' && n.refId) { openNotice(n.refId); navigate('notices'); }
        else if (n.title.includes('消息')) navigate('directory');
      }
      break;
    }
    case 'notice-publish': publishNotice(); break;
    case 'notice-open': openNotice(t.dataset.id); break;
    case 'notice-delete': e.stopPropagation(); deleteNotice(t.dataset.id); break;
    case 'logout':
      closeDropdowns();
      if (state.cloudMode) { cloudLogout(); break; }
      logoutCurrentSession();
      break;
    case 'session-switch': switchToSession(t.dataset.id); break;
    case 'session-toggle-menu': toggleDropdown('#session-menu'); break;
    case 'session-presence': setSessionPresence(t.dataset.id, t.dataset.value); break;
    case 'session-close': closeSessionById(t.dataset.id); break;
    case 'session-add':
      closeDropdowns();
      toast('请在登录页使用其他账户登录，登录后将自动加入在线会话', 'info');
      renderLogin();
      break;
    case 'logout-all': logoutAllSessions(); break;
    case 'open-profile': closeDropdowns(); openProfile(); break;
    case 'open-binding': closeDropdowns(); openBindingModal(); break;
    case 'save-binding': saveBinding(); break;
    case 'save-password': savePassword(); break;
    // 云端登录
    // 忘记密码（邮箱验证码仅用于身份验证与重置）
    case 'forgot-password': renderForgotPassword(); break;
    case 'back-demo-login': renderLogin(); break;
    case 'send-reset-code': sendResetCode(); break;
    // 绑定向导
    case 'bind-next': window.bindNext(); break;
    case 'bind-back': if (state.binding.step > 0) { state.binding.step--; renderBinding(); } break;
    case 'resend-code': toast('验证码已重新发送（演示：123456）', 'info'); break;
    case 'bind-finish': {
      const u = state.account;
      const found = state.users.find(x => x.id === u.id);
      if (found) Object.assign(found, u);
      persist();
      loginSuccess(u); break;
    }
    // 资料
    case 'filter-grade': state.library.grade = t.dataset.grade; refreshLibraryFilterUI(); break;
    case 'filter-subject': state.library.subject = t.dataset.subject; refreshLibraryFilterUI(); break;
    case 'set-mode': state.library.mode = t.dataset.mode; refreshLibraryFilterUI(); break;
    case 'clear-filters':
      state.library = { grade:'all', subject:'all', query:'', mode:state.library.mode };
      $('#global-search').value = ''; refreshLibraryFilterUI(); break;
    case 'open-material': openMaterial(t.dataset.id); break;
    case 'close-drawer': closeDrawer(); break;
    case 'start-learning': {
      const fresh = addToLearning(t.dataset.id);
      closeDrawer();
      toast(fresh ? '已加入学习，祝你学有所获！' : '已在学习清单中，继续加油！', fresh ? 'success' : 'info');
      break;
    }
    case 'remove-learning': {
      if (removeFromLearning(t.dataset.id)) {
        if (currentDrawerMaterialId === t.dataset.id) openMaterial(t.dataset.id); // 重建抽屉底部按钮状态
        toast('已从「已添加学习」移除', 'info');
      }
      break;
    }
    // 资料发布
    case 'publish-material': openMaterialForm(); break;
    case 'submit-material': submitMaterial(); break;
    // 学习感悟
    case 'open-share-form': openShareForm(); break;
    case 'submit-share': submitShare(); break;
    case 'toggle-like': toggleLike(t.dataset.id); break;
    case 'open-comment-form': openCommentForm(t.dataset.id); break;
    case 'submit-comment': submitComment(t.dataset.id); break;
    case 'delete-share': {
      const target = state.shares.find(s => String(s.id) === String(t.dataset.id));
      if (!target) break;
      confirmDeleteShares([String(target.id)], target.title);
      break;
    }
    case 'clear-all-shares': confirmDeleteShares([], ''); break;
    case 'confirm-delete-shares': {
      // 从当前待删除意图中取 ids：以弹窗打开时记录的 pending 为准
      const ids = (shareDeletePending || []).slice();
      closeModal();
      executeDeleteShares(ids);
      break;
    }
    case 'retry-share-sync': if (typeof shareSyncRetry === 'function') shareSyncRetry(); break;
    case 'realtime-sync': realtimeSyncNow(); break;
    // 通讯录
    case 'filter-dir-role': state.directory.roleFilter = t.dataset.role; renderDirectory($('#main')); break;
    case 'open-conv-with': openConvWith(t.dataset.id); break;
    case 'send-message': window.sendMessage(); break;
    case 'chat-fs-back': closeChatFullscreen(); break;
    case 'toggle-chat-more': toggleChatMore(); break;
    case 'toggle-chat-emoji': toggleChatEmoji(); break;
    case 'pick-photo': openImagePicker(false); break;
    case 'take-photo': openImagePicker(true); break;
    case 'feature-soon': toast('更多功能正在准备中，敬请期待', 'info'); break;
    case 'insert-emoji': insertEmoji(t.dataset.value, t.dataset.kind); break;
    case 'emoji-tab': state.directory.emojiTab = t.dataset.tab; renderActiveChat(); break;
    case 'add-sticker': addStickerModal(); break;
    case 'confirm-add-sticker': confirmAddSticker(); break;
    case 'manage-stickers': manageStickersModal(); break;
    case 'delete-sticker': deleteSticker(t.dataset.id); break;
    case 'fav-sticker': favSticker(t.dataset.id); break;
    case 'preview-image': previewImage(t.getAttribute('src')); break;
    case 'close-image-preview': closeImagePreview(); break;
    case 'start-call': startCall(t.dataset.type, t.dataset.id); break;
    case 'call-accept': acceptCall(); break;
    case 'call-reject': rejectCall(); break;
    case 'call-hangup': endCall('通话已结束', true); break;
    case 'call-mic': toggleMic(); break;
    case 'call-cam': toggleCam(); break;
    case 'schedule-edit': scheduleEditModal(t.dataset.class, t.dataset.day, t.dataset.period); break;
    case 'schedule-save': scheduleSave(t.dataset.class, t.dataset.day, t.dataset.period, t.dataset.id); break;
    case 'schedule-delete': scheduleDelete(t.dataset.id); break;
    case 'schedule-init': scheduleInitTemplate(t.dataset.class); break;
    case 'schedule-print': printSchedule(t.dataset.class); break;
    case 'close-chat': state.directory.activeConv = null; if (state.directory.chatFullscreen) closeChatFullscreen(); else { renderChat(); refreshMemberList(); } break;
    case 'chat-info': {
      const conv = state.conversations.find(c => c.id === state.directory.activeConv);
      const p = findDirectoryMember(conv?.with); if (p) showMemberInfo(p); break;
    }
    case 'show-member-info': {
      const p = findDirectoryMember(t.dataset.id); if (p) showMemberInfo(p); break;
    }
    case 'new-message': newMessageModal(); break;
    case 'msg-from-profile': {
      const uid = t.dataset.id;
      closeModal(); state.view = 'directory'; navigate('directory'); openConvWith(uid); break;
    }
    case 'confirm-new-message': {
      const uid = $('#new-msg-select').value, text = $('#new-msg-text').value.trim();
      const conv = findOrCreateConv(uid);
      if (text) { const now = new Date(); conv.messages.push({ from:state.account.id, text, time:`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` }); }
      persist();
      closeModal(); state.view = 'directory'; navigate('directory'); openConvWith(uid); toast('会话已创建'); break;
    }
    // 管理后台
    case 'admin-tab':
      stopMonitorTimer();
      state.admin.tab = t.dataset.tab;
      renderAdmin($('#main'));
      if (state.cloudMode && t.dataset.tab === 'users') refreshPersons();
      if (state.cloudMode && t.dataset.tab === 'roles') loadRoleConfigs();
      if (state.cloudMode && t.dataset.tab === 'overview') {
        refreshOverviewSources().then(() => {
          if (state.admin.tab === 'overview' && $('#admin-content')) renderAdminOverview($('#admin-content'));
        });
      }
      break;
    // 备份与还原
    case 'backup-now': runBackupNow(); break;
    case 'backup-save-schedule': saveBackupSchedule(); break;
    case 'backup-download': {
      const list = listInternalBackups();
      const bk = list.find(x => String(x.backupId) === String(t.dataset.id));
      if (bk) { downloadBackupFile(bk); toast('备份文件已开始下载'); }
      break;
    }
    case 'backup-restore': {
      const list = listInternalBackups();
      const bk = list.find(x => String(x.backupId) === String(t.dataset.id));
      if (bk) confirmRestore(bk);
      break;
    }
    case 'backup-delete': {
      const KEY = 'sunny-classroom-backups';
      let list = listInternalBackups().filter(x => String(x.backupId) !== String(t.dataset.id));
      try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch (err) {}
      renderAdminBackup($('#admin-content')); toast('备份已删除', 'info');
      break;
    }
    case 'backup-restore-file': restoreFromFile(); break;
    case 'backup-restore-confirm': applyRestore(); break;
    case 'monitor-refresh': renderAdminMonitor($('#admin-content')); toast('数据已刷新', 'info'); break;
    case 'overview-refresh':
      (async () => {
        await refreshOverviewSources();
        if (state.admin.tab !== 'overview' || !$('#admin-content')) return;
        await renderAdminOverview($('#admin-content'));
        toast('数据已刷新', 'info');
      })();
      break;
    case 'monitor-toggle':
      state.admin.monitorAuto = !state.admin.monitorAuto;
      renderAdminMonitor($('#admin-content'));
      toast(state.admin.monitorAuto ? '已开启自动刷新（每 5 秒）' : '已关闭自动刷新', 'info');
      break;
    case 'add-material': materialFormModal(null); break;
    case 'edit-material': {
      const m = state.materials.find(x => String(x.id) === String(t.dataset.id));
      if (m) materialFormModal(m);
      break;
    }
    case 'save-material': saveMaterial(t.dataset.id || null); break;
    case 'delete-material': deleteMaterial(t.dataset.id); break;
    case 'confirm-delete-material': {
      (async () => {
        const btn = t;
        if (btn) { btn.disabled = true; btn.textContent = '删除中…'; }
        try {
          const res = await window.SunnyAPI.deleteMaterial(t.dataset.id);
          toast(res.message, res.ok ? 'success' : 'error');
          closeModal();
          if (res.ok && state.cloudMode) await loadCloudMaterials();
          renderAdmin($('#main'));
        } catch (e) {
          toast('删除失败，请检查网络后重试', 'error');
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '确认删除'; }
        }
      })();
      break;
    }
    case 'add-user': userFormModal(null); break;
    case 'edit-user': {
      const u = state.users.find(x => x.id === t.dataset.id);
      if (u) userFormModal(u);
      break;
    }
    case 'save-user': saveUser(t.dataset.id); break;
    case 'sync-new-person': syncNewPerson(); break;
    case 'toggle-user-status': {
      const u = state.users.find(x => x.id === t.dataset.id);
      if (!u) break;
      const next = u.status === 'active' ? 'disabled' : 'active';
      (async () => {
        try {
          const res = await window.SunnyAPI.updatePerson(u.id, { status: next });
          toast(res.message, res.ok ? 'success' : 'error');
          if (res.ok) renderAdmin($('#main'));
        } catch (e) { toast('操作失败，请检查网络后重试', 'error'); }
      })();
      break;
    }
    case 'delete-user': {
      const u = state.users.find(x => x.id === t.dataset.id);
      if (!u) break;
      openModal({ title:'确认删除人员',
        body:`<p>确定要删除人员 <b>${esc(u.name)}</b> 吗？删除后该账号将无法继续登录，此操作不可撤销。</p>`,
        footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--danger" data-action="confirm-delete-user" data-id="${u.id}">确认删除</button>` }); break;
    }
    case 'confirm-delete-user': {
      (async () => {
        try {
          const res = await window.SunnyAPI.deletePerson(t.dataset.id);
          toast(res.message, res.ok ? 'success' : 'error');
          closeModal();
          if (res.ok) renderAdmin($('#main'));
        } catch (e) { toast('删除失败，请检查网络后重试', 'error'); }
      })();
      break;
    }
    case 'cleanup-accounts': previewAccountCleanup(); break;
    case 'cleanup-step2': accountCleanupStep2(); break;
    case 'confirm-cleanup-accounts': executeAccountCleanup(); break;
    case 'add-role': addRoleModal(); break;
    case 'confirm-add-role': confirmAddRole(); break;
    case 'delete-role': deleteRole(t.dataset.id); break;
    case 'select-role': state.admin.activeRole = t.dataset.id; renderAdminRoles($('#admin-content')); break;
    case 'perm-sub': state.admin.permSub = t.dataset.sub; renderAdminRoles($('#admin-content')); break;
    case 'add-perm': permModal(); break;
    case 'edit-perm': permModal(t.dataset.key); break;
    case 'save-perm': savePerm(t.dataset.key); break;
    case 'delete-perm': deletePerm(t.dataset.key); break;
    case 'save-view-perms': saveViewPerms(); break;
    case 'toggle-perm': {
      const r = state.roles.find(x => x.id === state.admin.activeRole);
      if (!r) break;
      const p = t.dataset.perm;
      if (t.checked) { if (!r.perms.includes(p)) r.perms.push(p); }
      else r.perms = r.perms.filter(x => x !== p);
      const btn = $('[data-action="save-role"]').parentElement.querySelector('.muted b');
      if (btn) btn.textContent = r.perms.length;
      break;
    }
    case 'save-role': {
      (async () => {
        try {
          if (t) { t.disabled = true; t.textContent = '保存中…'; }
          const roles = state.roles.map(r => ({ ...r, perms: [...r.perms] }));
          const res = await window.SunnyAPI.saveRoleConfigs(roles);
          toast(res.message, res.ok ? 'success' : 'error');
          if (res.ok) {
            // 权限分配即时生效：重建导航。若当前角色刚好失去正在访问视图的权限则回退
            renderNav();
            if (!canView(state.view)) navigate(state.view);
            else renderAdmin($('#main'));
          }
        } catch (e) { toast('保存失败，请检查网络后重试', 'error'); }
        finally { if (t) { t.disabled = false; t.textContent = '保存权限设置'; } }
      })();
      break;
    }
    case 'close-modal': closeModal(); break;
  }
});

function refreshLibraryFilterUI() {
  // 重绘筛选条激活态
  $$('[data-action="filter-grade"]').forEach(b => b.classList.toggle('is-active', b.dataset.grade === state.library.grade));
  $$('[data-action="filter-subject"]').forEach(b => b.classList.toggle('is-active', b.dataset.subject === state.library.subject));
  $$('[data-action="set-mode"]').forEach(b => b.classList.toggle('is-active', b.dataset.mode === state.library.mode));
  refreshMaterials(true);
}

// 个人简介字段行：空值统一占位，学生之外的年级字段隐藏，避免无意义信息干扰展示
function profileInfoRows(p, options = {}) {
  const rows = [];
  const add = (label, value, placeholder = '—') => rows.push(
    `<div class="info-row"><span>${label}</span><strong>${esc(value || placeholder)}</strong></div>`
  );
  add('姓名', p.name, '未填写');
  add('性别', p.gender, '未填写');
  add('年龄', p.age ? `${p.age} 岁` : '', '未填写');
  if (p.role === 'student' || p.grade) add('年级', Number(p.grade) ? gradeLabel(Number(p.grade)) : '', '未设置');
  add('部门 / 身份', p.dept || (p.role === 'parent' ? '学生家长' : ''), '未设置');
  add('手机号', p.phone, '未绑定');
  add('邮箱', p.email, '未绑定');
  add('个人签名', p.signature, '这个人很神秘，还没有留下签名');
  if (options.status) {
    rows.push(`<div class="info-row"><span>安全验证</span><strong style="color:var(--mint)">${p.verified ? '手机号 + 邮箱已验证' : '未验证'}</strong></div>`);
  }
  if (options.presence) {
    rows.push(`<div class="info-row"><span>在线状态</span><strong>${presenceText(p)}</strong></div>`);
  }
  return rows.join('');
}

function openProfile() {
  const u = state.account;
  openModal({
    title:'个人资料',
    body:`<div class="row" style="margin-bottom:var(--s5)">${avatarHTML(u,'avatar--lg')}<div><h3 style="font-size:var(--fs-lg)">${esc(u.name)}</h3><span class="role-tag ${(ROLE_META[u.role]||ROLE_META.student).cls}">${(ROLE_META[u.role]||ROLE_META.student).label}</span></div></div>
      ${profileInfoRows(u, { status: true })}`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">关闭</button><button class="btn btn--primary" data-action="open-binding">管理绑定</button>`,
  });
}

function openBindingModal() {
  closeModal();
  const u = state.account;
  const minLen = (window.APP_CONFIG?.auth?.minLength) || 6;
  const hasOwnPw = !!u.passwordHash; // 是否设置过自选口令（内置账户按默认口令处理）
  openModal({
    title:'账户安全与绑定',
    body:`<p class="muted" style="margin-bottom:var(--s5)">为保障账号安全，请保持手机号和邮箱处于已验证状态；你也可以在此更换绑定邮箱或修改登录密码。</p>
      <div class="field"><label class="field__label" for="bind-edit-phone">绑定手机号</label>
        <div class="input-group">${icon('i-phone')}<input class="input" id="bind-edit-phone" type="tel" maxlength="11" value="${esc(String(u.phone||'').replace(/\*/g,''))}" placeholder="11 位手机号" /></div></div>
      <div class="field"><label class="field__label" for="bind-edit-email">绑定邮箱</label>
        <div class="input-group">${icon('i-mail')}<input class="input" id="bind-edit-email" type="email" value="${esc(u.email||'')}" placeholder="name@example.com" /></div></div>
      <div class="bind-summary">
        <div class="bind-summary__row">${icon('i-shield-check')}<div><strong>${u.verified ? '已完成邮箱验证' : '尚未完成邮箱验证'}</strong><small>验证状态${u.emailVerifiedAt?' · '+esc(String(u.emailVerifiedAt).slice(0,10)):''}</small></div><span class="status-tag" style="color:${u.verified?'var(--mint)':'var(--warning)'};margin-left:auto">${icon('i-check','icon--sm')} ${u.verified?'已验证':'未验证'}</span></div>
      </div>
      <div class="auth-divider" style="margin:var(--s5) 0"><span>修改登录密码</span></div>
      <div class="field"><label class="field__label" for="pwd-current">当前密码${hasOwnPw?'':'（默认 '+esc((window.APP_CONFIG?.auth?.defaultPassword)||'123456')+'）'}</label>
        <div class="input-group">${icon('i-lock')}<input class="input" id="pwd-current" type="password" autocomplete="current-password" placeholder="请输入当前密码" /></div></div>
      <div class="row" style="gap:var(--s4)">
        <div class="field grow"><label class="field__label" for="pwd-new">新密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="pwd-new" type="password" autocomplete="new-password" placeholder="至少 ${minLen} 位" /></div></div>
        <div class="field grow"><label class="field__label" for="pwd-confirm">确认新密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="pwd-confirm" type="password" autocomplete="new-password" placeholder="再次输入新密码" /></div></div>
      </div>
      <span class="field__error" id="bind-edit-err"></span>
      <span class="field__error" id="pwd-err"></span>
      <p class="field__hint">${state.cloudMode
        ? '云端账号：绑定邮箱、手机号与口令均保存到云端，换设备使用账号密码登录；邮箱验证码仅用于忘记密码时验证身份。'
        : '演示环境：口令以哈希形式保存在本机；仅首次登录需完成邮箱验证，验证后不再重复。'}`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">取消</button><button class="btn btn--ghost" data-action="save-password">修改密码</button><button class="btn btn--primary" data-action="save-binding">保存绑定</button>`,
  });
}

async function saveBinding() {
  const errEl = $('#bind-edit-err');
  if (errEl) errEl.textContent = '';
  const phone = ($('#bind-edit-phone')?.value || '').trim();
  const email = ($('#bind-edit-email')?.value || '').trim();
  if (phone && !/^1\d{10}$/.test(phone)) return errEl && (errEl.textContent = '请输入有效的 11 位手机号');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errEl && (errEl.textContent = '请输入有效的邮箱地址');

  const u = state.account;
  const patch = {
    email,
    phone: phone ? phone.slice(0, 3) + '****' + phone.slice(-4) : u.phone,
    verified: true,
  };

  // 云端账户：必须先写回 profiles 表，失败则中止，避免“本地成功、云端丢失”的假象
  if (state.cloudMode && window.SunnyAPI && window.SunnyAPI.updateCloudProfile) {
    const btn = $('[data-action="save-binding"]');
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    try {
      const res = await window.SunnyAPI.updateCloudProfile({ phone, email, emailVerified: true });
      if (!res.ok) {
        if (btn) { btn.disabled = false; btn.textContent = '保存绑定'; }
        if (errEl) errEl.textContent = res.message;
        toast(res.message, 'error');
        return;
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '保存绑定'; }
      if (errEl) errEl.textContent = '云端同步异常，请稍后重试';
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = '保存绑定'; }
  }

  // 本地账户与界面同步（云端账户也保留一份本机缓存，供离线查看）
  Object.assign(u, patch);
  const idx = state.users.findIndex(x => String(x.id) === String(u.id));
  if (idx >= 0) state.users[idx] = { ...state.users[idx], ...patch };
  else state.users.unshift({ ...u });
  persist();
  closeModal();
  renderShell();
  toast(state.cloudMode ? '绑定信息已保存到云端' : '绑定信息已更新');
}

async function savePassword() {
  const bindErr = $('#bind-edit-err'); if (bindErr) bindErr.textContent = '';
  const errEl = $('#pwd-err'); if (errEl) errEl.textContent = '';
  // 绑定信息未保存时给出引导，避免用户以为密码已随绑定一起保存
  const phone = ($('#bind-edit-phone')?.value || '').trim();
  const email = ($('#bind-edit-email')?.value || '').trim();
  const u = state.account;
  if (email !== u.email || (phone && phone !== String(u.phone || '').replace(/\*/g, ''))) {
    if (errEl) errEl.textContent = '请先点击「保存绑定」保存手机号/邮箱，再修改密码';
    return;
  }
  const payload = {
    userId: u.id,
    currentPassword: $('#pwd-current')?.value || '',
    newPassword: $('#pwd-new')?.value || '',
  };
  if (payload.newPassword !== ($('#pwd-confirm')?.value || '')) {
    if (errEl) errEl.textContent = '两次输入的新密码不一致';
    return;
  }
  let res;
  if (state.cloudMode && window.SunnyAPI && window.SunnyAPI.setCloudPassword) {
    const btn = $('[data-action="save-password"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      res = await window.SunnyAPI.setCloudPassword({
        currentPassword: payload.currentPassword,
        newPassword: payload.newPassword,
        confirmPassword: $('#pwd-confirm')?.value || '',
      });
    } catch (e) {
      res = { ok: false, message: '改密异常，请稍后重试' };
    }
    if (btn) { btn.disabled = false; btn.textContent = '修改密码'; }
  } else {
    res = window.SunnyAPI.setPassword(payload);
  }
  if (!res.ok) {
    if (errEl) errEl.textContent = res.message;
    toast(res.message, 'error');
    return;
  }
  closeModal();
  toast(state.cloudMode ? '登录密码已保存到云端' : '登录密码已更新，下次登录请使用新密码');
}

function showMemberInfo(m) {
  const role = roleViewOf(m.role);
  openModal({
    title:'个人简介',
    body:`<div class="row" style="margin-bottom:var(--s5)">${avatarHTML(m,'avatar--lg')}<div><h3 style="font-size:var(--fs-lg)">${esc(m.name)}</h3><span class="role-tag ${role.cls}">${esc(role.label)}</span><small class="muted" style="display:block;margin-top:2px">${esc(m.title || role.label)}</small></div></div>
      ${profileInfoRows(m, { presence: true })}`,
    footer:`<button class="btn btn--ghost" data-action="close-modal">关闭</button><button class="btn btn--primary" data-action="msg-from-profile" data-id="${m.id}">发送消息</button>`,
  });
}

/* ---------- 全局搜索 ---------- */
$('#global-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (!q) return;
    if (state.view === 'directory') { state.directory.query = q; renderDirectory($('#main')); toast(`已搜索成员「${q}」`, 'info'); }
    else { state.library.query = q; if (state.view !== 'library') navigate('library'); else refreshLibraryFilterUI(); toast(`已搜索资料「${q}」`, 'info'); }
  }
});
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);

  // 键盘激活带 role="button" 的卡片（Enter / 空格）
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.matches?.('.material-card[role="button"]')) {
    e.preventDefault();
    document.activeElement.click();
    return;
  }

  // 弹窗内 Tab 焦点陷阱，避免焦点穿透到背景
  const dialog = $('#modal-root [role="dialog"], #drawer-root [role="dialog"]');
  if (e.key === 'Tab' && dialog) {
    const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dialog)
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (f.length) {
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  if (e.key === '/' && !isTyping) {
    e.preventDefault(); $('#global-search')?.focus();
  }
  if (e.key === 'Escape') { closeModal(); closeDrawer(); closeDropdowns(); }
});

/* ---------- 学习感悟实时同步：云端轮询 + 本地跨标签 storage 事件 ---------- */
let shareSyncTimer = null;
function startShareRealtime() {
  if (shareSyncTimer) return;
  const secs = Math.max(3, Number(window.APP_CONFIG?.shareSyncSeconds) || 12);
  shareSyncTimer = setInterval(() => {
    if (!state.authed) return;
    // 云端模式：无论当前视图都定期拉取感悟（含评论）。
    // 这样另一台设备删除全部感悟后，本设备无需刷新即可更新列表与相关统计。
    if (state.cloudMode && !state.cloudStale && window.cloud) loadCloudShares({ silent: true });
    // 广播通知：无论当前视图都定期拉取，确保新通知及时送达铃铛
    if (state.cloudMode && !state.cloudStale && window.cloud) loadCloudNotices();
    // 跨设备同步：手机/电脑的资料、权限与工作区保持一致
    if (typeof pullAllSync === 'function') pullAllSync();
  }, secs * 1000);
}

/* ---------- 跨标签同步：共享会话清单与感悟变化，保持各标签登录态一致 ---------- */
function onSharedStorageChange(e) {
  const key = String((e && e.key) || '');
  const base = String((window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1');
  // 演示通话信令：另一标签写入时，本标签立即拉取一次（无需等轮询）
  if (key === callStorageKey()) { pollCallSignals(); return; }
  if (key && key !== base) return;
  const saved = window.SunnyStore && window.SunnyStore.load();
  if (!saved) return;
  // 感悟实时同步：其它标签发布/评论/点赞/删除后，本标签即时刷新；去重避免重复数据
  if (Array.isArray(saved.shares)) {
    state.shares = window.SunnyAPI.normalizeShares(saved.shares);
    refreshShareDependentViews();
  }
  // 广播通知同步：其它标签发布/删除/已读后，本标签即时刷新铃铛与列表（本地模式跨标签送达）
  if (window.SunnyAPI && window.SunnyAPI.normalizeNotice) {
    if (Array.isArray(saved.notices)) {
      state.notices = saved.notices.map(n => window.SunnyAPI.normalizeNotice(n)).filter(Boolean);
      syncNoticesToNotifications();
      renderNotifications();
      if (state.view === 'notices') renderNotices($('#main'));
    }
    if (saved.backup && typeof saved.backup === 'object') state.backup = { ...state.backup, ...saved.backup };
  }
  // 会话清单同步：按本标签活动指针校正，不影响本标签当前显示的账户
  if (Array.isArray(saved.sessions)) {
    state.sessions = saved.sessions;
    if (typeof saved.activeSessionId === 'string') state.activeSessionId = saved.activeSessionId;
    if (window.SunnyAPI) window.SunnyAPI.refreshSessionsFromShared();
    if (state.authed) renderSessionMenu();
  }
}
window.addEventListener('storage', onSharedStorageChange);

/* ==========================================================================
   模块：闲置超时二次验证（30 分钟无操作 → 输入当前账户密码恢复）
   设计：全局用户活动刷新当前会话 lastActivityAt；定时器每秒检查闲置时长，
   超限则锁定（reauth.required=true）并弹出验证层；验证只校验当前账户密码，
   不重新走登录向导、不清空数据，验证通过后重置计时原地恢复。
   ========================================================================== */
const reauthLayer = $('#reauth-layer');
let activityThrottleTimer = null;
let idleCheckTimer = null;
const ACTIVITY_EVENTS = ['pointerdown','keydown','scroll','touchstart','mousemove'];

function markUserActivity() {
  if (!state.authed || state.reauth.required) return;
  const active = (state.sessions || []).find(s => s && s.id === state.activeSessionId);
  if (active) {
    Object.assign(active, window.SunnyAPI.stampActivity());
    active.lastActiveAt = active.lastActivityAt;
    if (state.account) { state.account.lastActivityAt = active.lastActivityAt; }
  }
  state.lastActivityAt = Date.now();
  if (activityThrottleTimer) return;
  activityThrottleTimer = setTimeout(() => { activityThrottleTimer = null; persist(); }, 1500);
}
function lastActivityTs() {
  const active = (state.sessions || []).find(s => s && s.id === state.activeSessionId);
  const iso = (active && active.lastActivityAt) || state.lastActivityAt || state.account?.lastActivityAt;
  const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
  return Number.isFinite(t) ? t : Date.now();
}
function checkIdleTimeout() {
  if (!state.authed || state.reauth.required) return;
  const idle = Date.now() - lastActivityTs();
  if (idle >= window.SunnyAPI.idleTimeoutMs()) triggerReauth();
}
function triggerReauth() {
  state.reauth.required = true;
  state.reauth.at = Date.now();
  const acc = state.account || {};
  reauthLayer.innerHTML = `
    <div class="reauth-card">
      <div class="reauth-brand"><span class="brand__mark">${icon('i-sun')}</span> Sunshine个人工作站.</div>
      <div class="reauth-icon">${icon('i-lock')}</div>
      <h2>为了您的账号安全</h2>
      <p class="muted">已超过 ${Math.round(window.SunnyAPI.idleTimeoutMs()/60000)} 分钟无操作，请输入当前账户密码重新验证。</p>
      <div class="reauth-account">${avatarHTML(acc)}${icon('i-user','icon--sm')} ${esc(acc.name || acc.email || '当前账户')}</div>
      <form id="reauth-form">
        <div class="field"><label class="field__label" for="reauth-password">当前账户密码</label>
          <div class="input-group">${icon('i-lock')}<input class="input" id="reauth-password" type="password" autocomplete="current-password" placeholder="请输入登录密码" autofocus /></div></div>
        <span class="field__error" id="reauth-err"></span>
        <button class="btn btn--primary btn--block" type="submit">验证并继续</button>
      </form>
      <button class="link-btn reauth-logout" data-action="reauth-logout">退出当前账户</button>
    </div>`;
  reauthLayer.classList.remove('hidden');
  $('#reauth-password')?.focus();
  $('#reauth-form')?.addEventListener('submit', verifyReauth);
}
async function verifyReauth(e) {
  e.preventDefault();
  const err = $('#reauth-err'); if (err) err.textContent = '';
  const pw = $('#reauth-password')?.value || '';
  if (!pw) { if (err) err.textContent = '请输入密码'; return; }
  const acc = state.account || {};
  const btn = reauthLayer.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }
  try {
    // 优先用统一接口的本地口令校验；云端登录模式用 SDK 密码登录作二次身份确认
    let passed = false;
    if (window.SunnyAPI && acc.id) {
      const res = window.SunnyAPI.verifyPassword({ userId: acc.id, password: pw });
      if (res && res.ok && res.data && res.data.valid) passed = true;
    }
    if (!passed && state.cloudMode && window.cloud && acc.email) {
      try {
        const r = await window.cloud.auth.signInWithPassword({ email: acc.email, password: pw });
        if (r && !r.error) passed = true;
      } catch (_) {}
    }
    if (!passed) { if (err) err.textContent = '密码不正确，请重试'; return; }
    // 验证通过：重置计时并原地恢复，不重新渲染登录页
    state.reauth.required = false; state.reauth.at = null;
    const now = new Date().toISOString();
    const active = (state.sessions || []).find(s => s && s.id === state.activeSessionId);
    if (active) { Object.assign(active, window.SunnyAPI.stampActivity()); }
    state.lastActivityAt = Date.now();
    reauthLayer.classList.add('hidden');
    reauthLayer.innerHTML = '';
    persist();
    toast('身份验证通过，已继续登录');
  } catch (ex) {
    if (err) err.textContent = '验证失败，请稍后重试';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '验证并继续'; }
  }
}
function startIdleWatcher() {
  ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, markUserActivity, { passive:true }));
  if (idleCheckTimer) clearInterval(idleCheckTimer);
  idleCheckTimer = setInterval(checkIdleTimeout, 1000);
}
(function bindReauthLogout() {
  document.addEventListener('click', e => {
    const t = e.target && e.target.closest && e.target.closest('[data-action="reauth-logout"]');
    if (!t) return;
    state.reauth.required = false;
    reauthLayer.classList.add('hidden'); reauthLayer.innerHTML = '';
    if (typeof logoutCurrentSession === 'function') logoutCurrentSession();
  });
})();

/* ==========================================================================
   模块：跨设备同步（手机 / 电脑资料与权限一致）
   user_sync 三域：workspace（工作区数据）、account（资料+权限）、schedule（课程表）。
   云端登录成功后拉取；本地变更节流上传；定时轮询拉取，updatedAt 较新者胜出。
   ========================================================================== */
let syncPushTimers = {};
// 本地账号登录时也要做跨设备同步：旧实现强制 state.cloudMode，导致本地 admin 登录后
// 账号域（含口令哈希）永不上传/拉取，这正是电脑端与手机端密码不一致的根因之一。
function cloudSyncReady() { return !state.cloudStale && state.authed && !!window.cloud; }
function scheduleSyncPush(scope) {
  if (!cloudSyncReady()) return;
  if (syncPushTimers[scope]) clearTimeout(syncPushTimers[scope]);
  syncPushTimers[scope] = setTimeout(() => { syncPushTimers[scope] = null; pushSyncScope(scope); }, 1200);
}
async function pushSyncScope(scope) {
  if (!cloudSyncReady() || !window.SunnyAPI.pushUserSync) return false;
  const payload = window.SunnyAPI.buildUserSyncPayload(state, scope);
  const res = await window.SunnyAPI.pushUserSync(scope, payload);
  if (res.ok) state.syncMeta[scope] = payload.updatedAt;
  return !!(res && res.ok);
}
async function pullSyncScope(scope, apply) {
  if (!cloudSyncReady() || !window.SunnyAPI.pullUserSync) return false;
  const res = await window.SunnyAPI.pullUserSync(scope);
  if (!res.ok || !res.data) return false;
  const row = res.data;
  const localMeta = state.syncMeta[scope];
  if (!window.SunnyAPI.shouldApplySync(localMeta, row.updatedAt, null, row.payload)) return true;
  if (apply(row.payload)) {
    state.syncMeta[scope] = row.updatedAt;
    suppressSyncPush = true; // 仅落本地存储，不回推，避免回声循环
    try { persist(); } finally { suppressSyncPush = false; }
  }
  return true;
}
/* 口令跨设备统一的核心：云端 authSecrets（兼容旧版 authSecret）按身份匹配本地账户。
   历史缺陷（导致 admin 密码被工号覆盖、两端登录不一致）：
   - 旧实现把 name / username 也当作身份键。新工号若 username='admin'（历史脏数据），
     其 secret 的别名就会与超管 name='admin' 交叉命中，applyAuthSecrets 遍历时按
     "后写覆盖"把坏哈希互相覆盖，最终两端同一账户落到不同（甚至无效）哈希。
   - alises 顺序不确定 + 多账户多对多命中，无法保证一条 secret 只归属一个账户。
   现在改为强身份匹配：
   ① 只用 email、u_/p_ 前缀 id、owner_id、uid 这类强键；姓名 / 'admin' 这类弱键一律不参与；
   ② 一条 secret 只绑定到唯一本地账户（强键命中数>1 时按 email > id > owner_id 优先级择一），
      从根上杜绝交叉污染。旧云端数据即便仍含脏别名也会被强键过滤掉。 */
function strongIdentityKeysOf(u) {
  if (!u) return { email: '', ids: [] };
  const email = String(u.email || '').trim().toLowerCase();
  const ids = [];
  const pushId = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    // 强 id 仅认带 u_ / p_ 前缀的内部 id、纯认证 uid（长数字串）与 owner_id；
    // 姓名与 'admin' / 'teacher' 这类角色词不算身份，避免与超管交叉命中。
    if (!s) return;
    if (/^[up]_/.test(s) || /^\d{8,}$/.test(s)) ids.push(s);
  };
  pushId(u.id); pushId(u.owner_id); pushId(u.uid);
  return { email, ids: Array.from(new Set(ids)) };
}
function matchSecretUser(sec) {
  if (!sec || !sec.passwordHash) return null;
  const cand = [];
  // 优先使用新格式的显式强身份字段；缺失时回退到 accountKey + aliases 中的强键。
  const email = String(sec.email || sec.accountKey || '').trim().toLowerCase();
  if (email.indexOf('@') > 0) cand.push({ kind: 'email', key: email });
  (Array.isArray(sec.strongKeys) ? sec.strongKeys : []).forEach((v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s.indexOf('@') > 0) cand.push({ kind: 'email', key: s });
    else if (/^[up]_/.test(s) || /^\d{8,}$/.test(s)) cand.push({ kind: 'id', key: s });
  });
  (Array.isArray(sec.aliases) ? sec.aliases : []).forEach((v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s.indexOf('@') > 0) cand.push({ kind: 'email', key: s });
    else if (/^[up]_/.test(s) || /^\d{8,}$/.test(s)) cand.push({ kind: 'id', key: s });
  });
  // 优先级：email 命中 > id 命中；同优先级取首个。只绑定唯一账户。
  const priority = { email: 0, id: 1 };
  cand.sort((a, b) => priority[a.kind] - priority[b.kind]);
  let best = null;
  (state.users || []).forEach((u) => {
    if (!u || u.status === 'disabled') return;
    const own = strongIdentityKeysOf(u);
    let rank = 2;
    cand.forEach((c) => {
      if (c.kind === 'email' && own.email && own.email === c.key) rank = Math.min(rank, 0);
      else if (c.kind === 'id' && own.ids.indexOf(c.key) >= 0) rank = Math.min(rank, 1);
    });
    if (rank < 2 && (!best || rank < best.rank)) best = { user: u, rank };
  });
  return best ? best.user : null;
}
function applyAuthSecrets(payload) {
  const p = payload || {};
  const list = Array.isArray(p.authSecrets) && p.authSecrets.length
    ? p.authSecrets
    : (p.authSecret ? [p.authSecret] : []);
  let changed = false;
  list.forEach((sec) => {
    const target = matchSecretUser(sec);
    if (!target) return;
    if (target.passwordHash !== sec.passwordHash) { target.passwordHash = sec.passwordHash; changed = true; }
    if (state.account && state.account !== target) {
      const mine = strongIdentityKeysOf(state.account);
      const t = strongIdentityKeysOf(target);
      const same = (mine.email && mine.email === t.email) ||
        mine.ids.some(id => t.ids.indexOf(id) >= 0);
      if (same && state.account.passwordHash !== sec.passwordHash) {
        state.account.passwordHash = sec.passwordHash; changed = true;
      }
    }
  });
  return changed;
}
// 工作区域应用：恢复筛选、会话、通知、学习、表情、工号名录等私有数据
function applyWorkspaceSyncPayload(p) {
  const fields = window.SunnyAPI.SYNC_FIELDS;
  fields.forEach(k => { if (p[k] !== undefined && k !== 'schedules') state[k] = p[k]; });
  // 工号跨设备一致：workspace 域携带的人员名录合并到本机（按 id/email 去重，云端数据为准）。
  // 不覆盖本机当前登录账户的敏感字段（passwordHash/status/is_admin 以本机为准，避免锁死自己）。
  if (Array.isArray(p.users) && p.users.length) {
    // 去重键以 id 为权威（云端 p_/u_ id 全局唯一），email 为辅；
    // 旧实现仅按 email，导致本地 admin@sunny.edu.cn 与云端 3440576634@qq.com
    // 虽同为 u_superadmin 却各留一条，出现"两个超管"。
    const idKey = u => /^[up]_/.test(String(u && u.id || '')) ? String(u.id).toLowerCase() : '';
    const mailKey = u => String((u && u.email) || '').toLowerCase();
    const samePerson = (a, b) => {
      const ai = idKey(a), bi = idKey(b);
      if (ai && bi && ai === bi) return true; // id 相同即同一人
      const am = mailKey(a), bm = mailKey(b);
      return !!am && !!bm && am === bm;
    };
    const mine = state.account;
    const merged = (state.users || []).slice();
    p.users.forEach((u) => {
      if (!u || !u.email) return;
      const idx = merged.findIndex(x => samePerson(x, u));
      if (idx >= 0) {
        const isMine = mine && samePerson(mine, u);
        if (isMine) {
          // 保留本机会话态字段（不覆盖 passwordHash 由 applyAuthSecrets 统一处理）
          const keep = ['passwordHash','lastActivityAt','presence'];
          const next = Object.assign({}, merged[idx], u);
          keep.forEach(k => { if (merged[idx][k] !== undefined) next[k] = merged[idx][k]; });
          merged[idx] = next;
        } else {
          merged[idx] = Object.assign({}, merged[idx], u);
        }
      } else {
        merged.push(u);
      }
    });
    // 兜底：若本机仍残留 id 相同但 email 不同的重复超管，按 id 去重（保留云端/较新一条）
    const seenIds = new Set();
    const dedup = [];
    merged.forEach(u => {
      const k = idKey(u);
      if (k && seenIds.has(k)) return;
      if (k) seenIds.add(k);
      dedup.push(u);
    });
    state.users = dedup;
    if (typeof syncDirectoryNow === 'function') syncDirectoryNow();
  }
  syncNoticesToNotifications(); renderNotifications();
  if (state.view === 'shares') renderShares($('#main'));
  if (state.view === 'directory') { refreshMemberList(); renderChat(); }
  if (state.view === 'notices') renderNotices($('#main'));
  if (state.view === 'library') refreshLearningPanel();
  return true;
}

// 账户域应用：资料与权限以云端为权威，确保手机 / 电脑显示一致
function applyAccountSyncPayload(p) {
  if (p.account && state.account) {
    const keep = ['id','uid','passwordHash','status','is_admin'];
    const merged = Object.assign({}, state.account, p.account);
    keep.forEach(k => { if (state.account[k] !== undefined) merged[k] = state.account[k]; });
    state.account = merged;
    const idx = state.users.findIndex(u => String(u.id) === String(merged.id));
    if (idx >= 0) state.users[idx] = Object.assign({}, state.users[idx], merged);
  }
  // 口令跨设备统一：覆盖超管与所有普通账户，按身份别名匹配；见 applyAuthSecrets 注释。
  applyAuthSecrets(p);
  if (Array.isArray(p.roles) && p.roles.length) state.roles = p.roles;
  if (p.viewPerms && typeof p.viewPerms === 'object') state.viewPerms = Object.assign({}, DEFAULT_VIEW_PERMISSIONS, p.viewPerms);
  if (Array.isArray(p.permissions) && p.permissions.length) {
    const customs = p.permissions.filter(x => !BUILTIN_PERMISSIONS.some(b => b.key === x.key));
    state.permissions = [...BUILTIN_PERMISSIONS.map(x => ({...x})), ...customs];
  }
  renderShell(); navigate(state.view);
  return true;
}

// 课程表域应用：云端同步的节次按 classKey 覆盖本机，保留云端没有的班级，避免清空
function applyScheduleSyncPayload(p) {
  const incoming = Array.isArray(p.schedules)
    ? p.schedules.map(s => window.SunnyAPI.normalizeScheduleSlot(s)).filter(Boolean) : [];
  if (!incoming.length) return false;
  const keys = new Set(incoming.map(s => s.classKey).filter(Boolean));
  const kept = (state.schedules || []).filter(s => !keys.has(s.classKey));
  state.schedules = kept.concat(incoming);
  if (state.view === 'schedule') renderSchedule($('#main'));
  return true;
}

const REALTIME_SYNC_SCOPES = ['workspace', 'account', 'schedule'];
const REALTIME_SYNC_APPLY = {
  workspace: applyWorkspaceSyncPayload,
  account: applyAccountSyncPayload,
  schedule: applyScheduleSyncPayload,
};

async function pullAllSync() {
  if (!cloudSyncReady()) return;
  // 工作区 / 账户 / 课程表三域全部拉取，较新者胜出（shouldApplySync 内部判定）
  for (const scope of REALTIME_SYNC_SCOPES) {
    await pullSyncScope(scope, REALTIME_SYNC_APPLY[scope]);
  }
}

/* ==========================================================================
   管理后台「实时同步」：主动与云端校验并双向同步
   --------------------------------------------------------------------------
   流程：① 校验三域云端元数据 → ② 拉取云端较新的域（较新者胜出）→
        ③ 把本机最终数据推送到云端（确保云端也拿到本机较新的变更）。
   安全约束：
   - 防重复点击：realtimeSyncInFlight 期间忽略再次触发；
   - 不覆盖云端最新：拉取/推送都复用 shouldApplySync 时间戳判定，云端较新先落地本机；
   - 不产生重复数据：工号按 id 去重、感悟/资料按 id 归并（沿用各 apply 逻辑）；
   - 异常兜底：网络异常、云服务未就绪、校验失败均给出明确文案与「重试」。
   ========================================================================== */
let realtimeSyncInFlight = false;
let realtimeSyncStatus = ''; // '' | 'syncing' | 'success' | 'error'
let realtimeSyncMessage = '';

function renderRealtimeSyncBar() {
  const bar = $('#realtime-sync-bar');
  if (!bar) return;
  if (!realtimeSyncStatus) { bar.className = 'realtime-sync-bar hidden'; bar.innerHTML = ''; return; }
  const iconId = realtimeSyncStatus === 'syncing' ? 'i-refresh' : realtimeSyncStatus === 'success' ? 'i-check' : 'i-x';
  bar.className = `realtime-sync-bar is-${realtimeSyncStatus}`;
  bar.innerHTML = `
    <span class="realtime-sync-bar__dot">${icon(iconId, 'icon--sm')}</span>
    <span class="realtime-sync-bar__text">${esc(realtimeSyncMessage)}</span>
    ${realtimeSyncStatus === 'error'
      ? `<button class="btn btn--ghost btn--sm" data-action="realtime-sync">${icon('i-refresh','icon--sm')} 重试</button>` : ''}`;
  const btn = $('#btn-realtime-sync');
  if (btn) {
    btn.disabled = realtimeSyncStatus === 'syncing';
    btn.classList.toggle('is-syncing', realtimeSyncStatus === 'syncing');
  }
}
function setRealtimeSyncStatus(status, message) {
  realtimeSyncStatus = status;
  realtimeSyncMessage = message || '';
  renderRealtimeSyncBar();
}

async function realtimeSyncNow() {
  if (realtimeSyncInFlight) return; // 防重复点击
  realtimeSyncInFlight = true;
  setRealtimeSyncStatus('syncing', '正在与云端校验并同步最新数据…');
  try {
    if (!window.SunnyAPI || typeof window.SunnyAPI.checkRealtimeSync !== 'function') {
      throw new Error('同步接口未就绪，请刷新页面后重试');
    }
    if (!window.cloud) throw new Error('云服务未就绪，请检查网络后重试');
    if (state.cloudStale) throw new Error('云端连接已失效，请重新登录后重试');

    // ① 主动校验三域云端元数据
    const check = await window.SunnyAPI.checkRealtimeSync(state.syncMeta, REALTIME_SYNC_SCOPES);
    if (!check || !check.ok) {
      throw new Error((check && check.message) || '云端校验失败，请检查网络后重试');
    }
    const reports = (check.data && check.data.reports) || [];
    const failedScopes = reports.filter(r => !r.ok).map(r => r.scope);
    const needPull = reports.filter(r => r.ok && r.remoteNewer).map(r => r.scope);

    // ② 拉取云端较新的域：应用后写回本机，避免覆盖本机较新数据
    let applied = 0;
    for (const scope of needPull) {
      await pullSyncScope(scope, REALTIME_SYNC_APPLY[scope]);
      applied++;
    }

    // ③ 推送三域，确保云端也拿到本机较新的变更（拉取后 state 已是收敛结果）
    const pushFailed = [];
    for (const scope of REALTIME_SYNC_SCOPES) {
      const pushed = await pushSyncScope(scope);
      if (!pushed) pushFailed.push(scope);
    }

    // 校验或推送失败 → 明确提示重试；否则成功
    const allFailed = failedScopes.concat(pushFailed.filter(s => failedScopes.indexOf(s) < 0));
    if (allFailed.length) {
      const label = allFailed.join('、');
      setRealtimeSyncStatus('error', `同步未完成：${label} 校验/上传失败，请检查网络后重试`);
      toast(`部分数据同步失败（${label}）`, 'error');
      return;
    }
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setRealtimeSyncStatus('success', `同步成功 · ${at} · 已校验 3 个数据域${applied ? `，更新 ${applied} 个` : '，均为最新'}`);
    toast('各端数据已与云端保持一致');
    // 同步完成后如仍在后台，刷新视图以呈现最新统计/名录
    if (state.view === 'admin') renderAdmin($('#main'));
  } catch (e) {
    const msg = '同步失败：' + ((e && e.message) ? e.message : '网络异常，请检查网络后重试');
    setRealtimeSyncStatus('error', msg);
    toast(msg, 'error');
  } finally {
    realtimeSyncInFlight = false;
  }
}

// 备份目标复选框：勾选 NAS 时显示 WebDAV 设置项
document.addEventListener('change', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('bk-target')) refreshBackupTargetFields();
});

/* ---------- 启动 ---------- */
hydrate();
purgeSeedDemoUsers(); // 剔除内置演示账户，避免其重新出现在人员管理
syncViewportMode();   // 按分辨率识别电脑 / 平板 / 手机与横竖屏
bindApiContext();
let viewportResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(viewportResizeTimer);
  viewportResizeTimer = setTimeout(syncViewportMode, 120);
}, { passive: true });
window.addEventListener('orientationchange', () => setTimeout(syncViewportMode, 180), { passive: true });
// 会话校准：先收编旧登录态，再剔除失效/过期会话，按本标签活动指针恢复登录
if (window.SunnyAPI) window.SunnyAPI.adoptCurrentSession();
if (window.SunnyAPI) window.SunnyAPI.reconcileSessions();
syncDirectoryNow();
ensureSuperAdmin(); // 首次初始化默认超管 admin/123456（幂等，不覆盖已有账号）
// 会话门闸：若本次浏览器会话没有登录标记（关闭浏览器后重新打开），
// 即使 localStorage 里残留登录态/会话快照，也一律清除，强制回到登录页。
// 放在会话校准之后，确保 reconcileSessions 恢复的登录态也被清除。
if (!sessionGateAllowsRestore()) {
  state.authed = false;
  state.remember = false;
  state.sessions = [];
  state.activeSessionId = null;
  state.cloudAuthKey = null;
  state.cloudStale = false;
  state.cloudMode = false;
  clearSessionGate();
  if (typeof persist === 'function') persist(); // 同步清理 localStorage 中的登录态残留
}
// 工具页返回：从首页进入图片/文字转文档再关闭返回时，本次浏览器会话内应回到登录后的操作首页。
// 未勾选"记住登录状态"时登录态仅存内存，跨页面重载会丢失；这里在会话门闸有效（本次浏览器
// 会话确实登录过）的前提下，依据工具页写入的返回标记，在会话内恢复登录态。标记读取后立即清除，
// 不写回 localStorage，因此不改变"未勾选时重新打开浏览器仍需登录"的既有语义。
(function restoreSessionAfterToolReturn() {
  try {
    const s = sessionStorageRef();
    const key = ((window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1') + ':tool-return';
    if (!s || s.getItem(key) !== '1') return;
    s.removeItem(key);
    if (!sessionGateAllowsRestore()) return; // 会话门闸无效：不恢复（关浏览器重开的场景）
    const saved = window.SunnyStore && window.SunnyStore.load();
    if (!saved || !saved.account) return;
    state.account = { ...state.account, ...saved.account };
    if (['student','teacher','headteacher','admin'].includes(saved.role)) state.role = saved.role;
    state.authed = true;
    markSessionLoggedIn();
  } catch (e) {}
})();

function showApp() {
  authLayer.classList.add('hidden');
  $('#app').classList.remove('hidden');
  onUserComeOnline(); // 上线：把离线期间的通话/消息事件补记到聊天记录
  renderShell();
  syncNoticesToNotifications();
  renderNotifications();
  navigate(state.view);
  startShareRealtime();
  startIdleWatcher();
  restartBackupTimer(); // 超管自动备份定时（页面打开时）
  if (typeof pullAllSync === 'function') pullAllSync(); // 启动时拉取云端最新资料与权限
  if (state.cloudMode && !state.cloudStale && window.cloud) loadCloudNotices();
}

(async function startup() {
  // 云端资料库公开可读，无论是否登录都先加载完整资料
  const cloud = await window.cloudReady(6000);
  if (cloud) await loadCloudMaterials();

  // 关键：会话有效期内（含新标签/新链接）本地已恢复登录态时，直接恢复当前账户，
  // 不被云端 SDK 单凭证覆盖——避免「同一浏览器登录新账户后旧账户被顶掉」。
  if (state.authed) {
    if (cloud && state.cloudMode && !state.cloudStale) {
      try {
        const { data: session } = await cloud.auth.getSession();
        if (session && session.user) {
          await loadRoleConfigs();
          await loadCloudShares();
        }
      } catch (e) {
        console.warn('[Sunshine个人工作站] 云端会话刷新失败，沿用本地快照', e && e.message);
      }
    }
    showApp();
    return;
  }

  // 未登录：尝试用云端 SDK 会话恢复（例如刚完成密码重置后的自动登录）
  // 但浏览器会话门闸关闭时（关浏览器重开）不自动恢复，必须显式登录
  if (cloud && sessionGateAllowsRestore()) {
    try {
      const { data: session } = await cloud.auth.getSession();
      if (session && session.user) { await cloudLoginSuccess(session.user); return; }
    } catch (e) {
      console.warn('[Sunshine个人工作站] 云端会话检查失败，回退到本地登录', e && e.message);
    }
  }
  renderLogin();
})();

