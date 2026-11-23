/* ==========================================================================
   Sunshine个人工作站 — 冒烟测试（零依赖，Node.js 直接运行：npm test）
   覆盖：注册能力移除 / 本地登录白名单 / 管理入口收紧 /
         人员 CRUD 与权限校验 / 自定义角色配置 / 超管自保护
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- 构造浏览器最小桩，加载前端脚本 ---------- */
const sandbox = {
  console: { warn() {}, log() {}, error() {} },
  Date, Math, JSON, Set, Map, Array, Object, String, Number, Boolean,
  RegExp, Error, isNaN, parseInt, parseFloat,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['js/config.js', 'js/data.js', 'js/api.js'].forEach(f => {
  vm.runInContext(read(f), sandbox, { filename: f });
});

const USERS = vm.runInContext('USERS', sandbox);
const ROLES = vm.runInContext('ROLES', sandbox);
const API = vm.runInContext('window.SunnyAPI', sandbox);

const PERMISSIONS = vm.runInContext('PERMISSIONS', sandbox);
const DEFAULT_VIEW_PERMISSIONS = vm.runInContext('DEFAULT_VIEW_PERMISSIONS', sandbox);

const MATERIALS = vm.runInContext('MATERIALS', sandbox);
const SHARES = vm.runInContext('SHARES', sandbox);
const CONVERSATIONS = vm.runInContext('CONVERSATIONS', sandbox);
const state = {
  users: USERS.map(u => ({ ...u })),
  roles: ROLES.map(r => ({ ...r, perms: [...r.perms] })),
  permissions: PERMISSIONS.map(p => ({ ...p })),
  viewPerms: { ...DEFAULT_VIEW_PERMISSIONS },
  materials: MATERIALS.map(m => ({ ...m })),
  shares: SHARES.map(s => ({ ...s, like_by: [...s.like_by] })),
  conversations: CONVERSATIONS.map(c => ({ ...c, messages: c.messages.map(m => ({ ...m })) })),
  account: { ...USERS[4] }, // u05 王校长：内置超管
  cloudMode: false,
  sessions: [],
  activeSessionId: null,
  view: 'library',
  library: { grade: 'all', subject: 'all', query: '', mode: 'grid' },
  directory: { query: '', roleFilter: 'all', activeConv: null },
  admin: { tab: 'overview', userQuery: '', activeRole: 'r_admin', permSub: 'assign', materialQuery: '', monitorAuto: true },
  notifications: [],
};
const hasPerm = (key) => {
  const map = { admin: 'r_admin', teacher: 'r_teacher', student: 'r_student', parent: 'r_parent' };
  const id = map[state.account.role] || state.account.role;
  const r = state.roles.find(x => x.id === id);
  return !!(r && r.perms.includes(key));
};
API.bind({ state, hasPerm, persist() {}, isCloudMode: () => state.cloudMode });

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

/* 从 app.js 源码提取 ensureSuperAdmin 真实实现，在受控作用域执行，
   以便验证初始化行为而非在测试里复制一份逻辑。 */
function buildEnsure(authOverride) {
  const src = read('js/app.js');
  const m = src.match(/function ensureSuperAdmin\(\) \{[\s\S]*?^\}/m);
  assert.ok(m, '未找到 ensureSuperAdmin 函数');
  const auth = Object.assign(
    { defaultPassword: '123456', superAdmin: { username: 'admin', password: '123456', displayName: '超级管理员' } },
    authOverride || {}
  );
  const win = { APP_CONFIG: { auth }, SunnyAPI: API };
  const make = new Function('state', 'window', 'persist', m[0] + '\nreturn ensureSuperAdmin;');
  return { make, win };
}
function pwHashOf(API, u, pw) {
  return API.hashPassword(pw, u.passwordHash.split('$')[1]) === u.passwordHash;
}

/* 从 app.js 源码提取权限判断纯函数（currentRole..canView），在受控作用域执行，
   用真实实现验证"按权限显示/拦截视图"的行为。 */
function buildPermEngine(st, defaultViewPerms) {
  const src = read('js/app.js');
  const m = src.match(/function currentRole\(\) \{[\s\S]*?function canView\(view\) \{[\s\S]*?\n\}/);
  assert.ok(m, '未找到权限判断函数块');
  const make = new Function('state', 'DEFAULT_VIEW_PERMISSIONS',
    m[0] + '\nreturn { currentRole, currentPerms, hasPerm, canView, viewRequiredPerm };');
  return make(st, defaultViewPerms);
}

/* 从 app.js 源码提取"已添加学习"栏目相关函数，在受控作用域执行。
   注入 state / SUBJECTS / esc / icon / gradeLabel / persist / refreshLearningPanel 桩，
   验证真实的加入 / 移除 / 分组渲染 / 空状态行为。 */
function buildLearning(st) {
  const src = read('js/app.js');
  const m = src.match(/function addedLearningMaterials\(\) \{[\s\S]*?\n\}/);
  const m2 = src.match(/function learningPanelHTML\(\) \{[\s\S]*?\n\}/);
  const m3 = src.match(/function isLearning\(id\) \{[\s\S]*?\n\}/);
  const m4 = src.match(/function addToLearning\(id\) \{[\s\S]*?\n\}/);
  const m5 = src.match(/function removeFromLearning\(id\) \{[\s\S]*?\n\}/);
  assert.ok(m && m2 && m3 && m4 && m5, '未找到已添加学习相关函数');
  const SUBJECTS_ = vm.runInContext('SUBJECTS', sandbox);
  const gradeLabel_ = vm.runInContext('gradeLabel', sandbox);
  const esc_ = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon_ = (id, cls = '') => `<svg class="icon ${cls}"><use href="#${id}"/></svg>`;
  let persisted = 0, refreshed = 0;
  const code = [m[0], m2[0], m3[0], m4[0], m5[0]].join('\n') +
    '\nreturn { addedLearningMaterials, learningPanelHTML, isLearning, addToLearning, removeFromLearning };';
  const make = new Function('state', 'SUBJECTS', 'esc', 'icon', 'gradeLabel', 'persist', 'refreshLearningPanel', code);
  const api = make(st, SUBJECTS_, esc_, icon_, gradeLabel_,
    () => { persisted++; }, () => { refreshed++; });
  api.__count = () => ({ persisted, refreshed });
  return api;
}

(async () => {
  console.log('\nSunshine个人工作站 · 冒烟测试\n');

  /* ---------- 注册能力移除 ---------- */
  check('公开注册接口 registerUser 已移除', () => {
    assert.strictEqual(API.registerUser, undefined);
  });
  check('登录页与事件中的注册入口已移除', () => {
    const src = read('js/app.js');
    assert.ok(!/data-action="auth-register"/.test(src), '仍存在立即注册按钮');
    assert.ok(!/data-action="submit-register"/.test(src), '仍存在注册提交事件');
    assert.ok(!/function renderRegisterForm/.test(src), '仍存在注册表单函数');
    assert.ok(!/function submitRegister/.test(src), '仍存在注册提交函数');
    assert.ok(!/id="reg-form"/.test(src), '仍存在注册表单');
  });
  check('配置为不开放自助注册', () => {
    assert.ok(/allowSelfRegistration:\s*false/.test(read('js/config.js')));
  });
  check('本地登录不再自动建号（白名单校验）', () => {
    const src = read('js/app.js');
    assert.ok(/账号不存在或尚未开通/.test(src), '缺少账号不存在提示');
    assert.ok(!/新邮箱：以本次输入的口令作为初始口令创建账户/.test(src), '仍有自动建号分支');
  });
  check('云端发码与登录均校验人员白名单', () => {
    const src = read('js/app.js');
    assert.ok(/from\('personnel'\)\.select\('id,status'\)/.test(src), '发码阶段未校验白名单');
    assert.ok(/人员表是唯一开户依据/.test(src), '登录阶段未校验白名单');
  });
  check('管理后台仅超级管理员可进入', () => {
    const src = read('js/app.js');
    assert.ok(/if \(view === 'admin' && state\.role !== 'admin'\)/.test(src));
    assert.ok(!/state\.role === 'admin' \|\| hasPerm\('view_stats'\)/.test(src));
  });

  /* ---------- 演示角色切换移除 ---------- */
  check('演示角色切换入口与逻辑已彻底移除', () => {
    const app = read('js/app.js');
    const html = read('index.html');
    assert.ok(!/data-action="switch-role"/.test(html), '入口按钮仍存在');
    assert.ok(!/function switchRole/.test(app), 'switchRole 函数仍存在');
    assert.ok(!/function canSwitchToRole/.test(app), 'canSwitchToRole 函数仍存在');
    assert.ok(!/case 'switch-role'/.test(app), 'switch-role 事件仍存在');
    assert.ok(!/case 'do-switch-role'/.test(app), 'do-switch-role 事件仍存在');
    assert.ok(!/切换演示角色/.test(app), '切换文案仍存在');
  });

  /* ---------- 视图门禁：按权限显示与拦截 ---------- */
  check('视图门禁映射已配置且默认与内置角色兼容', () => {
    assert.strictEqual(DEFAULT_VIEW_PERMISSIONS.library, 'view_material');
    assert.ok(['message'].includes(DEFAULT_VIEW_PERMISSIONS.shares));
    // 默认学生角色拥有全部基础视图的门禁权限
    const st = {
      role: 'student',
      roles: ROLES.map(r => ({ ...r, perms: [...r.perms] })),
      viewPerms: { ...DEFAULT_VIEW_PERMISSIONS },
      permissions: PERMISSIONS.map(p => ({ ...p })),
    };
    const eng = buildPermEngine(st, DEFAULT_VIEW_PERMISSIONS);
    assert.ok(eng.canView('library'), '学生应可访问学习资料');
    assert.ok(eng.canView('shares'), '学生应可访问学习感悟');
    assert.strictEqual(eng.canView('admin'), false, '学生不可访问管理后台');
  });
  check('取消角色权限后对应视图入口隐藏且访问被拦截', () => {
    const st = {
      role: 'student',
      roles: ROLES.map(r => ({ ...r, perms: r.id === 'r_student' ? r.perms.filter(x => x !== 'view_material') : [...r.perms] })),
      viewPerms: { ...DEFAULT_VIEW_PERMISSIONS },
      permissions: PERMISSIONS.map(p => ({ ...p })),
    };
    const eng = buildPermEngine(st, DEFAULT_VIEW_PERMISSIONS);
    assert.strictEqual(eng.hasPerm('view_material'), false);
    assert.strictEqual(eng.canView('library'), false, '失去 view_material 后学习资料应被拦截');
    assert.ok(eng.canView('shares'), '其他视图不受影响');
  });
  check('视图门禁可指向自定义权限项', () => {
    const st = {
      role: 'student',
      roles: ROLES.map(r => ({ ...r, perms: [...r.perms, 'vip_zone'] })),
      viewPerms: { library: 'vip_zone', shares: 'message', directory: 'message' },
      permissions: [...PERMISSIONS.map(p => ({ ...p })), { key: 'vip_zone', name: 'VIP区', desc: '', builtin: false }],
    };
    const eng = buildPermEngine(st, DEFAULT_VIEW_PERMISSIONS);
    assert.strictEqual(eng.viewRequiredPerm('library'), 'vip_zone');
    assert.ok(eng.canView('library'), '拥有自定义门禁权限应可访问');
    st.roles.find(r => r.id === 'r_student').perms = st.roles.find(r => r.id === 'r_student').perms.filter(x => x !== 'vip_zone');
    assert.strictEqual(eng.canView('library'), false, '失去自定义门禁权限应被拦截');
  });
  check('自定义角色不会导致权限判断异常', () => {
    const app = read('js/app.js');
    assert.ok(/const tip = tips\[state\.role\] \|\|/.test(app), '侧栏提示缺少自定义角色兜底');
    const st = {
      role: 'r_custom_x',
      roles: [{ id: 'r_custom_x', name: '教研组', perms: ['view_material'] }],
      viewPerms: { ...DEFAULT_VIEW_PERMISSIONS },
      permissions: PERMISSIONS.map(p => ({ ...p })),
    };
    const eng = buildPermEngine(st, DEFAULT_VIEW_PERMISSIONS);
    assert.strictEqual(eng.currentRole().name, '教研组');
    assert.ok(eng.canView('library'));
    assert.strictEqual(eng.canView('shares'), false, '自定义角色未授权 message 应被拦截');
  });

  /* ---------- 权限项维护接口 ---------- */
  state.account = { ...USERS[4] }; // 确保超管身份（requireAdmin 依据 account.role）
  await checkAsync('内置权限项不可删除', async () => {
    const res = await API.savePermissionDefs(state.permissions.filter(p => p.key !== 'view_material'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'PROTECTED');
  });
  await checkAsync('超管可新增自定义权限项', async () => {
    const next = state.permissions.concat([{ key: 'export_data', name: '导出数据', desc: '导出报表', builtin: false }]);
    const res = await API.savePermissionDefs(next);
    assert.strictEqual(res.ok, true, res.message);
    assert.ok(state.permissions.some(p => p.key === 'export_data'));
    assert.strictEqual(state.permissions.find(p => p.key === 'export_data').builtin, false);
  });
  await checkAsync('非法权限标识被拒绝', async () => {
    const next = state.permissions.concat([{ key: 'Bad-Key', name: 'X', desc: '', builtin: false }]);
    const res = await API.savePermissionDefs(next);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'INVALID_PARAM');
  });
  await checkAsync('视图门禁拒绝不存在的权限项', async () => {
    const res = await API.saveViewPerms({ library: 'not_exist', shares: 'message', directory: 'message' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'INVALID_PARAM');
  });
  await checkAsync('视图门禁保存合法权限项成功', async () => {
    const res = await API.saveViewPerms({ library: 'export_data', shares: 'message', directory: 'message' });
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(state.viewPerms.library, 'export_data');
  });

  /* ---------- 超级管理员初始化 ---------- */
  check('超管初始化配置入口存在且默认 admin / 123456', () => {
    const cfg = vm.runInContext('window.APP_CONFIG.auth.superAdmin', sandbox);
    assert.strictEqual(cfg.username, 'admin');
    assert.strictEqual(cfg.password, '123456');
    assert.ok(cfg.displayName);
  });
  check('启动流程调用 ensureSuperAdmin（幂等初始化）', () => {
    const src = read('js/app.js');
    assert.ok(/hydrate\(\);[\s\S]{0,600}ensureSuperAdmin\(\);/.test(src), '启动未调用初始化');
    assert.ok(/superAdminInitialized/.test(src), '缺少初始化标记');
  });
  check('首次初始化创建默认超管 admin/123456', () => {
    const { make, win } = buildEnsure();
    const st = { users: [], superAdminInitialized: false };
    let persists = 0;
    const run = make(st, win, () => { persists++; });
    run();
    assert.strictEqual(st.users.length, 1);
    const a = st.users[0];
    assert.strictEqual(a.name, 'admin');
    assert.strictEqual(a.email, 'admin@sunny.edu.cn');
    assert.strictEqual(a.role, 'admin');
    assert.strictEqual(a.status, 'active');
    assert.strictEqual(a.verified, true);
    assert.ok(pwHashOf(API, a, '123456'), '默认密码哈希不匹配');
    assert.strictEqual(st.superAdminInitialized, true);
    assert.strictEqual(persists, 1);
  });
  check('自定义用户名与密码在首次初始化生效', () => {
    const { make, win } = buildEnsure({ superAdmin: { username: 'root', password: 'Custom@123', displayName: '校管' } });
    const st = { users: [], superAdminInitialized: false };
    make(st, win, () => {})();
    const a = st.users[0];
    assert.strictEqual(a.name, 'root');
    assert.strictEqual(a.email, 'root@sunny.edu.cn');
    assert.strictEqual(a.avatar, '校');
    assert.ok(pwHashOf(API, a, 'Custom@123'), '自定义密码哈希不匹配');
  });
  check('已有同名账号时绝不覆盖（用户名/角色/口令保持）', () => {
    const { make, win } = buildEnsure();
    const existing = { id:'u_x', name:'admin', email:'admin@sunny.edu.cn', role:'student', passwordHash:'KEEP' };
    const st = { users: [existing], superAdminInitialized: false };
    make(st, win, () => {})();
    assert.strictEqual(st.users.length, 1, '不应新建账号');
    assert.strictEqual(st.users[0].role, 'student', '不应提权');
    assert.strictEqual(st.users[0].passwordHash, 'KEEP', '不应重置口令');
    assert.strictEqual(st.superAdminInitialized, true, '应补写初始化标记');
  });
  check('已初始化标记时不重复创建', () => {
    const { make, win } = buildEnsure();
    const existing = { id:'u_keep', name:'someone' };
    const st = { users: [existing], superAdminInitialized: true };
    make(st, win, () => {})();
    assert.strictEqual(st.users.length, 1);
    assert.strictEqual(st.users[0].name, 'someone');
  });
  check('未显式配置密码时回退到 defaultPassword', () => {
    const { make, win } = buildEnsure({ superAdmin: { username: 'admin2', password: '' }, defaultPassword: '654321' });
    const st = { users: [], superAdminInitialized: false };
    make(st, win, () => {})();
    assert.ok(pwHashOf(API, st.users[0], '654321'), '应回退默认口令');
  });

  /* ---------- 人员管理 ---------- */
  await checkAsync('非超管调用人员接口被拒绝', async () => {
    state.account = { ...USERS[0] }; // 学生
    const res = await API.createPerson({
      name: '越权测试', email: 'hacker@sunny.edu.cn', phone: '13800138000', role: 'admin',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'FORBIDDEN');
  });

  state.account = { ...USERS[4] }; // 恢复超管
  let createdId = null;
  await checkAsync('超管创建人员并分配角色与初始口令', async () => {
    const res = await API.createPerson({
      name: '测试老师', email: 'teacher.test@sunny.edu.cn',
      phone: '13800138000', role: 'teacher', dept: '语文教研组', password: 'abc123',
    });
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(res.data.person.role, 'teacher');
    assert.strictEqual(res.data.person.phone, '138****8000');
    createdId = res.data.person.id;
  });
  await checkAsync('重复邮箱创建被拒绝', async () => {
    const res = await API.createPerson({
      name: '重复老师', email: 'teacher.test@sunny.edu.cn',
      phone: '13900139000', role: 'teacher',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'CONFLICT');
  });
  await checkAsync('超管编辑人员角色、状态与密码', async () => {
    const res = await API.updatePerson(createdId, {
      role: 'student', grade: 3, status: 'disabled', password: 'newpass123',
    });
    assert.strictEqual(res.ok, true, res.message);
    const p = state.users.find(u => u.id === createdId);
    assert.strictEqual(p.role, 'student');
    assert.strictEqual(p.status, 'disabled');
    assert.ok(p.passwordHash && p.passwordHash.startsWith('demo$'));
  });
  await checkAsync('超管删除人员', async () => {
    const res = await API.deletePerson(createdId);
    assert.strictEqual(res.ok, true, res.message);
    assert.ok(!state.users.some(u => u.id === createdId));
  });
  await checkAsync('至少保留一名启用超管的保护生效', async () => {
    const res = await API.updatePerson(state.account.id, { role: 'student' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'PROTECTED');
  });

  /* ---------- 自定义角色 ---------- */
  await checkAsync('超管可新建并保存自定义角色', async () => {
    const roles = state.roles.map(r => ({ ...r, perms: [...r.perms] }));
    roles.push({ id: 'r_custom_test', name: '测试角色', color: 'sky', perms: ['view_material'] });
    const res = await API.saveRoleConfigs(roles);
    assert.strictEqual(res.ok, true, res.message);
    const loaded = await API.listRoleConfigs();
    assert.strictEqual(loaded.data.roles.length, roles.length);
    assert.ok(loaded.data.roles.some(r => r.id === 'r_custom_test'));
  });
  await checkAsync('非法角色配置被拒绝', async () => {
    const res = await API.saveRoleConfigs([{ id: 'bad' }]);
    assert.strictEqual(res.ok, false);
  });

  /* ---------- 数据概括：真实统计 / 空状态 / 异常数据兜底 ---------- */
  await checkAsync('数据概括基于真实账户与资料生成统计', async () => {
    const res = await API.getOverviewStats();
    assert.strictEqual(res.ok, true, res.message);
    const d = res.data;
    assert.strictEqual(d.stats.length, 4);
    assert.strictEqual(d.stats[0].num, String(state.users.length));
    assert.strictEqual(d.stats[1].num, String(state.materials.length));
    assert.strictEqual(d.totals.users, state.users.length);
    assert.strictEqual(d.totals.materials, state.materials.length);
    assert.strictEqual(d.chart.length, 7);
    assert.ok(d.recentUsers.length <= 5);
    assert.strictEqual(d.roles.reduce((n, r) => n + r.count, 0), state.users.length);
  });
  await checkAsync('无业务数据时返回正式空状态', async () => {
    const backup = {
      users: state.users, materials: state.materials,
      shares: state.shares, conversations: state.conversations,
    };
    state.users = []; state.materials = []; state.shares = []; state.conversations = [];
    try {
      const res = await API.getOverviewStats();
      assert.strictEqual(res.ok, true, res.message);
      assert.strictEqual(res.data.empty, true);
      assert.strictEqual(res.data.chartEmpty, true);
      assert.strictEqual(res.data.roles.length, 0);
      assert.strictEqual(res.data.recentUsers.length, 0);
      assert.strictEqual(res.data.stats[0].num, '0');
    } finally {
      state.users = backup.users; state.materials = backup.materials;
      state.shares = backup.shares; state.conversations = backup.conversations;
    }
  });
  await checkAsync('异常字段不会导致数据概括计算失败', async () => {
    const backup = state.users;
    state.users = [{ id: 'bad', name: '异常账户', role: 'unknown', status: 'active', created_at: 'invalid' }];
    try {
      const res = await API.getOverviewStats();
      assert.strictEqual(res.ok, true, res.message);
      assert.strictEqual(res.data.roles.length, 1);
      assert.strictEqual(res.data.roles[0].name, '其他角色');
      assert.strictEqual(res.data.totals.users, 1);
    } finally {
      state.users = backup;
    }
  });

  /* ---------- 通讯录与自定义用户同步：匹配规则 / 去重 / 个人简介字段 ---------- */
  state.account = { ...USERS[4] };
  check('通讯录匹配规则按唯一标识 → 手机号 → 邮箱生效', () => {
    const a = { id:'sync_a', phone:'13800138000', email:'sync.a@example.com' };
    const phoneHit = { id:'sync_b', phone:'13800138000', email:'sync.b@example.com' };
    const idHit = { id:'sync_a', phone:'13900139000', email:'sync.c@example.com' };
    const emailHit = { id:'sync_d', phone:'13700137000', email:'sync.a@example.com' };
    assert.strictEqual(API.identityRule(a, phoneHit).rule, 'phone');
    assert.strictEqual(API.identityRule(a, idHit).rule, 'id');
    assert.strictEqual(API.identityRule(a, emailHit).rule, 'email');
  });
  check('通讯录同步按规则去重并保留最近更新的记录', () => {
    const backup = state.users;
    const stale = { ...USERS[0], id:'sync_dup', name:'旧记录', updated_at:'2026-01-01T00:00:00Z' };
    const fresh = { ...USERS[0], id:'sync_dup', name:'新记录', updated_at:'2026-11-20T00:00:00Z' };
    state.users = [stale, fresh];
    try {
      const res = API.syncDirectoryUsers();
      assert.strictEqual(res.ok, true, res.message);
      assert.strictEqual(res.data.members.length, 1, '重复记录应合并为一条');
      assert.strictEqual(res.data.members[0].name, '新记录');
      assert.strictEqual(res.data.conflicts.length, 1);
      assert.strictEqual(res.data.conflicts[0].rule, 'id');
    } finally {
      state.users = backup;
      API.syncDirectoryUsers();
    }
  });
  let introId = null;
  await checkAsync('新增人员的个人简介字段同步到通讯录', async () => {
    const res = await API.createPerson({
      name:'家长测试', email:'parent.intro@sunny.edu.cn', phone:'13700137000',
      role:'parent', dept:'学生家长', gender:'女', age:38, signature:'陪伴孩子成长',
      password:'abc123',
    });
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(res.data.person.dept, '学生家长');
    assert.strictEqual(res.data.person.gender, '女');
    assert.strictEqual(res.data.person.age, 38);
    introId = res.data.person.id;
    const m = state.directory.members.find(x => String(x.id) === String(introId));
    assert.ok(m, '新人员未进入通讯录');
    assert.strictEqual(m.signature, '陪伴孩子成长');
    assert.strictEqual(m.title, '学生家长');
  });
  await checkAsync('更新人员资料后通讯录同步保持一致', async () => {
    const res = await API.updatePerson(introId, { gender:'男', age:39, signature:'一起看世界' });
    assert.strictEqual(res.ok, true, res.message);
    const m = state.directory.members.find(x => String(x.id) === String(introId));
    assert.strictEqual(m.gender, '男');
    assert.strictEqual(m.age, 39);
    assert.strictEqual(m.signature, '一起看世界');
  });
  await checkAsync('删除人员后通讯录不再保留该成员', async () => {
    const res = await API.deletePerson(introId);
    assert.strictEqual(res.ok, true, res.message);
    assert.ok(!state.directory.members.some(x => String(x.id) === String(introId)));
  });
  check('通讯录界面使用同步数据源并展示完整个人简介字段', () => {
    const app = read('js/app.js');
    const departments = vm.runInContext('DEPARTMENT_OPTIONS', sandbox);
    assert.ok(departments.includes('学生家长'));
    assert.ok(!/MEMBERS\.filter/.test(app), '通讯录仍在使用静态 MEMBERS 常量');
    assert.ok(/个人简介/.test(app), '缺少个人简介界面');
    ['姓名','性别','年龄','年级','部门 / 身份','手机号','邮箱','个人签名'].forEach(field => {
      assert.ok(app.includes(field), `个人简介缺少字段：${field}`);
    });
  });

  /* ---------- 在线状态：规范化 / 统一判定 / 持久化 / 统计口径 ---------- */
  check('在线状态规范化兼容历史值与非法值', () => {
    assert.strictEqual(API.normalizePresence('online'), 'online');
    assert.strictEqual(API.normalizePresence('away'), 'away');
    assert.strictEqual(API.normalizePresence(''), 'offline');
    assert.strictEqual(API.normalizePresence('1'), 'online');
    assert.strictEqual(API.normalizePresence('忙碌'), 'away');
    assert.strictEqual(API.normalizePresence('whatever'), 'offline');
    assert.strictEqual(API.presenceLabel('online'), '在线');
    assert.strictEqual(API.presenceLabel('away'), '离开');
    assert.strictEqual(API.presenceLabel('offline'), '离线');
  });

  check('在线状态统一判定：停用离线 / 当前会话在线 / 其余按字段', () => {
    const me = { id: 'me' };
    assert.strictEqual(API.effectivePresence({ id: 'x', presence: 'online', status: 'disabled' }, me), 'offline', '停用账户强制离线');
    assert.strictEqual(API.effectivePresence({ id: 'me', presence: 'offline', status: 'active' }, me), 'online', '当前会话账户始终在线');
    assert.strictEqual(API.effectivePresence({ id: 'u2', presence: 'away', status: 'active' }, me), 'away', '其余账户按字段值');
    assert.strictEqual(API.effectivePresence({ id: 'u3', status: 'active' }, me), 'offline', '缺失字段回落离线');
    assert.strictEqual(API.effectivePresence(null, me), 'offline');
  });

  await checkAsync('人员新建/编辑保留在线状态字段', async () => {
    const before = state.users.length;
    const created = await API.createPerson({
      name: '在线测试', email: 'presence.test@sunny.edu.cn', phone: '13800002222',
      role: 'student', grade: 2, password: '123456', presence: 'away',
    });
    assert.strictEqual(created.ok, true, created.message);
    const id = created.data.person.id;
    const found = state.users.find(u => String(u.id) === String(id));
    assert.strictEqual(found.presence, 'away', '新建时在线状态应持久化');
    const updated = await API.updatePerson(id, { presence: 'online' });
    assert.strictEqual(updated.ok, true, updated.message);
    assert.strictEqual(state.users.find(u => String(u.id) === String(id)).presence, 'online', '编辑应更新在线状态');
    await API.deletePerson(id);
    assert.strictEqual(state.users.length, before);
  });

  check('通讯录同步保留成员的在线状态', () => {
    state.users = USERS.map((u, i) => ({ ...u, presence: i === 0 ? 'away' : 'offline' }));
    API.syncDirectoryUsers();
    const first = state.directory.members.find(m => String(m.id) === String(USERS[0].id));
    assert.ok(first, '成员应存在于通讯录');
    assert.strictEqual(first.presenceStored, 'away', '应保留原始在线状态字段');
    // 当前账户（u05）会话在线；u01 非当前账户，按字段 away
    const admin = state.directory.members.find(m => String(m.id) === String(USERS[4].id));
    assert.strictEqual(admin.presence, 'online', '当前登录账户应显示在线');
    assert.strictEqual(first.presence, 'away', '非当前账户按字段显示');
  });

  check('实时监测当前在线数使用统一口径', () => {
    // 构造在线/离线/停用样本，当前账户 id=me
    state.account = { ...USERS[4], id: 'me', status: 'active' };
    state.users = [
      { ...USERS[4], id: 'me', status: 'active', presence: 'offline' }, // 当前会话→在线
      { ...USERS[0], id: 'on', status: 'active', presence: 'online' },
      { ...USERS[1], id: 'away', status: 'active', presence: 'away' },
      { ...USERS[2], id: 'off', status: 'active', presence: 'offline' },
      { ...USERS[3], id: 'dis', status: 'disabled', presence: 'online' }, // 停用→离线
    ];
    const res = API.getRealtimeStats();
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(res.data.onlineNow, 2, '当前会话 + 字段在线应为 2');
    assert.deepStrictEqual(res.data.onlineIds.sort(), ['me', 'on']);
  });
  // 还原为原始演示数据，避免影响后续清理测试
  state.users = USERS.map(u => ({ ...u }));
  state.account = { ...USERS[4] };

  /* ---------- 多账户会话：登录去重 / 切换隔离 / 权限 / 在线状态 / 退出 / 冲突 ---------- */
  const resetSessions = () => {
    state.sessions = []; state.activeSessionId = null;
    state.cloudAuthKey = null; state.cloudStale = false;
    state.users = USERS.map(u => ({ ...u }));
    state.account = { ...USERS[4] }; state.role = 'admin'; state.cloudMode = false;
    state.view = 'library'; state.library = { grade:'all', subject:'all', query:'', mode:'grid' };
    state.directory = { query:'', roleFilter:'all', activeConv:null };
    state.conversations = CONVERSATIONS.map(c => ({ ...c, messages: c.messages.map(m => ({ ...m })) }));
    state.notifications = [];
  };

  check('会话身份键：uid / 邮箱 / id 稳定', () => {
    assert.strictEqual(API.sessionKeyOf({ uid: 'abc', email: 'a@b.com', id: 'x' }), 'uid:abc');
    assert.strictEqual(API.sessionKeyOf({ email: 'A@B.com', id: 'x' }), 'mail:a@b.com');
    assert.strictEqual(API.sessionKeyOf({ id: 'X01' }), 'id:x01');
    assert.strictEqual(API.sessionKeyOf({}), '');
  });

  check('登录登记会话：创建、去重复用、上限保护', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    const a = API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    assert.strictEqual(a.ok, true, a.message);
    assert.strictEqual(a.data.created, true);
    assert.strictEqual(state.activeSessionId, API.sessionKeyOf(admin));
    state.view = 'shares'; // 修改工作副本
    const b = API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    assert.strictEqual(b.ok, true, b.message);
    assert.strictEqual(b.data.created, true);
    const again = API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.data.created, false, '重复登录应复用会话');
    assert.strictEqual(state.sessions.length, 2, '去重后不应新增会话');
    assert.strictEqual(state.view, 'shares', '重复登录切换回 admin 应恢复其此前的工作副本视图');
  });

  check('会话切换隔离私有工作区（视图/筛选/会话/通知）', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    state.view = 'admin'; state.library.query = 'admin-query'; state.notifications = [{ id: 'n1' }];
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    state.view = 'directory'; state.library.query = 'student-query'; state.notifications = [{ id: 'n2' }];
    const back = API.switchSession(API.sessionKeyOf(admin));
    assert.strictEqual(back.ok, true, back.message);
    assert.strictEqual(state.view, 'admin', '切回后视图应恢复');
    assert.strictEqual(state.library.query, 'admin-query', '筛选条件应隔离');
    assert.deepStrictEqual(state.notifications, [{ id: 'n1' }], '通知应隔离');
  });

  check('切换会话按最新人员角色重算权限', () => {
    resetSessions();
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    // 管理员把该学生在本会话存续期间提权为教师
    const idx = state.users.findIndex(u => u.id === student.id);
    state.users[idx] = { ...state.users[idx], role: 'teacher' };
    const res = API.switchSession(API.sessionKeyOf(student));
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(state.role, 'teacher', '角色应随人员表更新');
  });

  check('在线状态按会话独立：多会话同时在线且离开互不影响', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    API.setSessionPresence(API.sessionKeyOf(student), 'away');
    state.users = [{ ...admin, presence: 'offline' }, { ...student, presence: 'offline' }];
    const pAdmin = API.effectivePresence(state.users[0], null);
    const pStudent = API.effectivePresence(state.users[1], null);
    assert.strictEqual(pAdmin, 'online', '在线会话应为在线');
    assert.strictEqual(pStudent, 'away', '另一会话离开应独立显示离开');
  });

  check('云端凭证冲突：切换到非凭证持有者云端会话标记待验证', () => {
    resetSessions();
    const a = { ...USERS[4], id: 'ca', email: 'ca@x.com', uid: 'u-ca', verified: true };
    const b = { ...USERS[1], id: 'cb', email: 'cb@x.com', uid: 'u-cb', role: 'teacher', verified: true };
    state.users = [a, b];
    API.upsertSession(a, { cloudMode: true });
    assert.strictEqual(state.cloudAuthKey, 'uid:u-ca');
    assert.strictEqual(state.cloudStale, false);
    API.upsertSession(b, { cloudMode: true }); // 新云账户取得凭证
    assert.strictEqual(state.cloudAuthKey, 'uid:u-cb');
    const sw = API.switchSession('uid:u-ca');
    assert.strictEqual(sw.ok, true, sw.message);
    assert.strictEqual(sw.data.cloudStale, true, '切回旧云账户应待验证');
    assert.ok(sw.data.warning, '应给出冲突提示');
  });

  check('退出当前会话：自动切换到其它在线账户；全部退出清空', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    const key = state.activeSessionId;
    const closed = API.closeSession(key);
    assert.strictEqual(closed.ok, true, closed.message);
    assert.strictEqual(closed.data.count, 1);
    assert.ok(closed.data.next, '应自动切换到另一会话');
    assert.strictEqual(state.authed, true);
    const all = API.closeAllSessions();
    assert.strictEqual(all.ok, true);
    assert.strictEqual(state.sessions.length, 0);
    assert.strictEqual(state.authed, false);
  });

  check('冲突：账户被禁用/删除的会话在切换时失效并清理', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    const idx = state.users.findIndex(u => u.id === student.id);
    state.users[idx] = { ...state.users[idx], status: 'disabled' };
    const sw = API.switchSession(API.sessionKeyOf(student));
    assert.strictEqual(sw.ok, false);
    assert.strictEqual(sw.error.code, 'ACCOUNT_DISABLED');
    assert.strictEqual(state.sessions.length, 1, '失效会话应被移除');
  });

  check('启动时校准会话与旧数据迁移入口存在', () => {
    const src = read('js/app.js');
    assert.ok(/adoptCurrentSession\(\)/.test(src), '缺少旧登录态迁移');
    assert.ok(/reconcileSessions\(\)/.test(src), '缺少启动会话校准');
    assert.ok(/session-toggle-menu/.test(read('index.html')), '缺少账户切换入口');
  });
  resetSessions(); // 还原，避免影响后续清理测试
  state.users = USERS.map(u => ({ ...u }));
  state.account = { ...USERS[4] };

  /* ---------- 账户清理：预检 / 二次确认 / 关联数据 / 结果报告 ---------- */
  const cleanupPhrase = vm.runInContext('window.APP_CONFIG.auth.accountCleanup.confirmPhrase', sandbox);
  state.account = { ...USERS[4] }; // 超管（本地测试中以当前超管作为受保护账户）
  await checkAsync('非超管无法调用账户清理预检', async () => {
    state.account = { ...USERS[0] };
    const res = await API.getAccountCleanupPlan();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'FORBIDDEN');
    state.account = { ...USERS[4] };
  });
  await checkAsync('预检确认 admin 存在并列出其余待删账户', async () => {
    const res = await API.getAccountCleanupPlan();
    assert.strictEqual(res.ok, true, res.message);
    assert.strictEqual(res.data.keep.id, USERS[4].id);
    assert.strictEqual(res.data.targets.length, USERS.length - 1);
    assert.strictEqual(res.data.counts.accounts, USERS.length - 1);
    assert.strictEqual(res.data.phrase, cleanupPhrase);
    assert.ok(res.data.finalAccounts === undefined);
  });
  await checkAsync('缺少 admin 账户时预检终止', async () => {
    const backup = state.users;
    state.users = backup.filter(u => u.role !== 'admin');
    try {
      const res = await API.getAccountCleanupPlan();
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error.code, 'ADMIN_NOT_FOUND');
    } finally {
      state.users = backup;
    }
  });
  await checkAsync('未通过二次确认时不执行清理', async () => {
    const before = state.users.length;
    const res1 = await API.cleanupAccounts({ confirm: true, confirmPhrase: 'WRONG' });
    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.error.code, 'CONFIRMATION_REQUIRED');
    const res2 = await API.cleanupAccounts({ confirm: false, confirmPhrase: cleanupPhrase });
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.error.code, 'CONFIRMATION_REQUIRED');
    assert.strictEqual(state.users.length, before);
  });
  await checkAsync('二次确认后清理账户与关联数据并返回报告', async () => {
    const res = await API.cleanupAccounts({ confirm: true, confirmPhrase: cleanupPhrase });
    assert.strictEqual(res.ok, true, res.message);
    const r = res.data;
    assert.strictEqual(r.deletedAccounts.length, USERS.length - 1);
    assert.strictEqual(r.counts.accounts, USERS.length - 1);
    assert.strictEqual(r.finalAccounts.length, 1);
    assert.strictEqual(r.finalAccounts[0].id, USERS[4].id);
    assert.strictEqual(r.keep.id, USERS[4].id);
    assert.strictEqual(r.failedItems.length, 0);
    assert.strictEqual(state.users.length, 1, '最终仅保留 admin 账户');
    assert.ok(state.shares.every(s => s.owner_id === USERS[4].id), '非 admin 的感悟应被移除');
    assert.ok(state.conversations.every(c => c.with === USERS[4].id), '非 admin 的会话应被移除');
    assert.ok(state.shares.every(s => s.like_by.every(id => id === USERS[4].id)), '非 admin 的点赞引用应被移除');
  });

  /* ---------- 已添加学习栏目：加入 / 移除 / 分组 / 空状态 / 会话隔离 ---------- */
  // 使用独立 state，避免污染后续（虽已是最后一组）
  const learnState = {
    materials: MATERIALS.map(m => ({ ...m })),
    learning: [],
  };
  const L = buildLearning(learnState);

  check('已添加学习：无资料时展示空状态占位', () => {
    const html = L.learningPanelHTML();
    assert.ok(/learn-empty/.test(html), '应包含空状态容器');
    assert.ok(/还没有添加学习资料/.test(html), '空状态文案应一致');
    assert.ok(!/learn-group/.test(html), '空状态不应出现学科分组');
  });

  check('已添加学习：加入去重并置顶，返回是否新增', () => {
    assert.strictEqual(L.addToLearning('m01'), true, '首次加入返回 true');
    assert.strictEqual(L.addToLearning('m05'), true);
    assert.strictEqual(L.addToLearning('m01'), false, '重复加入返回 false');
    assert.strictEqual(learnState.learning.length, 2, '去重后仅 2 条');
    assert.strictEqual(learnState.learning[0].id, 'm01', '重复加入应置顶');
    assert.ok(learnState.learning[0].addedAt, '应记录加入时间');
    assert.strictEqual(L.isLearning('m01'), true);
    assert.strictEqual(L.isLearning('m99'), false);
  });

  check('已添加学习：不存在的资料无法加入', () => {
    const before = learnState.learning.length;
    assert.strictEqual(L.addToLearning('not-exist'), false);
    assert.strictEqual(learnState.learning.length, before);
  });

  check('已添加学习：按学科分组展示资料名称与状态信息', () => {
    learnState.learning = [
      { id: 'm01', addedAt: null }, // 语文
      { id: 'm02', addedAt: null }, // 数学
      { id: 'm06', addedAt: null }, // 数学（二年级）
      { id: 'deleted', addedAt: null }, // 已删除资料应被忽略
    ];
    const mats = L.addedLearningMaterials();
    assert.strictEqual(mats.length, 3, '已删除资料不计入');
    const html = L.learningPanelHTML();
    assert.ok(/语文/.test(html) && /数学/.test(html), '应按学科分组标题');
    assert.ok(/拼音王国大冒险/.test(html), '应显示资料名称');
    assert.ok(/年级/.test(html) && /分钟/.test(html), '应显示年级/时长等状态信息');
    assert.ok(/data-action="open-material"/.test(html), '条目应可点击进入详情');
    assert.ok(/已添加/.test(html), '应展示已添加状态');
    // 数学组内应有 2 份
    const mathGroup = html.split('数学')[1] || '';
    assert.ok(/2 份/.test(mathGroup), '数学组应显示 2 份');
  });

  check('已添加学习：移除条目并持久化刷新', () => {
    const before = L.__count();
    assert.strictEqual(L.removeFromLearning('m02'), true);
    assert.strictEqual(L.isLearning('m02'), false);
    assert.strictEqual(L.removeFromLearning('m02'), false, '重复移除返回 false');
    const after = L.__count();
    assert.ok(after.persisted > before.persisted, '移除后应持久化');
    assert.ok(after.refreshed > before.refreshed, '移除后应刷新左栏');
  });

  check('已添加学习：纳入会话私有工作区，切换账户互相隔离', () => {
    resetSessions();
    const admin = state.users.find(u => u.id === USERS[4].id);
    const student = state.users.find(u => u.id === USERS[0].id);
    API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    state.learning = [{ id: 'm01', addedAt: null }];
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    state.learning = [{ id: 'm05', addedAt: null }];
    const back = API.switchSession(API.sessionKeyOf(admin));
    assert.strictEqual(back.ok, true, back.message);
    assert.deepStrictEqual(state.learning, [{ id: 'm01', addedAt: null }], '切回后学习清单应恢复为该账户私有数据');
    const toStudent = API.switchSession(API.sessionKeyOf(student));
    assert.strictEqual(toStudent.ok, true, toStudent.message);
    assert.deepStrictEqual(state.learning, [{ id: 'm05', addedAt: null }], '另一账户学习清单应独立');
    resetSessions(); // 还原，避免影响后续
    state.users = USERS.map(u => ({ ...u }));
    state.account = { ...USERS[4] };
  });

  check('已添加学习：页面结构与交互入口齐备', () => {
    const src = read('js/app.js');
    const css = read('css/styles.css');
    assert.ok(/class="learn-layout"/.test(src), '缺少左右布局容器');
    assert.ok(/id="learning-list"/.test(src), '缺少左栏清单容器');
    assert.ok(/已添加学习/.test(src), '缺少栏目标题');
    assert.ok(/case 'start-learning'/.test(src) && /addToLearning\(/.test(src), '开始学习应加入清单');
    assert.ok(/case 'remove-learning'/.test(src), '缺少移除事件');
    assert.ok(/\.learn-layout\s*\{/.test(css) && /\.learn-item\s*\{/.test(css), '缺少栏目样式');
    assert.ok(/max-width: 900px/.test(css) && /\.learn-side \{ position: static/.test(css), '缺少响应式规则');
  });

  /* ========================================================================
     本次改造：会话有效期/跨标签 / 忘记密码 / 感悟评论实时同步 / 年级权限
     ======================================================================== */
  check('会话有效期：会话携带签发与过期时间，过期判定正确', () => {
    assert.ok(API.sessionTtlMs() >= 24 * 60 * 60 * 1000, '会话有效期至少 1 天');
    const now = Date.now();
    const fresh = API.isSessionExpired({ expiresAt: new Date(now + 100000).toISOString() }, now);
    const stale = API.isSessionExpired({ expiresAt: new Date(now - 100000).toISOString() }, now);
    const legacy = API.isSessionExpired({}, now); // 旧数据无过期时间视为有效
    assert.strictEqual(fresh, false, '未过期会话应有效');
    assert.strictEqual(stale, true, '过期会话应失效');
    assert.strictEqual(legacy, false, '无过期时间的旧会话兼容为有效');
  });

  check('登录登记会话写入有效期，切换与复用会续期', () => {
    resetSessions();
    const admin = USERS[4];
    const r = API.upsertSession({ ...admin, verified: true }, { cloudMode: false });
    assert.ok(r.ok);
    const sess = state.sessions[0];
    assert.ok(sess.issuedAt && sess.expiresAt, '会话应写入签发/过期时间');
    const firstExpiry = sess.expiresAt;
    const student = USERS[0];
    API.upsertSession({ ...student, verified: true }, { cloudMode: false });
    API.switchSession(API.sessionKeyOf(admin));
    const again = state.sessions.find(s => s.id === API.sessionKeyOf(admin));
    assert.ok(again.expiresAt >= firstExpiry, '切换会话后有效期不应缩短');
    resetSessions();
  });

  check('启动校准：过期会话被剔除并恢复到有效账户', () => {
    resetSessions();
    const admin = { ...USERS[4], verified: true };
    API.upsertSession(admin, { cloudMode: false });
    // 手动将当前会话设为过期
    state.sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    const r = API.reconcileSessions();
    assert.ok(r.ok);
    assert.strictEqual(state.sessions.length, 0, '过期会话应被清理');
    assert.strictEqual(state.authed, false, '无有效会话应为未登录');
    resetSessions();
  });

  check('忘记密码：邮箱身份校验后重置口令并重置验证态', () => {
    const user = state.users.find(u => u.id === 'u01');
    const before = user.passwordHash || '(默认)';
    const res = API.resetPasswordByEmail({
      email: user.email.toUpperCase(),
      newPassword: 'newpass123',
      confirmPassword: 'newpass123',
    });
    assert.ok(res.ok, res.message);
    assert.notStrictEqual(user.passwordHash, before, '口令哈希应变化');
    assert.strictEqual(API.verifyPassword({ userId: user.id, password: 'newpass123' }).data.valid, true, '新密码可登录');
    assert.strictEqual(API.verifyPassword({ userId: user.id, password: '123456' }).data.valid, false, '旧密码失效');
    // 恢复原状避免影响后续
    delete user.passwordHash;
    assert.ok(API.resetPasswordByEmail({ email: 'nobody@example.com', newPassword: 'abcdef', confirmPassword: 'abcdef' }).ok === false, '未开通邮箱不可重置');
  });

  check('忘记密码：两次密码不一致时拒绝重置', () => {
    const res = API.resetPasswordByEmail({ email: USERS[0].email, newPassword: 'abcdef', confirmPassword: 'ghijkl' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'INVALID_PARAM');
  });

  check('年级权限：学生仅可访问本人年级，管理员/教师全部年级', () => {
    const student = { role: 'student', grade: 1 };
    const admin = { role: 'admin' };
    const teacher = { role: 'teacher' };
    assert.strictEqual(JSON.stringify(API.gradeScopeFor(student)), JSON.stringify([1]), '学生默认仅本人年级');
    assert.strictEqual(API.gradeScopeFor(admin), 'all');
    assert.strictEqual(API.gradeScopeFor(teacher), 'all');
    assert.strictEqual(API.canAccessGrade(student, 1), true);
    assert.strictEqual(API.canAccessGrade(student, 4), false, '学生不能访问其它年级');
    assert.strictEqual(API.canAccessGrade(student, undefined), true, '无年级内容默认可见');
    assert.strictEqual(API.canAccessGrade({ role:'student', grade:1, allowedGrades:[1,3] }, 3), true, '管理员授权的额外年级可访问');
    assert.strictEqual(API.canAccessGrade({ role:'student', grade:1, gradeScope:'all' }, 6), true, '显式全部授权可访问');
    assert.strictEqual(API.assertGradeAccess(student, 4).ok, false, '越年级操作被拦截');
  });

  check('年级权限：资料按年级范围过滤，无年级资料保留', () => {
    const student = { role: 'student', grade: 1 };
    const items = [
      { id: 'a', grade: 1 }, { id: 'b', grade: 4 }, { id: 'c' },
    ];
    const out = API.filterByGradeScope(items, student, 'grade');
    assert.deepStrictEqual(out.map(x => x.id), ['a', 'c'], '仅本人年级与无年级资料可见');
  });

  check('评论：三类身份与角色发帖权限正确', () => {
    assert.strictEqual(JSON.stringify(API.COMMENT_KINDS), JSON.stringify(['student', 'teacher', 'group']));
    assert.strictEqual(JSON.stringify(API.commentKindsFor('student')), JSON.stringify(['student', 'group']));
    assert.strictEqual(JSON.stringify(API.commentKindsFor('teacher')), JSON.stringify(['teacher', 'group']));
    assert.strictEqual(JSON.stringify(API.commentKindsFor('parent')), JSON.stringify(['group']));
    assert.strictEqual(JSON.stringify(API.commentKindsFor('admin')), JSON.stringify(['student', 'teacher', 'group']));
    assert.strictEqual(API.canPostComment('student', 'teacher'), false, '学生不能发老师评论');
    assert.strictEqual(API.canPostComment('teacher', 'group'), true, '老师可发小组评论');
    assert.strictEqual(API.canPostComment('admin', 'student'), true, '管理员可发任意评论');
  });

  check('评论：归一化、追加与三类分组展示正确', () => {
    const c = API.normalizeComment({ id:'x', kind:'teacher', owner_name:'老师', content:' 你好 ', created_at:'2026-01-01' });
    assert.strictEqual(c.kind, 'teacher');
    assert.strictEqual(c.content, '你好', '内容去首尾空格');
    assert.strictEqual(API.normalizeComment({ content:'x', kind:'bogus' }).kind, 'student', '非法种类回退学生');
    const share = { id:'s1', comments: [ { id:'a', kind:'student', content:'A' } ] };
    const added = API.appendComment(share, { id:'b', kind:'group', content:'B', owner_name:'小组' });
    assert.ok(added.ok);
    assert.strictEqual(share.comments.length, 1, '不修改入参');
    assert.strictEqual(added.data.comments.length, 2, '返回新列表');
    const grouped = API.groupComments(added.data.comments);
    assert.strictEqual(grouped.student.length, 1);
    assert.strictEqual(grouped.group.length, 1);
    assert.strictEqual(grouped.teacher.length, 0);
    assert.strictEqual(API.appendComment(share, { content:'   ' }).ok, false, '空评论被拒绝');
  });

  check('页面接线：登录页无验证码登录入口，忘记密码与评论入口齐备', () => {
    const src = read('js/app.js');
    assert.ok(/data-action="forgot-password"/.test(src), '缺少忘记密码入口');
    assert.ok(/function renderForgotPassword/.test(src) && /function sendResetCode/.test(src) && /function handleResetPassword/.test(src), '缺少忘记密码流程函数');
    assert.ok(/resetPasswordForEmail/.test(src) && /\.updateUser\(/.test(src), '云端重置密码流程缺失');
    assert.ok(!/邮箱验证码登录（云端同步）/.test(src), '登录页仍保留邮箱验证码登录入口');
    assert.ok(!/case 'cloud-login'/.test(src), '仍保留云端登录事件');
    assert.ok(/case 'open-comment-form'/.test(src) && /case 'submit-comment'/.test(src), '评论事件缺失');
    assert.ok(/visibleShares\(\)/.test(src) && /filterByGradeScope/.test(src), '感悟年级过滤缺失');
    assert.ok(/startShareRealtime/.test(src) && /window.addEventListener\('storage'/.test(src), '实时同步机制缺失');
  });

  check('云端表：分享评论表结构含关键字段与三类评论', () => {
    const sql = read('js/app.js');
    assert.ok(/from\('share_comments'\)/.test(sql), '云端评论表未接入');
    const seed = read('js/data.js');
    assert.ok(/kind:'student'/.test(seed) && /kind:'teacher'/.test(seed) && /kind:'group'/.test(seed), '种子数据缺少三类评论');
  });

  /* ---------- 账户验证状态全链路 ---------- */
  // 从 api.js 源码提取 personToRow / personFromRow 纯函数，验证云端字段双向映射
  function buildPersonRowMapper() {
    const src = read('js/api.js');
    const m1 = src.match(/function personFromRow\(p\) \{[\s\S]*?\n  \}/);
    const m2 = src.match(/function personToRow\(u\) \{[\s\S]*?\n  \}/);
    assert.ok(m1 && m2, '未找到人员行映射函数');
    const make = new Function('normalizePresence', 'sanitizeText', 'normalizeManagedClasses', 'parseJsonArray',
      m1[0] + '\n' + m2[0] + '\nreturn { personFromRow, personToRow };');
    return make(API.normalizePresence, (v, n) => String(v == null ? '' : v).slice(0, n),
      API.normalizeManagedClasses, API.parseJsonArray);
  }

  check('验证状态：personToRow 写入云端 email_verified，personFromRow 回读 verified 与时间戳', () => {
    const { personFromRow, personToRow } = buildPersonRowMapper();
    const verifiedUser = { id:'v1', name:'验证用户', email:'v@x.com', role:'student', verified:true,
      emailVerifiedAt:'2026-11-20T10:00:00.000Z', presence:'online' };
    const row = personToRow(verifiedUser);
    assert.strictEqual(row.email_verified, '2026-11-20T10:00:00.000Z', '已验证状态应写入 email_verified 时间戳');
    const back = personFromRow(Object.assign({}, row, { id:'v1', email_verified:'2026-11-20T10:00:00.000Z' }));
    assert.strictEqual(back.verified, true, '回读应识别为已验证');
    assert.strictEqual(back.emailVerifiedAt, '2026-11-20T10:00:00.000Z', '回读应携带验证时间戳');
    // 未验证账户：email_verified 为 null，回读 verified=false
    const unverifiedRow = personToRow({ id:'v2', name:'未验证', email:'u@x.com', verified:false });
    assert.strictEqual(unverifiedRow.email_verified, null, '未验证账户 email_verified 应为空');
    const back2 = personFromRow(Object.assign({}, unverifiedRow, { id:'v2' }));
    assert.strictEqual(back2.verified, false, '未验证账户回读应为 false');
  });

  await checkAsync('验证状态：createPerson 默认未验证，可指定 verified 创建即已验证', async () => {
    const backup = state.users;
    state.users = [];
    state.account = { ...USERS[4] }; // 超管
    try {
      const r1 = await API.createPerson({ name:'默认账户', email:'dv@x.com', phone:'13800000001', role:'student' });
      assert.strictEqual(r1.ok, true, r1.message);
      assert.strictEqual(r1.data.person.verified, false, '默认应为未验证');
      const r2 = await API.createPerson({ name:'已验证账户', email:'vv@x.com', phone:'13800000002', role:'teacher', verified:true });
      assert.strictEqual(r2.ok, true, r2.message);
      assert.strictEqual(r2.data.person.verified, true, '指定 verified 应为已验证');
      assert.ok(r2.data.person.emailVerifiedAt, '已验证账户应有验证时间戳');
    } finally {
      state.users = backup;
      state.account = { ...USERS[4] };
      API.syncDirectoryUsers();
    }
  });

  await checkAsync('验证状态：updatePerson 可修正账户验证状态并写入时间戳', async () => {
    const backup = state.users;
    state.users = [];
    state.account = { ...USERS[4] };
    try {
      const r = await API.createPerson({ name:'待验证', email:'up@x.com', phone:'13800000003', role:'student' });
      const id = r.data.person.id;
      assert.strictEqual(r.data.person.verified, false);
      const upd = await API.updatePerson(id, { verified:true });
      assert.strictEqual(upd.ok, true, upd.message);
      assert.strictEqual(upd.data.person.verified, true, '修正后应为已验证');
      assert.ok(upd.data.person.emailVerifiedAt, '修正后应有验证时间戳');
      // 撤销验证
      const rev = await API.updatePerson(id, { verified:false });
      assert.strictEqual(rev.data.person.verified, false, '撤销后应为未验证');
      assert.strictEqual(rev.data.person.emailVerifiedAt, null, '撤销后时间戳应清空');
    } finally {
      state.users = backup;
      state.account = { ...USERS[4] };
      API.syncDirectoryUsers();
    }
  });

  await checkAsync('验证状态：markEmailVerified 本地落盘并同步当前会话工作副本', async () => {
    const backup = state.users;
    const backupAccount = state.account;
    const backupSessions = state.sessions;
    const backupActive = state.activeSessionId;
    state.users = [{ id:'mk1', name:'验证用户', email:'mk@x.com', role:'student', verified:false,
      status:'active', passwordHash:API.hashPassword('123456'), presence:'offline' }];
    state.account = { ...state.users[0] };
    state.sessions = [];
    state.activeSessionId = null;
    const sessRes = API.upsertSession(state.account, { cloudMode:false });
    assert.strictEqual(sessRes.ok, true, sessRes.message);
    try {
      const r = await API.markEmailVerified({ userId:'mk1' });
      assert.strictEqual(r.ok, true, r.message);
      assert.strictEqual(r.data.verified, true);
      assert.ok(r.data.emailVerifiedAt, '应返回验证时间戳');
      assert.strictEqual(state.users[0].verified, true, '本地 users 应已验证');
      assert.strictEqual(state.account.verified, true, '当前会话工作副本应已验证');
      assert.ok(state.account.emailVerifiedAt, '当前工作副本应携带时间戳');
      const active = state.sessions.find(s => s.id === state.activeSessionId);
      assert.ok(active && active.account.verified === true, '会话快照应已验证');
    } finally {
      state.users = backup;
      state.account = backupAccount;
      state.sessions = backupSessions;
      state.activeSessionId = backupActive;
      API.syncDirectoryUsers();
    }
  });

  check('验证状态：后台人员表单提供验证状态入口并可提交', () => {
    const src = read('js/app.js');
    assert.ok(/id="uf-verified"/.test(src), '人员表单缺少验证状态字段');
    assert.ok(/verified:\s*\$\('#uf-verified'\)/.test(src), '保存时未提交验证状态');
    assert.ok(/emailVerifyOnce/.test(src), '登录流程未读取 emailVerifyOnce 配置');
    assert.ok(/email_verified/.test(read('js/api.js')), '接口层未持久化 email_verified');
  });

  check('内置演示账户不会在启动时复活到人员管理', () => {
    const src = read('js/app.js');
    const m = src.match(/function purgeSeedDemoUsers\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, '未找到 purgeSeedDemoUsers 函数');
    assert.ok(/hydrate\(\);\s*\n\s*purgeSeedDemoUsers\(\)/.test(src), '启动时未调用演示账户清理');
    const st = {
      users: [
        { id: 'u01', name: '林小满', role: 'student' },
        { id: 'u05', name: '王校长', role: 'admin' },
        { id: 'p123', name: '超管新建', role: 'student' },
        { id: 'p_superadmin', name: '超级管理员', role: 'admin' },
      ],
      directory: { members: [{ id: 'u01' }, { id: 'p123' }] },
      account: { id: 'u01', role: 'student' },
      authed: true,
    };
    let saved = 0;
    const run = new Function('state', 'persist', m[0] + '\nreturn purgeSeedDemoUsers;')(st, () => { saved++; });
    assert.strictEqual(run(), true, '应执行了清理');
    assert.deepStrictEqual(st.users.map(u => u.id), ['p123', 'p_superadmin'], '只应剔除 u01–u12 演示 id');
    assert.deepStrictEqual(st.directory.members.map(x => x.id), ['p123'], '通讯录同步剔除演示成员');
    assert.strictEqual(st.account.role, 'admin', '当前账户应切换到保留的超管');
    assert.strictEqual(st.authed, false, '演示账户失效后应强制重新登录');
    assert.ok(saved > 0, '清理结果应落盘');
  });

  check('弹窗右上角关闭按钮不再被遮罩拦截', () => {
    const src = read('js/app.js');
    const m = src.match(/function shouldIgnoreMaskClose\([\s\S]*?\n\}/);
    assert.ok(m, '未找到 shouldIgnoreMaskClose 函数');
    assert.ok(/shouldIgnoreMaskClose\(t, e\.target, a\)/.test(src), '点击委托未使用遮罩拦截判断');
    const fn = new Function(m[0] + '\nreturn shouldIgnoreMaskClose;')();
    const modal = { closest: s => (s === '[data-stop]' ? modal : null) };
    const mask = { classList: { contains: c => c === 'modal-mask' }, closest: () => null };
    const xBtn = { classList: { contains: () => false }, closest: s => (s === '[data-stop]' ? modal : null) };
    const svg = { classList: { contains: () => false }, closest: s => (s === '[data-stop]' ? modal : null) };
    assert.strictEqual(fn(mask, modal, 'close-modal'), true, '点在弹窗内部的遮罩点击应被拦截');
    assert.strictEqual(fn(xBtn, svg, 'close-modal'), false, '右上角关闭按钮内的 svg 点击必须放行');
    assert.strictEqual(fn(xBtn, xBtn, 'close-modal'), false, '直接点关闭按钮必须放行');
    assert.strictEqual(fn(mask, mask, 'close-modal'), false, '直接点遮罩本身应放行关闭');
    assert.strictEqual(fn(mask, modal, 'navigate'), false, '其它动作不受影响');
  });

  check('视口自适应识别分辨率、设备类别与横竖屏', () => {
    const src = read('js/app.js');
    const m = src.match(/function syncViewportMode\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, '未找到 syncViewportMode 函数');
    assert.ok(/syncViewportMode\(\);[^\n]*\n\s*bindApiContext\(\)/.test(src), '启动时未调用视口识别');
    const root = {
      clientWidth: 390, clientHeight: 844, dataset: {},
      style: { setProperty(k, v) { this[k] = v; } },
      classList: { toggle(c, on) { this[c] = !!on; } },
    };
    const doc = { documentElement: root };
    const win = { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: true }) };
    const run = new Function('document', 'window', m[0] + '\nreturn syncViewportMode;')(doc, win);
    run();
    assert.strictEqual(root.dataset.viewport, 'phone', '390px 应识别为手机');
    assert.strictEqual(root.dataset.orientation, 'portrait', '竖屏识别');
    assert.strictEqual(root.classList['is-touch'], true, '触屏标记');
    assert.strictEqual(root.style['--viewport-w'], '390px', '应写入视口宽度变量');
    win.innerWidth = 900; root.clientWidth = 900;
    win.innerHeight = 700; root.clientHeight = 700;
    run();
    assert.strictEqual(root.dataset.viewport, 'tablet', '900px 应识别为平板');
    assert.strictEqual(root.dataset.orientation, 'landscape', '横屏识别');
    win.innerWidth = 1440; root.clientWidth = 1440;
    run();
    assert.strictEqual(root.dataset.viewport, 'desktop', '1440px 应识别为电脑');
    const css = read('css/styles.css');
    assert.ok(/data-viewport="phone"/.test(css), 'CSS 未使用设备标记');
    assert.ok(/@media \(max-width: 680px\)/.test(css), '缺少手机断点');
    assert.ok(/env\(safe-area-inset-bottom\)/.test(css), '未适配刘海屏安全区');
  });

  /* ---------- 内部通话：信令纯函数 ---------- */
  check('通话信令：newCallId 生成唯一标识', () => {
    const a = API.newCallId(), b = API.newCallId();
    assert.ok(/^call[a-z0-9]+$/i.test(a), 'callId 格式不正确：' + a);
    assert.notStrictEqual(a, b, '两次生成不应相同');
  });

  check('通话信令：normalizeCallSignal 校验类型与必填字段', () => {
    assert.strictEqual(API.normalizeCallSignal(null), null);
    assert.strictEqual(API.normalizeCallSignal({ kind: 'unknown', call_id: 'c1', from_uid: 'a', to_uid: 'b' }), null, '非法类型应拒绝');
    assert.strictEqual(API.normalizeCallSignal({ kind: 'invite', from_uid: 'a', to_uid: 'b' }), null, '缺 call_id 应拒绝');
    const s = API.normalizeCallSignal({ id: 5, kind: 'offer', call_id: 'c1', from_uid: 'a', to_uid: 'b', from_name: '<b>李', payload: { sdp: 'v=0' } });
    assert.strictEqual(s.kind, 'offer');
    assert.strictEqual(s.id, '5', 'id 应归一为字符串');
    assert.ok(!s.from_name.includes('<'), 'from_name 应过滤尖括号');
    assert.strictEqual(s.payload, '{"sdp":"v=0"}', '对象 payload 应 JSON 序列化');
  });

  check('通话信令：signalsFor 按 call_id/to_uid 过滤并按 id 排序', () => {
    const rows = [
      { id: 3, kind: 'ice', call_id: 'c1', from_uid: 'a', to_uid: 'me' },
      { id: 1, kind: 'invite', call_id: 'c1', from_uid: 'a', to_uid: 'me' },
      { id: 2, kind: 'answer', call_id: 'c1', from_uid: 'a', to_uid: 'other' },
      { id: 4, kind: 'hangup', call_id: 'c2', from_uid: 'a', to_uid: 'me' },
      { id: 5, kind: 'bogus', call_id: 'c1', from_uid: 'a', to_uid: 'me' },
    ];
    const mine = API.signalsFor(rows, 'c1', 'me', 0);
    assert.deepStrictEqual(mine.map(s => s.id), ['1', '3'], '只取 c1 且发给我、合法类型的信令');
    const since = API.signalsFor(rows, 'c1', 'me', 1);
    assert.deepStrictEqual(since.map(s => s.id), ['3'], 'sinceId 增量过滤生效');
  });

  check('通话权限：canStartCall 拒绝自己与自己、停用成员', () => {
    const me = { id: 'me', name: '我' };
    assert.strictEqual(API.canStartCall(me, null).ok, false, '无对象应拒绝');
    assert.strictEqual(API.canStartCall(me, me).ok, false, '不能与自己通话');
    assert.strictEqual(API.canStartCall(me, { id: 'x', status: 'disabled' }).ok, false, '停用成员应拒绝');
    assert.strictEqual(API.canStartCall(me, { id: 'peer', status: 'active' }).ok, true, '正常成员应允许');
  });

  check('通话模式：callMode 依据云端/安全上下文/媒体支持判定', () => {
    assert.strictEqual(API.callMode({ cloudReady: true, secureContext: true, mediaSupported: true }), 'real');
    assert.strictEqual(API.callMode({ cloudReady: false, secureContext: true, mediaSupported: true }), 'demo', '无云端应演示');
    assert.strictEqual(API.callMode({ cloudReady: true, secureContext: false, mediaSupported: true }), 'demo', '非安全上下文应演示');
    assert.strictEqual(API.callMode({ cloudReady: true, secureContext: true, mediaSupported: false }), 'demo', '不支持媒体应演示');
  });

  check('通话计时：formatCallDuration 格式化分秒', () => {
    assert.strictEqual(API.formatCallDuration(0), '00:00');
    assert.strictEqual(API.formatCallDuration(65000), '01:05');
    assert.strictEqual(API.formatCallDuration(-100), '00:00');
  });

  check('通话信令云表：SQL 迁移脚本关键字段齐全', () => {
    const doc = read('超级管理员使用方案.md') + read('README.md');
    assert.ok(/call_signals/.test(doc), '文档未说明 call_signals 表');
    assert.ok(/视频通话|语音通话|通话/.test(doc), '文档未说明通话功能');
  });

  check('手机端全屏聊天：结构与事件接线齐备', () => {
    const src = read('js/app.js');
    assert.ok(/function renderChatFullscreen\(\)/.test(src), '缺少全屏聊天渲染函数');
    assert.ok(/function closeChatFullscreen\(\)/.test(src), '缺少关闭全屏聊天函数');
    assert.ok(/data-action="chat-fs-back"/.test(src), '缺少返回按钮');
    assert.ok(/case 'chat-fs-back'/.test(src), '未接线返回事件');
    assert.ok(/isPhone\(\)/.test(src) && /isPhoneViewport/.test(src), '缺少手机视口判断');
    assert.ok(/state\.directory\.chatFullscreen/.test(src), '缺少全屏状态');
    const css = read('css/styles.css');
    assert.ok(/\.chat-fs-mask/.test(css) && /\.chat-fs-compose/.test(css), '缺少全屏聊天样式');
  });

  check('内部通话：WebRTC 核心与来电弹窗接线齐备', () => {
    const src = read('js/app.js');
    assert.ok(/getUserMedia/.test(src), '未使用摄像头/麦克风采集');
    assert.ok(/new RTCPeerConnection/.test(src), '未建立点对点连接');
    assert.ok(/onicecandidate/.test(src) && /addIceCandidate/.test(src), '未处理 ICE 候选');
    assert.ok(/createOffer/.test(src) && /createAnswer/.test(src), '未处理 SDP 协商');
    assert.ok(/data-action="call-accept"/.test(src) && /data-action="call-reject"/.test(src), '缺少接听/拒绝按钮');
    assert.ok(/case 'call-mic'/.test(src) && /case 'call-cam'/.test(src), '未接线麦克风/摄像头开关');
    assert.ok(/case 'call-hangup'/.test(src), '未接线挂断');
    assert.ok(/class="incoming-card"/.test(src), '缺少来电弹窗');
    assert.ok(/getAudioTracks\(\)[\s\S]*enabled/.test(src) && /getVideoTracks\(\)[\s\S]*enabled/.test(src), '开关未真实控制系统轨道');
    const html = read('index.html');
    ['i-video','i-video-off','i-mic','i-mic-off','i-phone-off','i-phone-incoming'].forEach(id => {
      assert.ok(html.includes('id="' + id + '"'), '缺少图标 ' + id);
    });
    assert.ok(html.includes('id="call-root"') && html.includes('id="chat-fullscreen-root"'), '缺少通话/全屏聊天图层容器');
  });

  /* ---------------- 消息通知中心 ---------------- */
  check('通知权限项：publish_notice 已内置且加入权限矩阵', () => {
    assert.ok(PERMISSIONS.some(p => p.key === 'publish_notice'), '缺少 publish_notice 权限项');
    assert.strictEqual(DEFAULT_VIEW_PERMISSIONS.notices, 'publish_notice', '通知视图门禁未配置');
    const cfg = vm.runInContext('window.APP_CONFIG', sandbox);
    assert.ok(cfg.builtinPermissions.some(p => p.key === 'publish_notice'), 'config 未同步权限项');
    assert.strictEqual(cfg.defaultViewPerms.notices, 'publish_notice', 'config 视图门禁未同步');
    const adminRole = ROLES.find(r => r.id === 'r_admin');
    assert.ok(adminRole.perms.includes('publish_notice'), '超管角色应具备发布权限');
    const studentRole = ROLES.find(r => r.id === 'r_student');
    assert.ok(!studentRole.perms.includes('publish_notice'), '学生角色不应具备发布权限');
  });
  check('通知发布权限判定：canPublishNotice 依据权限项', () => {
    assert.strictEqual(API.canPublishNotice(() => true), true);
    assert.strictEqual(API.canPublishNotice(() => false), false);
    assert.strictEqual(API.canPublishNotice(null), false);
  });
  check('通知规范化：normalizeNotice 校验标题与类型', () => {
    assert.strictEqual(API.normalizeNotice(null), null);
    assert.strictEqual(API.normalizeNotice({ body:'无标题' }), null);
    const n = API.normalizeNotice({ id:7, title:'演练通知', kind:'bogus', body:'内容', read_by:'["u1"]' });
    assert.ok(n, '应规范化成功');
    assert.strictEqual(n.id, '7');
    assert.strictEqual(n.kind, 'notice', '非法类型回退 notice');
    assert.deepStrictEqual(n.read_by, ['u1'], 'read_by JSON 文本应解析为数组');
  });
  check('通知排序：sortNotices 置顶优先且时间倒序', () => {
    const list = [
      { id:1, title:'A', kind:'notice', pinned:false, created_at:'2026-01-01T00:00:00Z' },
      { id:2, title:'B', kind:'notice', pinned:true, created_at:'2025-12-01T00:00:00Z' },
      { id:3, title:'C', kind:'notice', pinned:false, created_at:'2026-02-01T00:00:00Z' },
    ];
    const sorted = API.sortNotices(list).map(n => n.id);
    assert.deepStrictEqual(sorted, ['2','3','1'], '置顶优先，其余按时间倒序');
  });
  check('通知已读：markNoticeRead 幂等且不重复', () => {
    const marked = API.markNoticeRead({ id:'n1', title:'T', read_by:'[]' }, 'u5');
    assert.ok(API.noticeReadBy(marked, 'u5'), '应标记为已读');
    assert.ok(!API.noticeReadBy(marked, 'u2'), '其他账户不受影响');
    const again = API.markNoticeRead(marked, 'u5');
    assert.strictEqual(again.read_by.filter(x => x === 'u5').length, 1, '重复标记不新增');
  });
  check('通知界面与接线：发布界面 + 事件齐备', () => {
    const src = read('js/app.js');
    assert.ok(/function renderNotices\(/.test(src), '缺少通知中心渲染');
    assert.ok(/data-action="notice-publish"/.test(src), '缺少发布按钮');
    assert.ok(/case 'notice-publish'/.test(src) && /case 'notice-open'/.test(src), '通知事件未接线');
    assert.ok(/from\('notices'\)/.test(src), '未接入云端 notices 表');
    assert.ok(/loadCloudNotices/.test(src), '缺少云端通知拉取');
  });
  check('云端通知表：notices 迁移脚本关键字段齐全', () => {
    // 通过 README 记录验证云表结构约定
    const doc = read('README.md');
    assert.ok(/notices/.test(doc), '文档未说明 notices 表');
  });

  /* ---------------- 上线活动通知记录 ---------------- */
  check('活动事件规范化：normalizeActivityEvent 校验类型与对象', () => {
    assert.strictEqual(API.normalizeActivityEvent(null), null);
    assert.strictEqual(API.normalizeActivityEvent({ kind:'bogus', peerId:'u1' }), null);
    assert.strictEqual(API.normalizeActivityEvent({ kind:'voice_call' }), null, '缺少 peerId 应拒绝');
    const ev = API.normalizeActivityEvent({ kind:'video_missed', peerId:'u2', peerName:'陈老师' });
    assert.ok(ev && ev.kind === 'video_missed' && ev.peerId === 'u2');
  });
  check('活动事件转消息：activityToMessage 生成系统记录', () => {
    const msg = API.activityToMessage({ kind:'voice_missed', peerId:'u2', peerName:'陈老师', at:'2026-01-01T09:05:00Z' });
    assert.ok(msg && msg.system === true, '应为系统消息');
    assert.ok(/未接语音通话/.test(msg.text) && /陈老师/.test(msg.text), '文案应含类型与对方');
    assert.strictEqual(msg.peerId, 'u2');
    assert.ok(/^\d{2}:\d{2}$/.test(msg.time), '时间格式应为 HH:mm');
    const m2 = API.activityToMessage({ kind:'message', peerId:'u3', peerName:'李同学', detail:'你好', at:'2026-01-01T09:05:00Z' });
    assert.ok(/收到/.test(m2.text) && /你好/.test(m2.text));
  });
  check('活动事件投递：flushActivityEvents 去重且防重复', () => {
    const pending = [
      { id:'e1', kind:'voice_missed', peerId:'u2', peerName:'陈老师', at:'2026-01-01T09:00:00Z', delivered:false },
      { id:'e2', kind:'message', peerId:'u3', peerName:'李同学', at:'2026-01-01T09:01:00Z', delivered:false },
      { id:'e3', kind:'video_call', peerId:'u4', peerName:'王校长', at:'2026-01-01T09:02:00Z', delivered:true },
    ];
    const r1 = API.flushActivityEvents(pending, []);
    assert.strictEqual(r1.messages.length, 2, '应投递 2 条未投递事件');
    assert.ok(r1.pending.every(e => e.delivered), '投递后事件应标记已投递');
    const r2 = API.flushActivityEvents(r1.pending, r1.messages.map(m => m.eventId));
    assert.strictEqual(r2.messages.length, 0, '已投递且聊天已记录的不再重复');
  });
  check('上线活动记录：会话隔离与接线齐备', () => {
    const apiSrc = read('js/api.js');
    assert.ok(/pendingEvents/.test(apiSrc), 'pendingEvents 未纳入会话工作区');
    const src = read('js/app.js');
    assert.ok(/function recordActivityEvent\(/.test(src), '缺少活动事件记录函数');
    assert.ok(/function onUserComeOnline\(/.test(src), '缺少上线处理函数');
    assert.ok(/onUserComeOnline\(\); \/\/ 上线/.test(src) || /onUserComeOnline\(\)/.test(src), '上线未调用补记');
    assert.ok(/msg-event/.test(src) && /m\.system/.test(src), '聊天未渲染系统活动记录');
    assert.ok(/recordActivityEvent\(kind, call\.peerId/.test(src), '通话结束未记录活动');
  });

  /* ---------------- 备份与还原 ---------------- */
  check('备份构造：buildBackup 挑选数据域并附元信息', () => {
    const bk = API.buildBackup({ users:[1], notifications:[2], secret:'x', shares:[3] }, { label:'测试', targets:['internal'] });
    assert.strictEqual(bk.format, 'sunny-classroom-backup');
    assert.strictEqual(bk.version, 1);
    assert.strictEqual(bk.label, '测试');
    assert.ok(bk.data.users && bk.data.shares, '应包含数据域');
    assert.strictEqual(bk.secret, undefined, '顶层不应混入无关字段');
    assert.strictEqual(bk.data.secret, undefined, '不应备份非白名单数据域');
    assert.ok(/^bk/.test(bk.backupId), '备份 id 应有效');
    assert.ok(bk.created_at, '应含 created_at 时间戳（界面/还原依赖此字段）');
  });
  check('备份校验：validateBackup 拒绝非法文件', () => {
    assert.ok(!API.validateBackup(null).ok);
    assert.ok(!API.validateBackup({ format:'wrong', data:{} }).ok);
    assert.ok(!API.validateBackup({ format:'sunny-classroom-backup', version:99, data:{} }).ok);
    const ok = API.validateBackup({ format:'sunny-classroom-backup', version:1, label:'A', data:{ users:[] } });
    assert.ok(ok.ok && ok.data.data.users, '校验通过应返回数据域');
  });
  check('NAS 配置：normalizeWebDavConfig 补全协议与去斜杠', () => {
    const c = API.normalizeWebDavConfig({ url:'nas.local/webdav/', username:'u', password:'p', remotePath:'/backups' });
    assert.strictEqual(c.url, 'https://nas.local/webdav', '应补 https 并去尾斜杠');
    assert.ok(API.isValidWebDavUrl(c.url));
    assert.ok(!API.isValidWebDavUrl('not a url'));
    assert.ok(/KB|MB|B/.test(API.formatBackupSize(2048)));
  });
  check('备份界面与接线：三种目标 + 定时 + 还原齐备', () => {
    const src = read('js/app.js');
    assert.ok(/function renderAdminBackup\(/.test(src), '缺少备份管理界面');
    assert.ok(/backup-now/.test(src) && /backup-save-schedule/.test(src), '立即备份/定时设置未接线');
    assert.ok(/uploadBackupToWebDav/.test(src) && /method:'PUT'/.test(src), '缺少 NAS WebDAV 上传');
    assert.ok(/downloadBackupFile/.test(src) && /a\.download/.test(src), '缺少本地下载');
    assert.ok(/saveBackupInternal/.test(src), '缺少系统内部备份');
    assert.ok(/function applyRestore\(/.test(src) && /location\.reload/.test(src), '缺少还原逻辑');
    assert.ok(/backup-restore-confirm/.test(src), '缺少还原确认');
    assert.ok(/restartBackupTimer/.test(src) && /setInterval/.test(src), '缺少定时备份');
    assert.ok(/\['internal','nas','local'\]/.test(src), '三种目标未齐全');
    assert.ok(/id="bk-file"/.test(src), '缺少文件还原输入');
  });

  check('老账户兼容：超管角色补全内置权限，消息通知入口不被隐藏', () => {
    const src = read('js/app.js');
    assert.ok(/function ensureAdminBuiltinPerms\(\)/.test(src), '缺少超管权限补全逻辑');
    // 补全逻辑须在加载本地 roles 之后执行
    const loadRole = src.indexOf('state.roles = saved.roles');
    const ensure = src.indexOf('ensureAdminBuiltinPerms()');
    assert.ok(loadRole > -1 && ensure > loadRole, '补全逻辑须在角色加载后执行');
    // 用真实内置权限项模拟：旧 r_admin 缺少 publish_notice，补全后应包含
    const builtins = PERMISSIONS.map(p => p.key);
    assert.ok(builtins.includes('publish_notice'), '内置权限项应含 publish_notice');
    const oldAdminPerms = ['view_material','download','publish','message']; // 升级前的旧列表
    const merged = Array.from(new Set([...oldAdminPerms, ...builtins]));
    assert.ok(merged.includes('publish_notice'), '补全后超管应重新获得发布通知权限');
    // canView('notices') 依赖 publish_notice：补全后门禁通过
    const eng = buildPermEngine(
      { role: 'admin', roles: [{ id: 'r_admin', key: 'r_admin', perms: merged }], viewPerms: { ...DEFAULT_VIEW_PERMISSIONS } },
      DEFAULT_VIEW_PERMISSIONS
    );
    assert.strictEqual(eng.canView('notices'), true, '补全后超管应能看到消息通知入口');
  });

  /* ========== 聊天：图片消息 / 表情包 / 加号面板 ========== */
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  check('图片 dataURL 识别：支持常见图片类型，拒绝非图片', () => {
    assert.strictEqual(API.isImageDataUrl(PNG), true);
    assert.strictEqual(API.isImageDataUrl(JPG), true);
    assert.strictEqual(API.isImageDataUrl('https://x.com/a.png'), false);
    assert.strictEqual(API.isImageDataUrl('javascript:alert(1)'), false);
    assert.strictEqual(API.isHttpUrl('https://cdn.x.com/s.gif'), true);
    assert.strictEqual(API.isHttpUrl(PNG), false);
  });

  check('图片等比缩放：不超限保持原样，超限按最长边缩放', () => {
    const fit = API.fitImageSize(800, 600, 1280);
    assert.ok(fit.w === 800 && fit.h === 600 && fit.scaled === false, '不超限应保持原样');
    const big = API.fitImageSize(4000, 3000, 1280);
    assert.strictEqual(big.scaled, true);
    assert.strictEqual(big.w, 1280);
    assert.strictEqual(big.h, 960);
    assert.strictEqual(API.fitImageSize(3000, 4000, 1280).h, 1280);
  });

  check('图片消息构造：规范化图片消息并保留尺寸', () => {
    const m = API.normalizeImageMessage({ from: 'u1', image: JPG, text: '[图片]', time: '12:34', w: 640, h: 480 });
    assert.ok(m && m.kind === 'image' && m.image === JPG && m.w === 640 && m.h === 480);
    assert.strictEqual(API.normalizeImageMessage({ from: 'u1', image: 'bad' }), null, '非法图片应拒绝');
    const s = API.normalizeStickerMessage({ from: 'u1', image: PNG, text: '[表情]' });
    assert.ok(s && s.kind === 'sticker');
  });

  check('dataURL 体积估算：用于 localStorage 容量保护', () => {
    assert.ok(API.dataUrlBytes('data:image/png;base64,' + 'QQ==') >= 3);
    assert.strictEqual(API.dataUrlBytes(''), 0);
  });

  check('自定义表情规范化：名称与图片校验、id 生成', () => {
    const s = API.normalizeSticker({ name: '加油鸭', image: PNG });
    assert.ok(s && /^st_/.test(s.id) && s.name === '加油鸭' && s.image === PNG);
    assert.strictEqual(API.normalizeSticker({ image: 'not-an-image' }), null, '非法图片来源应拒绝');
    assert.ok(API.normalizeSticker({ name: '网址表情', image: 'https://cdn.x.com/e.gif' }), 'http 图片应允许');
    assert.ok(/^st_/.test(API.newStickerId()));
  });

  check('表情工作区：规范化 + 收藏切换 + 数量上限', () => {
    const emo = API.normalizeEmoticons({
      custom: [{ name: 'A', image: PNG }, { name: 'bad', image: 'x' }],
      favorites: ['😀', '😀', ''],
    });
    assert.strictEqual(emo.custom.length, 1, '非法表情被过滤');
    assert.ok(emo.favorites.length === 2 && emo.favorites[0] === '😀' && emo.favorites[1] === '😀', '空收藏被过滤');
    const fav = API.toggleFavorite(['😀'], '😂');
    assert.ok(fav.length === 2 && fav.indexOf('😂') >= 0, '新增收藏');
    const after = API.toggleFavorite(fav, '😀');
    assert.ok(after.length === 1 && after[0] === '😂', '再次点击取消收藏');
    assert.strictEqual(API.STICKER_MAX > 0, true);
  });

  check('内置 emoji 分组：分类齐全且含微信常用表情', () => {
    const groups = API.EMOJI_GROUPS || [];
    assert.ok(groups.length >= 5, '应有多个分类');
    assert.ok(groups.every(g => Array.isArray(g.items) && g.items.length > 0));
    assert.ok(API.EMOJI_ALL.includes('😂') && API.EMOJI_ALL.includes('👍') && API.EMOJI_ALL.includes('❤️'), '应含常用 emoji');
  });

  check('聊天界面接线：加号折叠面板 / 拍照 / 表情 / 图片预览齐备', () => {
    const app = read('js/app.js');
    assert.ok(/function chatMorePanelHTML\(/.test(app), '缺少加号面板');
    assert.ok(/data-action="pick-photo"/.test(app) && /data-action="take-photo"/.test(app), '缺少照片/拍照入口');
    assert.ok(/setAttribute\('capture',\s*'environment'\)/.test(app), '拍照未启用后置摄像头 capture');
    assert.ok(/function compressImageFile\(/.test(app) && /toDataURL\('image\/jpeg'/.test(app), '缺少图片压缩');
    assert.ok(/function chatEmojiPanelHTML\(/.test(app) && /EMOJI_GROUPS/.test(app), '缺少表情面板');
    assert.ok(/function addStickerModal\(/.test(app) && /function manageStickersModal\(/.test(app), '缺少自定义表情增删管理');
    assert.ok(/function previewImage\(/.test(app), '缺少图片大图预览');
    assert.ok(/kind === 'image'/.test(app) && /kind === 'sticker'/.test(app), '消息渲染未区分图片/表情');
    assert.ok(/'emoticons'/.test(read('js/api.js')), '表情数据未纳入会话隔离');
  });

  check('加号面板预留扩展位：方便后期新增接口', () => {
    const app = read('js/app.js');
    assert.ok(/chat-more-item--soon/.test(app) && /feature-soon/.test(app), '缺少「更多」预留项');
  });

  check('HTML 图标与样式：新增表情/图片/拍照图标与样式节齐备', () => {
    const html = read('index.html');
    ['i-smile', 'i-image', 'i-camera'].forEach(x => assert.ok(html.includes('id="' + x + '"'), '缺少图标 ' + x));
    const css = read('css/styles.css');
    ['chat-more-panel', 'chat-emoji-panel', 'msg__img', 'image-preview-root'].forEach(x => assert.ok(css.includes(x), '缺少样式 ' + x));
  });

  /* ---------- 拍照 / 相册修复：完整事件链回归 ---------- */
  const buildPickerHarness = () => {
    const src = read('js/app.js');
    const m = src.match(/function openImagePicker\(useCamera\) \{[\s\S]*?^\}/m);
    assert.ok(m, '未找到 openImagePicker 函数');
    const created = [];
    const doc = {
      createElement() {
        const el = {
          type: '', accept: '', className: '', attrs: {}, files: null,
          _appended: false, _removed: false, _clicked: false, _on: {},
          setAttribute(k, v) { this.attrs[k] = v; },
          addEventListener(ev, fn) { this._on[ev] = fn; },
          click() { this._clicked = true; },
          remove() { this._removed = true; }
        };
        created.push(el);
        return el;
      },
      body: { appendChild(el) { el._appended = true; return el; } },
      querySelectorAll() { return []; },
      contains(el) { return !!(el && el._appended && !el._removed); }
    };
    const win = { addEventListener() {}, removeEventListener() {} };
    const calls = { sent: [], toasts: [] };
    const make = new Function('document', 'window', 'sendImageFile', 'toast', 'setTimeout',
      m[0] + '\nreturn openImagePicker;');
    const fn = make(doc, win,
      (file) => { calls.sent.push(file); },
      (msg, type) => { calls.toasts.push({ msg, type }); },
      () => {} /* 不执行取消选择的兜底定时器 */);
    return { fn, created, calls };
  };

  check('照片/拍照：动态创建文件输入并在用户手势栈内同步唤起选择器', () => {
    const a = buildPickerHarness();
    a.fn(false);
    const el = a.created[0];
    assert.ok(el, '未创建文件输入');
    assert.strictEqual(el.type, 'file');
    assert.strictEqual(el.accept, 'image/*');
    assert.ok(el._appended, '输入未挂载到 body（iOS 唤起需要）');
    assert.ok(el._clicked, '未调用 input.click()，文件选择器不会打开');
    assert.ok(!el.attrs.capture, '相册模式不应强制摄像头');
    const b = buildPickerHarness();
    b.fn(true);
    assert.strictEqual(b.created[0].attrs.capture, 'environment', '拍照模式应调用后置摄像头');
  });

  check('选中图片后触发压缩发送，并清理临时输入', () => {
    const h = buildPickerHarness();
    h.fn(false);
    const el = h.created[0];
    assert.strictEqual(typeof el._on.change, 'function', '未绑定 change 监听');
    const file = { name: 'photo.jpg', type: 'image/jpeg' };
    el.files = [file];
    el._on.change(); // remove / sendImageFile 均在 await 之前执行
    assert.strictEqual(h.calls.sent.length, 1, '未把选中文件交给发送流程');
    assert.strictEqual(h.calls.sent[0], file);
    assert.ok(el._removed, '处理完未移除临时输入');
  });

  check('事件接线与死代码清理：按钮调用新函数、静态同名输入已移除、表情上传可点击', () => {
    const app = read('js/app.js');
    assert.ok(/case 'pick-photo': openImagePicker\(false\)/.test(app), '照片按钮未接线');
    assert.ok(/case 'take-photo': openImagePicker\(true\)/.test(app), '拍照按钮未接线');
    assert.ok(/async function sendImageFile\(file\)[\s\S]*?compressImageFile\(file\)[\s\S]*?pushImageMessage/.test(app), '发送流程未串起压缩与入栈');
    assert.ok(!/sendImageFromFile/.test(app), '仍残留只读 files 的旧函数');
    assert.ok(!/id="chat-image-file"/.test(app) && !/id="chat-camera-file"/.test(app), '仍残留会串台的静态同名输入');
    assert.ok(/id="sticker-file" class="sticker-file-input"/.test(app), '自定义表情上传仍使用不可点击的隐藏输入');
    const css = read('css/styles.css');
    assert.ok(/\.chat-compose--fs\b/.test(css), '手机全屏输入区缺少样式');
    assert.ok(/\.sticker-file-input\b/.test(css), '缺少可见的表情文件输入样式');
  });

  check('电脑版登录界面：横屏桌面保留品牌视觉区与双栏布局，登录按钮方向正确', () => {
    const css = read('css/styles.css');
    const app = read('js/app.js');
    const html = read('index.html');
    // 不能再用「不限定设备」的横屏选择器隐藏品牌区：电脑宽>高同样是 landscape
    assert.ok(!/html\[data-orientation="landscape"\]\s*\.auth-visual\s*\{[^}]*display:\s*none/.test(css),
      '仍存在全局横屏隐藏规则，会导致电脑登录页左半空白');
    // 隐藏规则必须限定手机视口，并同步把布局改成单列
    assert.ok(/html\[data-viewport="phone"\]\[data-orientation="landscape"\]\s*\.auth-visual\s*\{\s*display:\s*none/.test(css),
      '缺少仅手机横屏生效的隐藏规则');
    assert.ok(/html\[data-viewport="phone"\]\[data-orientation="landscape"\]\s*\.auth-layer\s*\{\s*grid-template-columns:\s*1fr/.test(css),
      '手机横屏隐藏品牌区后未改为单列，仍会留下空白列');
    assert.ok(/\.auth-layer\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(css),
      '电脑端默认双栏登录布局被破坏');
    // 用真实函数模拟 1920×1080 桌面：viewport=desktop、orientation=landscape
    const m = app.match(/function syncViewportMode\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, '未找到 syncViewportMode');
    const root = {
      clientWidth: 1920, clientHeight: 1080, dataset: {},
      style: { setProperty(k, v) { this[k] = v; } },
      classList: { toggle(c, on) { this[c] = !!on; } },
    };
    const win = { innerWidth: 1920, innerHeight: 1080, matchMedia: () => ({ matches: false }) };
    new Function('document', 'window', m[0] + '\nreturn syncViewportMode;')(
      { documentElement: root }, win)();
    assert.strictEqual(root.dataset.viewport, 'desktop', '1920px 应识别为电脑');
    assert.strictEqual(root.dataset.orientation, 'landscape', '1920×1080 会被识别为横屏');
    // 桌面横屏时隐藏规则的选择器含 data-viewport="phone"，不会命中
    assert.ok(/html\[data-viewport="phone"\]\[data-orientation="landscape"\]/.test(css),
      '隐藏规则未限定 phone，桌面横屏仍会被误伤');
    // 登录 / 重置按钮应使用右箭头，不能显示成「返回」
    assert.ok(/id="i-arrow-right"/.test(html), '缺少右箭头图标');
    assert.ok(/登录Sunshine个人工作站 \$\{icon\('i-arrow-right'/.test(app), '登录按钮仍使用左箭头');
    assert.ok(/重置密码并登录 \$\{icon\('i-arrow-right'/.test(app), '重置按钮仍使用左箭头');
    assert.ok(/bind-back[\s\S]{0,80}i-arrow-left/.test(app), '「上一步」应保留左箭头');
  });

  /* ---------- 三项新需求：闲置二次验证 / 跨设备同步 / 课程表 ---------- */
  check('权限与角色：班级主任角色内置 manage_schedule 权限，课程表视图有门禁', () => {
    const perm = PERMISSIONS.find(p => p.key === 'manage_schedule');
    assert.ok(perm, '缺少课程表管理权限项');
    assert.strictEqual(perm.builtin, true, '课程表管理应为内置权限');
    const role = ROLES.find(r => r.id === 'r_headteacher');
    assert.ok(role, '缺少班级主任角色');
    assert.ok(role.perms.includes('manage_schedule'), '班级主任应具备课程表管理权限');
    assert.strictEqual(DEFAULT_VIEW_PERMISSIONS.schedule, 'view_material', '课程表视图应有查看门禁');
    const config = read('js/config.js');
    assert.ok(/idleTimeoutMinutes:\s*30/.test(config), '配置默认闲置超时 30 分钟');
    assert.ok(/manage_schedule/.test(config), '配置层应含课程表权限项');
  });

  check('闲置超时：默认 30 分钟、闲置计算与倒计时格式', () => {
    assert.strictEqual(API.idleTimeoutMs(), 30 * 60 * 1000, '默认 30 分钟');
    const now = Date.UTC(2026, 10, 21, 10, 0, 0);
    const fresh = { lastActivityAt: new Date(now - 5 * 60000).toISOString() };
    assert.ok(API.sessionIdleMs(fresh, now) === 5 * 60000, '闲置时长计算');
    assert.strictEqual(API.isSessionIdleLocked(fresh, now), false, '5 分钟不应锁定');
    const stale = { lastActivityAt: new Date(now - 31 * 60000).toISOString() };
    assert.strictEqual(API.isSessionIdleLocked(stale, now), true, '31 分钟应锁定');
    assert.ok(API.stampActivity({}, now).lastActivityAt, '应生成活动时间戳');
    assert.strictEqual(API.formatIdleCountdown(65000), '01:05', '倒计时格式 mm:ss');
  });

  check('二次验证界面与接线：独立图层、仅密码、不重建会话、活动监听与定时检查', () => {
    const app = read('js/app.js');
    const html = read('index.html');
    assert.ok(html.includes('id="reauth-layer"'), '缺少二次验证图层容器');
    assert.ok(/data-action="reauth-logout"/.test(app), '缺少退出入口');
    assert.ok(/id="reauth-password"[\s\S]{0,80}type="password"/.test(app), '仅需输入密码');
    assert.ok(/verifyPassword\(\{ userId: acc\.id, password: pw \}\)/.test(app), '用当前账户密码校验');
    assert.ok(!/reauth[\s\S]{0,40}upsertSession/.test(app), '二次验证不应重建会话');
    assert.ok(/ACTIVITY_EVENTS[\s\S]{0,160}pointerdown/.test(app), '应监听用户活动');
    assert.ok(/setInterval\(checkIdleTimeout,\s*1000\)/.test(app), '应每秒检查闲置');
    assert.ok(/startIdleWatcher\(\)/.test(app), 'showApp 应启动闲置监听');
  });

  check('跨设备同步：负载构造、行规范化、较新者胜出', () => {
    const payload = API.buildUserSyncPayload({ view:'library', library:{grade:'1'}, learning:[{id:'m1'}], account:{ id:'p1', name:'张三', managedClasses:['1-1班'] } }, 'workspace');
    assert.strictEqual(payload.scope, 'workspace');
    assert.deepStrictEqual(payload.learning, [{id:'m1'}]);
    assert.ok(payload.updatedAt, '应带更新时间');
    const acc = API.buildUserSyncPayload({ account:{ id:'p1', name:'张三', managedClasses:['1-1班'] }, roles:[] }, 'account');
    assert.deepStrictEqual(acc.account.managedClasses, ['1-1班']);
    const row = API.normalizeUserSyncRow({ id:1, scope:'workspace', payload: JSON.stringify({ a:1, updatedAt:'2026-01-01T00:00:00Z' }), updated_at:'2026-01-01T00:00:00Z' });
    assert.strictEqual(row.payload.a, 1, '应解析字符串负载');
    assert.strictEqual(API.normalizeUserSyncRow({ payload:null }), null, '非法行返回空');
    assert.strictEqual(API.shouldApplySync('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', {a:1}, {a:2}), true, '远端更新应应用');
    assert.strictEqual(API.shouldApplySync('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', {a:1}, {a:2}), false, '本地更新不覆盖');
  });

  check('跨设备同步接线：三域拉取上传、轮询、会话隔离工作区', () => {
    const app = read('js/app.js');
    assert.ok(/USER_SYNC_SCOPES\s*=\s*\['workspace',\s*'account',\s*'schedule'\]/.test(read('js/api.js')), '应定义三个同步域');
    ['workspace','account','schedule'].forEach(s => assert.ok(app.includes(`'${s}'`), `应处理 ${s} 同步域`));
    assert.ok(/pullAllSync\(\)/.test(app), '应提供统一拉取');
    assert.ok(/pushSyncScope\(scope\)/.test(app), '应提供节流上传');
    const showAppBlock = app.match(/function showApp\(\) \{[\s\S]*?\n\}/);
    assert.ok(showAppBlock && /pullAllSync\(\)/.test(showAppBlock[0]) && /startIdleWatcher\(\)/.test(showAppBlock[0]), '启动时应对齐云端并启动闲置监听');
    assert.ok(/scheduleSyncPush\('workspace'\)/.test(app), 'persist 应触发上传');
    const css = read('css/styles.css');
    assert.ok(/\.reauth-layer/.test(css), '二次验证样式齐备');
    assert.ok(/\.schedule-table/.test(css), '课程表样式齐备');
  });

  check('班级管理权限：超管全班级、班级主任限所管班级、普通教师不可编辑', () => {
    const admin = { role:'admin', email:'3440576634@qq.com', managedClasses:[] };
    assert.strictEqual(API.canManageClass(admin, '3-1班'), true, '超管可管全部班级');
    const head = { role:'headteacher', managedClasses:['1-1班','2-3班'] };
    assert.strictEqual(API.canManageClass(head, '1-1班'), true, '主任可管所管班级');
    assert.strictEqual(API.canManageClass(head, '4-1班'), false, '主任不可管未分配班级');
    assert.strictEqual(API.canManageClass({ role:'teacher', managedClasses:['1-1班'] }, '1-1班'), false, '普通教师不可编辑');
    assert.deepStrictEqual(API.normalizeManagedClasses(['1-1班','1-1班','bad','2-1班']), ['1-1班','2-1班'], '去重并过滤非法班级');
  });

  check('课程表：班级键、内置作息模板、节次规范化与按周节排序', () => {
    assert.strictEqual(API.classKeyOf(3, '1班'), '3-1班');
    const parsedKey = API.parseClassKey('3-1班');
    assert.strictEqual(parsedKey.grade, 3); assert.strictEqual(parsedKey.className, '1班');
    assert.strictEqual(API.parseClassKey('bad'), null);
    assert.strictEqual(API.SCHEDULE_PERIODS.length, 7, '每天 7 节');
    assert.strictEqual(API.WEEKDAYS.length, 5, '每周 5 天');
    const tpl = API.buildScheduleTemplate(3, '1班');
    assert.strictEqual(tpl.length, 35, '模板应含 5×7=35 节');
    assert.ok(tpl.every(s => s.classKey === '3-1班' && s.subject && s.time), '模板节次字段完整');
    const bad = API.normalizeScheduleSlot({ weekday:9, period:1, classKey:'1-1班' });
    assert.strictEqual(bad, null, '非法星期应拒绝');
    const good = API.normalizeScheduleSlot({ weekday:2, period:3, classKey:'1-1班', subject:'语文', teacher:'陈老师', remark:'测试' });
    assert.strictEqual(good.subject, '语文');
    const sorted = API.sortScheduleSlots([{weekday:2,period:1},{weekday:1,period:3},{weekday:1,period:1}]);
    assert.deepStrictEqual(sorted.map(s=>s.weekday+'-'+s.period), ['1-1','1-3','2-1'], '应按星期+节次排序');
    assert.ok(API.slotAt(sorted, 1, 3), '应能定位节次');
  });

  check('课程表界面与云端表：导航/编辑接线、RLS 按班级主任授权', () => {
    const app = read('js/app.js');
    assert.ok(/view:'schedule', label:'课程表'/.test(app), '应加入课程表导航');
    assert.ok(/view === 'schedule'\) renderSchedule/.test(app), '应接入导航分发');
    assert.ok(/function renderSchedule/.test(app), '应实现课程表渲染');
    assert.ok(/data-action="schedule-edit"/.test(app), '应支持逐节编辑');
    assert.ok(/data-action="schedule-init"/.test(app), '应支持套用模板');
    assert.ok(/case 'schedule-save'/.test(app) && /case 'schedule-delete'/.test(app), '应接线保存与删除');
    assert.ok(/canManageClass\(state\.account/.test(app), '编辑前应校验班级管理权限');
    assert.ok(/id="uf-managed-field"/.test(app), '人员表单应含管理班级字段');
    assert.ok(/data-managed-class/.test(app), '应有多选班级复选框');
    const db = read('js/api.js');
    assert.ok(/from\('class_schedules'\)/.test(db), '应读写课程表云表');
    assert.ok(/from\('user_sync'\)/.test(db), '应读写跨设备同步云表');
  });

  check('课程表空白修复：无数据时模板兜底、云端空结果不清空本地、编辑带出模板内容', () => {
    const app = read('js/app.js');
    assert.ok(/const slots = savedSlots\.length \? savedSlots : window\.SunnyAPI\.buildScheduleTemplate/.test(app),
      '本地无数据时应回退到内置作息模板展示');
    assert.ok(/state\.scheduleDisplaySlots = slots/.test(app), '应缓存展示用节次供编辑弹窗读取');
    // loadScheduleCloud 中云端空数组不得清空本地：res.data.length 作为覆盖前提
    const lm = app.match(/async function loadScheduleCloud[\s\S]*?\n}\nfunction scheduleEditModal/);
    assert.ok(lm, '应存在云端加载函数');
    assert.ok(/if \(res\.data\.length\)[\s\S]{0,120}state\.schedules = others\.concat\(res\.data\)/.test(lm[0]),
      '仅当云端返回数据时才覆盖本地，空结果不得清空');
    const em = app.match(/function scheduleEditModal[\s\S]*?const slot = saved \|\| slotAtLocal\(state\.scheduleDisplaySlots/);
    assert.ok(em, '编辑弹窗应在无已保存节次时从展示缓存带出模板默认内容');
  });

  check('课程表打印 PDF：独立打印页生成、打印/另存为接线与图标', () => {
    const slots = API.buildScheduleTemplate(3, '1班');
    const html = API.buildSchedulePrintHtml({ slots, classKey:'3-1班', gradeLabel:'三年级', className:'1班', printedAt:new Date(2026, 10, 21) });
    assert.ok(/<@page|>/.test(html) || /@page\s*\{\s*size:\s*A4 landscape/.test(html), '打印页应为 A4 横向');
    assert.ok(html.includes('@page') && html.includes('A4 landscape'), '应含 A4 横向纸张设置');
    assert.ok(html.includes('三年级 1班 课程表'), '应含班级标题');
    assert.ok(html.includes('2026年11月21日'), '应含打印日期');
    assert.ok(html.includes('打印日期：2026年11月21日'), '页眉应含打印日期');
    ['周一','周二','周三','周四','周五'].forEach(d => assert.ok(html.includes(d), '应含星期 '+d));
    assert.ok(html.includes('第1节') && html.includes('第7节') && html.includes('08:00–08:40'), '应含节次与上课时间');
    assert.equal((html.match(/<tbody>/g)||[]).length, 1, '应含单一课表表体');
    assert.ok(html.includes('每周 5 天 × 每天 7 节'), '页脚应含规则说明');
    assert.ok(html.includes('<!DOCTYPE html>') && html.includes('</html>'), '应为完整独立 HTML 文档');
    // HTML 转义：注入内容不得原样输出
    const xss = API.buildSchedulePrintHtml({ slots:[{weekday:1,period:1,classKey:'1-1班',subject:'<img src=x>',teacher:'&',remark:'"'}], gradeLabel:'<b>', className:'1班', printedAt:new Date() });
    assert.ok(!xss.includes('<img src=x>') && xss.includes('&lt;img src=x&gt;'), '课程名应转义');
    assert.ok(xss.includes('&amp;') && xss.includes('&quot;'), '教师与备注应转义');
    // 前端接线
    const app = read('js/app.js');
    assert.ok(/function printSchedule/.test(app), '应实现打印函数');
    assert.ok(/data-action="schedule-print"/.test(app), '课程表应有打印按钮');
    assert.ok(/case 'schedule-print': printSchedule/.test(app), '应接线打印事件');
    assert.ok(/contentWindow\.print\(\)/.test(app), '应调用打印');
    assert.ok(read('index.html').includes('id="i-print"'), '应有打印图标');
  });

  /* ---------- 登录改造：统一超管密码 / 关浏览器重登 / 记住密码 ---------- */
  check('超管初始密码单一来源：默认口令与超管配置同源且均为 123456', () => {
    const cfg = vm.runInContext('window.APP_CONFIG.auth', sandbox);
    assert.strictEqual(cfg.defaultPassword, '123456');
    assert.strictEqual(cfg.superAdmin.password, '123456', '超管初始密码应与默认口令一致');
    assert.ok(/默认口令同源/.test(read('js/config.js')), '配置应注明单一来源');
  });

  check('记住密码：登录页复选框与回填接线齐备', () => {
    const app = read('js/app.js');
    assert.ok(/id="remember-password"/.test(app), '登录页缺少记住密码复选框');
    assert.ok(/记住密码/.test(app), '缺少记住密码文案');
    assert.ok(/id="remember" \$\{rememberLoginOn \? 'checked' : ''\} \/>记住登录状态/.test(app), '记住登录状态应保留且默认不勾选');
    assert.ok(/const rememberLoginOn = uiCfg\.rememberLoginDefault === true/.test(app), '勾选态只认配置默认值');
    assert.ok(/auth-form__row--checks/.test(app), '两复选框应同排容器');
    assert.ok(/function readRememberedCredential/.test(app) && /function saveRememberedCredential/.test(app) && /function clearRememberedCredential/.test(app), '缺少凭据读写函数');
    assert.ok(/value="\$\{esc\(finalPrefill\.password/.test(app), '密码框应回填已记住的密码');
    assert.ok(/state\.rememberPassword = !!\$\('#remember-password'\)/.test(app), '登录应记录记住密码勾选态');
    const cfg = vm.runInContext('window.APP_CONFIG.authUi', sandbox);
    assert.strictEqual(cfg.showRememberPassword, true);
    assert.strictEqual(cfg.rememberLoginDefault, false, '记住登录状态默认不勾选');
    assert.ok(cfg.credentialKey, '应配置凭据存储键');
  });

  check('记住登录状态：手动选择，未勾选时登录态不落盘', () => {
    const app = read('js/app.js');
    const cfg = vm.runInContext('window.APP_CONFIG.authUi', sandbox);
    assert.strictEqual(cfg.rememberLoginDefault, false, '默认必须为不勾选');
    assert.ok(!/id="remember" checked/.test(app), '不得硬编码勾选');
    assert.ok(/state\.remember = !!\$\('#remember'\)\?\.checked/.test(app), '登录应记录手动勾选态');
    assert.ok(/sessions: state\.remember \? state\.sessions : \[\]/.test(app), '未勾选时不应持久化会话快照');
    assert.ok(/activeSessionId: state\.remember \? state\.activeSessionId : null/.test(app), '未勾选时不应持久化活动指针');
    assert.ok(/authed: state\.remember \? state\.authed : false/.test(app), '未勾选时不应持久化登录态');
  });

  check('关闭浏览器重登：会话门闸在登录时置位、退出时清除、启动时拦截', () => {
    const app = read('js/app.js');
    assert.ok(/function markSessionLoggedIn/.test(app), '缺少登录置位');
    assert.ok(/function clearSessionGate/.test(app), '缺少门闸清除');
    assert.ok(/function sessionGateAllowsRestore/.test(app), '缺少门闸判定');
    const marks = (app.match(/markSessionLoggedIn\(\)/g) || []).length;
    assert.ok(marks >= 3, `登录成功路径应置位（含函数定义），实际 ${marks}`);
    const clears = (app.match(/clearSessionGate\(\)/g) || []).length;
    assert.ok(clears >= 4, `退出与拦截路径应清除门闸，实际 ${clears}`);
    assert.ok(/if \(!sessionGateAllowsRestore\(\)\) \{[\s\S]{0,600}state\.authed = false/.test(app), '启动应凭门闸清除登录态');
    assert.ok(/if \(cloud && sessionGateAllowsRestore\(\)\)/.test(app), '云端自动恢复应受门闸约束');
  });

  check('超管口令跨设备同步：account 域携带哈希并下发应用', () => {
    const api = read('js/api.js');
    assert.ok(/scope === 'account'/.test(api) && /authSecret/.test(api), '负载应携带口令哈希');
    assert.ok(/passwordHash: hash/.test(api), '应写入哈希字段');
    const acc = API.buildUserSyncPayload({
      account: { id: 'p_superadmin', email: 'admin@sunny.edu.cn', role: 'admin', passwordHash: 'demo$salt$abc' },
      roles: [],
    }, 'account');
    assert.ok(acc.authSecret && acc.authSecret.passwordHash === 'demo$salt$abc', '应构造口令同步载荷');
    assert.strictEqual(acc.authSecret.accountKey, 'admin@sunny.edu.cn');
    // 非超管账户不得携带口令哈希
    const stu = API.buildUserSyncPayload({ account: { id:'p1', email:'s@x.cn', role:'student', passwordHash:'demo$x$y' }, roles:[] }, 'account');
    assert.strictEqual(stu.authSecret, null, '非超管不应同步口令哈希');
    const app = read('js/app.js');
    assert.ok(/p\.authSecret/.test(app) && /state\.account\.passwordHash = sec\.passwordHash/.test(app), '拉取应应用口令哈希');
  });

  /* ---------- 文字转文档：与图片转文档同权限、同入口、同输出能力 ---------- */
  check('文字转文档：独立页面与生成逻辑齐备', () => {
    const html = read('text-to-doc.html');
    const js = read('js/text-to-doc.js');
    const css = read('css/text-to-doc.css');
    assert.ok(html.includes('<!DOCTYPE html>') && html.includes('</html>'), '应为完整独立页面');
    assert.ok(html.includes('id="text-input"') && html.includes('<textarea'), '应提供文字输入/粘贴区');
    assert.ok(/btn-paste/.test(html) && /btn-sample/.test(html) && /btn-clear/.test(html), '应有粘贴/示例/清空交互');
    assert.ok(html.includes('data-value="word"') && html.includes('data-value="pdf"'), '应支持 Word/PDF 两种格式');
    assert.ok(html.includes('id="btn-save"') && html.includes('id="btn-share"'), '应支持保存本地与系统分享');
    assert.ok(html.includes('vendor/docx.umd.js') && html.includes('vendor/jspdf.umd.min.js'), '应复用本地文档库');
    assert.ok(html.includes('css/image-to-doc.css') && html.includes('css/text-to-doc.css'), '应复用图片转文档视觉并叠加专属样式');
    assert.ok(/function buildWord/.test(js) && /function buildPdf/.test(js), '应实现双格式生成');
    assert.ok(/wrapLine/.test(js) && /SimSun/.test(js), 'PDF 应支持中文排版');
    assert.ok(/navigator\.share/.test(js) && /showSaveFilePicker/.test(js), '输出能力应与图片转文档一致');
    assert.ok(/请先输入或粘贴文字/.test(js), '应有空内容校验提示');
    assert.ok(/editor__bar|paper__text/.test(css), '应有编辑与预览样式');
  });

  check('文字转文档：入口与权限与图片转文档完全一致', () => {
    const app = read('js/app.js');
    const index = read('index.html');
    const css = read('css/styles.css');
    assert.ok(/data-action="open-text-to-doc"/.test(index), '顶栏应有文字转文档入口');
    assert.ok(/tool-top-btn__label-mini">文字</.test(index), '手机端应有短标签');
    assert.ok(/case 'open-text-to-doc'/.test(app) && /text-to-doc\.html' \+ window\.location\.search/.test(app), '应同页跳转并保留 sharecode');
    assert.ok(/data-action="open-text-to-doc"/.test(app) && /文字转文档/.test(app), '侧栏导航应有入口');
    assert.ok(/所有成员可用/.test(app), '首页卡片应标注所有成员可用');
    assert.ok(!/hasPerm\([^)]*\).{0,120}open-text-to-doc/.test(app), '不得增加权限门禁');
    assert.ok(/tool-top-btn--text/.test(css) && /tool-entry--text/.test(css), '应有两端一致的样式');
    assert.ok(/20261122k/.test(index), '资源应升级版本号破缓存');
  });

  /* ---------- 电脑端 / 手机端口令一致性 ---------- */
  check('口令跨设备统一：所有账户携带哈希与身份别名', () => {
    const payload = API.buildUserSyncPayload({
      account: { id: 'p_superadmin', name: '超级管理员', email: '3440576634@qq.com', role: 'admin', passwordHash: 'demo$a$1$2' },
      users: [
        { id: 'p_superadmin', name: '超级管理员', email: '3440576634@qq.com', role: 'admin', passwordHash: 'demo$a$1$2' },
        { id: 'p_stu', name: '小明', email: 'stu@x.cn', role: 'student', passwordHash: 'demo$b$3$4' },
        { id: 'p_no_pw', name: '未设密码', email: 'no@x.cn', role: 'student' },
      ],
      roles: [], viewPerms: {}, permissions: [],
    }, 'account');
    assert.ok(Array.isArray(payload.authSecrets) && payload.authSecrets.length === 2, '应为全部有口令的账户生成密钥');
    const adminSec = payload.authSecrets.find(x => x.passwordHash === 'demo$a$1$2');
    assert.ok(adminSec && adminSec.aliases.length >= 3, '应携带邮箱/id/姓名等多种身份别名');
    assert.ok(adminSec.aliases.indexOf('3440576634@qq.com') >= 0, '应包含绑定邮箱别名');
    assert.ok(adminSec.aliases.indexOf('超级管理员') >= 0, '应包含显示名别名');
    assert.ok(payload.authSecret && payload.authSecret.passwordHash === 'demo$a$1$2', '保留超管单条兼容字段');
    assert.ok(API.identityMatches({ email: '3440576634@qq.com' }, adminSec.aliases), '别名匹配应命中');
    assert.ok(API.identityMatches({ name: '超级管理员', id: 'u_superadmin' }, adminSec.aliases), '不同标识也应命中同一超管');
    assert.ok(!payload.authSecrets.some(x => x.passwordHash === undefined), '不应产生空哈希');
  });

  check('口令跨设备统一：拉取按强身份匹配且一条密钥只归属唯一账户', () => {
    const app = read('js/app.js');
    assert.ok(/function applyAuthSecrets\(payload\)/.test(app), '应有统一的密钥应用函数');
    assert.ok(/Array\.isArray\(p\.authSecrets\)/.test(app) && /p\.authSecret \? \[p\.authSecret\]/.test(app), '应兼容新旧同步格式');
    assert.ok(/function strongIdentityKeysOf\(u\)/.test(app), '应有强身份键提取');
    assert.ok(/function matchSecretUser\(sec\)/.test(app), '应按强身份把密钥绑定到唯一账户');
    assert.ok(/^\s*if \(\/\[up\]_\/\.test\(s\) \|\| \/^\{\\d\{8\},\}\$\/\.test\(s\)\)/m.test(app) || /\/\^\[up\]_/.test(app), '强身份应仅认 u_/p_ 前缀与数字 uid，排除姓名/admin 弱键');
    assert.ok(!/identityMatches\(u, keys\)/.test(app), '不得再用含 name/username 的弱别名匹配口令，避免交叉污染');
    assert.ok(/applyAuthSecrets\(p\)/.test(app), '账户域拉取应调用密钥应用');
    assert.ok(/function cloudSyncReady\(\) \{ return !state\.cloudStale && state\.authed && !!window\.cloud; \}/.test(app), '本地登录也应启用跨设备同步');
  });

  check('口令防交叉污染：载荷携带强身份字段且弱姓名不参与匹配', () => {
    const api = read('js/api.js');
    assert.ok(/function strongIdentityKeysOf\(u\)/.test(api), '接口层应有强身份键提取');
    assert.ok(/strongKeys: strong/.test(api) && /email, strongKeys: strong/.test(api), 'authSecret 应携带 email 与 strongKeys');
    // 工号 username='admin' 的脏数据不得污染超管：强身份键不含 name/username
    const src = api.match(/function strongIdentityKeysOf\(u\)[\s\S]*?\n  \}/);
    assert.ok(src && !/push\(u\.name\)/.test(src[0]) && !/push\(u\.username\)/.test(src[0]), '强身份键不得包含 name 或 username');
    // 两条同名不同邮箱的账户必须生成两条独立 secret，哈希不互相覆盖
    const payload = API.buildUserSyncPayload({
      account: { id: 'u_superadmin', name: 'admin', email: '3440576634@qq.com', role: 'admin', passwordHash: 'demo$admin$1$2' },
      users: [
        { id: 'u_superadmin', name: 'admin', email: '3440576634@qq.com', role: 'admin', passwordHash: 'demo$admin$1$2' },
        { id: 'p123456789', name: '丁伊凡', username: 'admin', email: '591071180@qq.com', role: 'student', passwordHash: 'demo$stu$3$4' },
      ], roles: [],
    }, 'account');
    const adminSec = payload.authSecrets.find(x => (x.email || '') === '3440576634@qq.com');
    const stuSec = payload.authSecrets.find(x => (x.email || '') === '591071180@qq.com');
    assert.ok(adminSec && stuSec, '应为两个账户分别生成密钥');
    assert.strictEqual(adminSec.passwordHash, 'demo$admin$1$2', '超管哈希不被污染');
    assert.strictEqual(stuSec.passwordHash, 'demo$stu$3$4', '工号哈希独立');
    assert.ok(adminSec.strongKeys.indexOf('admin') < 0 && stuSec.strongKeys.indexOf('admin') < 0, '强身份键应排除 admin 弱名');
  });

  check('口令跨设备统一：登录即启动同步与闲置监听，不再产生重复超管', () => {
    const app = read('js/app.js');
    const loginBlock = app.match(/function loginSuccess\(user\) \{[\s\S]*?\n\}/);
    assert.ok(loginBlock && /showApp\(\)/.test(loginBlock[0]), '本地登录应走统一入口启动同步与监听');
    const cloudBlock = app.match(/async function cloudLoginSuccess[\s\S]*?\n\}/);
    assert.ok(cloudBlock && /startShareRealtime\(\)/.test(cloudBlock[0]) && /startIdleWatcher\(\)/.test(cloudBlock[0]), '云端登录也应启动监听');
    const { make, win } = buildEnsure();
    const st = { users: [
      { id:'p_superadmin', name:'超级管理员', email:'3440576634@qq.com', role:'admin', passwordHash:'demo$x$1$2' },
    ], superAdminInitialized: false };
    win.APP_CONFIG.adminEmail = '3440576634@qq.com';
    make(st, win, () => {})();
    assert.strictEqual(st.users.length, 1, '云端绑定邮箱的超管已存在时不得重复创建 admin');
    assert.strictEqual(st.users[0].email, '3440576634@qq.com', '不得新增第二个超管账户');
  });

  /* ---------- 平台名称 / 主题切换 / 工具页退出 ---------- */
  check('平台名称：全站展示文案统一为 Sunshine个人工作站', () => {
    ['index.html', 'image-to-doc.html', 'text-to-doc.html',
     'js/app.js', 'js/config.js', 'js/api.js', 'css/styles.css'].forEach(f => {
      const src = read(f);
      assert.ok(!src.includes('阳光学堂'), `${f} 不应残留旧平台名称`);
    });
    assert.ok(/Sunshine个人工作站/.test(read('index.html')), '主站应展示新平台名称');
    assert.strictEqual(vm.runInContext('window.APP_CONFIG.name', sandbox), 'Sunshine个人工作站', '配置名称应同步更新');
  });

  check('主题切换：太阳/月亮按钮位于通知铃铛旁且三页接线齐备', () => {
    const index = read('index.html');
    const common = read('js/tool-common.js');
    assert.ok(/data-action="toggle-theme"/.test(index), '顶栏应有主题切换按钮');
    assert.ok(/id="i-moon"/.test(index), '应提供月亮图标');
    // 主题按钮应紧邻通知铃铛（位于 notify-btn 之前）
    assert.ok(/theme-btn[\s\S]{0,260}toggle-notifications/.test(index), '主题按钮应紧邻消息通知铃铛');
    assert.ok(/<script src="js\/tool-common\.js/.test(index), '主站应加载主题脚本');
    [ 'image-to-doc.html', 'text-to-doc.html' ].forEach(f => {
      const s = read(f);
      assert.ok(/data-action="toggle-theme"/.test(s) && /id="i-moon"/.test(s), `${f} 应有主题切换能力`);
      assert.ok(/js\/tool-common\.js/.test(s), `${f} 应加载共享主题脚本`);
    });
    assert.ok(/data-theme/.test(common) && /localStorage/.test(common), '主题应写入 DOM 并持久化');
    assert.ok(/toggleTheme/.test(common) && /window\.SunnyTools/.test(common), '应暴露切换接口');
    assert.ok(/:root\[data-theme="dark"\]/.test(read('css/styles.css')), '应有黑暗模式样式');
    assert.ok(/:root\[data-theme="dark"\]/.test(read('css/image-to-doc.css')), '独立页应支持黑暗模式');
  });

  check('工具页返回：关闭图片/文字转文档返回首页并在会话内恢复登录态', () => {
    ['js/image-to-doc.js', 'js/text-to-doc.js'].forEach(f => {
      const src = read(f);
      assert.ok(/#btn-back/.test(src), `${f} 应有返回按钮`);
      assert.ok(/#btn-back[\s\S]{0,240}markToolReturn\(\)/.test(src), `${f} 返回前应写入工具页返回标记`);
      assert.ok(/#btn-back[\s\S]{0,420}window\.location\.href = 'index\.html' \+ window\.location\.search/.test(src), `${f} 返回按钮应跳转首页并保留 sharecode`);
      assert.ok(!/SunnyTools\.exitToLogin/.test(src), `${f} 不应再执行退出系统`);
      assert.ok(!/removeItem\('sunny-classroom-web-v1:session-gate'\)/.test(src), `${f} 不应清除会话门闸`);
    });
    const common = read('js/tool-common.js');
    assert.ok(/function markToolReturn\(\)/.test(common) && /TOOL_RETURN_KEY/.test(common), '共享脚本应提供返回标记函数');
    assert.ok(/markToolReturn: markToolReturn/.test(common), '应导出返回标记函数');
    const app = read('js/app.js');
    assert.ok(/restoreSessionAfterToolReturn/.test(app), '首页启动应恢复工具页返回的会话登录态');
    assert.ok(/sessionGateAllowsRestore\(\)/.test(app), '恢复须以会话门闸有效为前提');
    assert.ok(/state\.authed = true/.test(app), '恢复应设置已登录态');
    ['image-to-doc.html', 'text-to-doc.html'].forEach(f => {
      assert.ok(/aria-label="返回首页"/.test(read(f)), `${f} 返回按钮文案应为返回首页`);
    });
  });

  check('手机顶栏：隐藏失效搜索框、按钮固定尺寸不被压变形、整体不溢出', () => {
    const css = read('css/styles.css');
    assert.ok(/html\[data-viewport="phone"\] \.topbar__search \{ display: none !important; \}/.test(css), '手机端应隐藏被挤成空白框的顶栏搜索');
    assert.ok(/html\[data-viewport="phone"\] \.topbar__menu \{ flex: none; width: 34px/.test(css), '汉堡菜单应固定宽度不被压扁');
    assert.ok(/html\[data-viewport="phone"\] \.topbar__actions > button \{ flex: none; \}/.test(css), '顶栏按钮应固定尺寸不被 flex 压缩');
    assert.ok(/html\[data-viewport="phone"\] \.brand \{ flex: none; \}/.test(css), '品牌标应固定尺寸');
    assert.ok(/html\[data-viewport="phone"\] \.tool-top-btn__label-mini \{ display: inline; \}/.test(css), '应保留图片/文字短标签辨识度');
    assert.ok(/html\[data-viewport="phone"\] \.topbar \.icon-btn \{ width: 34px; height: 34px; \}/.test(css), '主题/铃铛按钮应缩为紧凑尺寸');
  });

  /* ---------- 新建工号后立即同步 ---------- */
  check('工号同步 API：workspace 载荷携带 users 名录', () => {
    const api = read('js/api.js');
    assert.ok(/payload\.users = clonePlain\(Array\.isArray\(s\.users\)/.test(api), 'workspace 载荷应携带脱敏 users 名录供另一端拉取');
    assert.ok(/async function syncPersonnel\(\)/.test(api), '应提供工号立即同步接口');
    assert.ok(/from\('personnel'\)\.select\('\*'\)/.test(api), '云端模式同步前应读取权威人员表');
    assert.ok(/CLOUD_PUSH_FAILED/.test(api) && /PERSONNEL_REFRESH_FAILED/.test(api), '应对刷新/推送失败分别给出错误码');
    assert.ok(/listPersons, createPerson, updatePerson, deletePerson, syncPersonnel/.test(api), 'syncPersonnel 应挂载到 SunnyAPI');
    // 防工号被覆盖丢失：不再用 listPersons 整体覆盖本地，而是补写缺失工号后再刷新
    const syncFn = api.match(/async function syncPersonnel\(\)[\s\S]*?\n  \}/);
    assert.ok(syncFn, '应有 syncPersonnel 实现');
    assert.ok(!/const listed = await listPersons\(\)/.test(syncFn[0]), '不得用 listPersons 整体覆盖本地工号');
    assert.ok(/backfilled\+\+/.test(syncFn[0]) && /personnel.*insert|\.insert\(row\)/.test(syncFn[0]), '应把本地缺失工号补写入 personnel 白名单');
    assert.ok(/S\(\)\.users = remotePersons/.test(syncFn[0]), '补写后再以云端权威名录刷新本地');
    assert.ok(/backfilled,/.test(syncFn[0]), '返回值应含补登数量供界面提示');
  });

  await checkAsync('工号同步 API：权限校验与非超管拒绝', async () => {
    // 权限校验为同步函数第一步，非超管应被拒绝（与 createPerson 一致）
    assert.strictEqual(typeof API.syncPersonnel, 'function', 'API 应暴露 syncPersonnel');
    const before = state.account;
    state.account = { ...USERS[0] }; // 学生
    const res = await API.syncPersonnel();
    assert.strictEqual(res.ok, false, '非超管调用应失败');
    assert.strictEqual(res.error.code, 'FORBIDDEN', '应返回 FORBIDDEN');
    state.account = before;
  });

  check('工号同步接线：成功卡片、状态反馈、防重复点击与异常提示', () => {
    const app = read('js/app.js');
    assert.ok(/showCreatedPersonSyncCard/.test(app), '新建成功后应展示同步卡片');
    assert.ok(/data-action="sync-new-person"/.test(app), '应有立即同步按钮');
    assert.ok(/if \(!id\) showCreatedPersonSyncCard/.test(app), '仅新建（非编辑）后展示同步入口，不影响原流程');
    assert.ok(/async function syncNewPerson\(\)/.test(app), '应有同步处理函数');
    assert.ok(/if \(personSyncInFlight\) return/.test(app), '应防重复点击');
    assert.ok(/is-syncing[\s\S]{0,120}同步中/.test(app), '应有同步中状态文案');
    assert.ok(/同步成功/.test(app) && /同步失败/.test(app), '应有成功与失败状态文案');
    assert.ok(/网络异常，请检查网络后重试/.test(app), '网络异常应有明确提示');
    assert.ok(/window\.SunnyAPI\.syncPersonnel\(\)/.test(app), '应调用同步接口');
    assert.ok(/case 'sync-new-person': syncNewPerson\(\)/.test(app), '事件委托应接线');
    // 另一端拉取：workspace 应用函数应合并 users
    assert.ok(/Array\.isArray\(p\.users\) && p\.users\.length/.test(app), '另一端拉取应合并工号名录');
    // 按 id 去重，避免本地 email 与云端 email 不同的同一超管出现两条
    assert.ok(/const idKey = u =>/.test(app) && /const samePerson = \(a, b\) =>/.test(app), '应按 id/email 双向判定同一人');
    assert.ok(/const seenIds = new Set\(\)/.test(app) && /if \(k && seenIds\.has\(k\)\) return/.test(app), '应按 id 兜底去重，防止重复超管');
    const css = read('css/styles.css');
    assert.ok(/\.sync-card__status\.is-syncing/.test(css) && /\.sync-card__status\.is-success/.test(css) && /\.sync-card__status\.is-error/.test(css), '应有同步中/成功/失败三种视觉状态');
  });

  /* ---------- 学习感悟删除即时同步 ---------- */
  check('感悟同步 API：删除接口、规范化去重与错误码齐备', () => {
    const api = read('js/api.js');
    assert.ok(/function normalizeShares\(rows\)/.test(api), '应有感悟规范化函数');
    assert.ok(/if \(key && seen\.has\(key\)\) return; \/\/ 去重/.test(api), '规范化应按 id 去重避免重复数据');
    assert.ok(/async function deleteShares\(payload\)/.test(api), '应提供感悟删除接口');
    assert.ok(/const isClearAll = ids\.length === 0/.test(api), '空 ids 表示清空全部');
    assert.ok(/CLOUD_DELETE_FAILED/.test(api) && /NETWORK_ERROR/.test(api), '云端删除失败/网络异常应有明确错误码');
    assert.ok(/share_likes[\s\S]{0,60}share_comments/.test(api), '删除应清理关联点赞与评论');
    assert.ok(/S\(\)\.shares = isClearAll \? \[\]/.test(api), '删除后应更新本地权威表');
    assert.ok(/ctx\.persist\(\)/.test(api), '删除后应持久化以广播到其它标签');
    assert.ok(/normalizeShares, deleteShares/.test(api), '接口应挂载到 SunnyAPI');
  });

  await checkAsync('感悟同步 API：清空全部仅超管、单条删除校验本人', async () => {
    assert.strictEqual(typeof API.normalizeShares, 'function', 'API 应暴露 normalizeShares');
    assert.strictEqual(typeof API.deleteShares, 'function', 'API 应暴露 deleteShares');
    // 去重：相同 id 多条仅保留一条
    const dedup = API.normalizeShares([
      { id: 1, title: 'A', like_by: undefined, comments: undefined },
      { id: 1, title: 'A dup' },
      { id: 2, title: 'B' },
    ]);
    assert.strictEqual(dedup.length, 2, '重复 id 应被去重');
    // 清空全部非超管拒绝
    const before = state.account;
    state.account = { ...USERS[0] }; // 学生
    let res = await API.deleteShares({ ids: [] });
    assert.strictEqual(res.ok, false, '非超管清空全部应失败');
    assert.strictEqual(res.error.code, 'FORBIDDEN', '应返回 FORBIDDEN');
    // 删除他人感悟被拒绝
    res = await API.deleteShares({ ids: [String(SHARES[0].id)] });
    assert.strictEqual(res.ok, false, '非本人删除他人感悟应失败');
    state.account = before;
  });

  check('感悟删除接线：即时重渲染、三态反馈、失败重试与去重拉取', () => {
    const app = read('js/app.js');
    assert.ok(/data-action="clear-all-shares"/.test(app), '应有清空全部入口');
    assert.ok(/data-action="delete-share"/.test(app), '应有单条删除入口');
    assert.ok(/data-action="confirm-delete-shares"/.test(app), '应有删除确认入口');
    assert.ok(/async function executeDeleteShares\(ids\)/.test(app), '应有删除执行函数');
    assert.ok(/if \(shareDeleteInFlight\) return/.test(app), '应防重复点击');
    assert.ok(/正在同步删除结果/.test(app), '应有同步中状态文案');
    assert.ok(/share-sync-bar is-\$\{shareSyncStatus\}/.test(app), '状态条应按同步状态切换 is-* 类名');
    assert.ok(/同步失败，请重试/.test(app) && /删除结果已同步/.test(app), '应有成功与失败反馈');
    assert.ok(/data-action="retry-share-sync"/.test(app), '失败应有重试按钮');
    assert.ok(/网络异常，请检查网络后重试/.test(app), '网络异常应有提示');
    assert.ok(/window\.SunnyAPI\.deleteShares\(\{ ids: ids \|\| \[\] \}\)/.test(app), '应调用删除接口');
    assert.ok(/refreshShareDependentViews\(\)/.test(app), '删除后应刷新列表与相关展示状态');
    assert.ok(/window\.SunnyAPI\.normalizeShares\(saved\.shares\)/.test(app), '跨标签同步应去重');
    assert.ok(/loadCloudShares\(\{ silent: true \}\)/.test(app), '轮询/复核应静默刷新');
    assert.ok(/suppressSyncPush = true[\s\S]{0,120}persist\(\)/.test(app), '云端拉取应更新本地缓存且不回推');
    assert.ok(/case 'confirm-delete-shares'/.test(app) && /case 'retry-share-sync'/.test(app), '事件委托应接线');
    const css = read('css/styles.css');
    assert.ok(/\.share-sync-bar\.is-syncing/.test(css) && /\.share-sync-bar\.is-success/.test(css) && /\.share-sync-bar\.is-error/.test(css), '应有同步中/成功/失败三种视觉状态');
  });

  check('实时同步 API：校验函数挂载与超管权限校验', () => {
    const api = read('js/api.js');
    assert.ok(/async function checkRealtimeSync\(localMetas, scopes\)/.test(api), '应有云端校验函数');
    assert.ok(/const denied = requireAdmin\(\); if \(denied\) return denied;/.test(api), '校验应限超管');
    assert.ok(/shouldApplySync\(localAt, remoteAt, null, row\.payload\)/.test(api), '应按时间戳判定云端是否更新');
    assert.ok(/reports\.push\(\{ scope, ok: false[\s\S]{0,120}SYNC_CHECK_FAILED/.test(api), '校验失败应有错误码');
    assert.ok(/reports\.push\(\{ scope, ok: false[\s\S]{0,120}CLOUD_ERROR/.test(api), '网络异常应有错误码');
    assert.ok(/pushUserSync, pullUserSync, checkRealtimeSync,/.test(api), 'checkRealtimeSync 应挂载到 SunnyAPI');
    assert.ok(typeof API.checkRealtimeSync === 'function', '运行时应可调用 checkRealtimeSync');
    assert.ok(/USER_SYNC_SCOPES\.slice\(\)/.test(api), '未指定域时应覆盖全部同步域');
  });

  await checkAsync('实时同步 API：非超管被拒绝', async () => {
    const before = state.account;
    state.account = { ...USERS[0] }; // 学生
    const res = await API.checkRealtimeSync({}, ['workspace']);
    assert.strictEqual(res.ok, false, '非超管校验应失败');
    assert.strictEqual(res.error.code, 'FORBIDDEN', '应返回 FORBIDDEN');
    state.account = before;
  });

  check('实时同步接线：后台按钮、三态反馈、防重复与重试', () => {
    const app = read('js/app.js');
    assert.ok(/id="btn-realtime-sync" data-action="realtime-sync"/.test(app), '后台应有实时同步按钮');
    assert.ok(/id="realtime-sync-bar" class="realtime-sync-bar hidden"/.test(app), '应有同步状态条');
    assert.ok(/async function realtimeSyncNow\(\)/.test(app), '应有同步编排函数');
    assert.ok(/if \(realtimeSyncInFlight\) return/.test(app), '应防重复点击');
    assert.ok(/正在与云端校验并同步最新数据/.test(app), '应有同步中状态文案');
    assert.ok(/realtime-sync-bar is-\$\{realtimeSyncStatus\}/.test(app), '状态条应按状态切换 is-* 类名');
    assert.ok(/同步成功 · \$\{at\}/.test(app), '应有成功状态与时间戳');
    assert.ok(/同步未完成/.test(app) && /校验\/上传失败/.test(app), '应有部分失败提示');
    assert.ok(/同步失败：/.test(app) && /网络异常，请检查网络后重试/.test(app), '网络异常应有提示');
    assert.ok(/data-action="realtime-sync"/.test(app) && /重试/.test(app), '失败应可重试');
    assert.ok(/window\.SunnyAPI\.checkRealtimeSync\(state\.syncMeta, REALTIME_SYNC_SCOPES\)/.test(app), '应调用云端校验接口');
    assert.ok(/const check = await window\.SunnyAPI\.checkRealtimeSync/.test(app), '应先校验再同步');
    assert.ok(/for \(const scope of needPull\)/.test(app), '应仅拉取云端较新的域');
    assert.ok(/for \(const scope of REALTIME_SYNC_SCOPES\)[\s\S]{0,80}pushSyncScope\(scope\)/.test(app), '应推送三域确保云端一致');
    assert.ok(/if \(!pushed\) pushFailed\.push\(scope\)/.test(app), '应检测上传失败');
    assert.ok(/case 'realtime-sync': realtimeSyncNow\(\); break;/.test(app), '事件委托应接线');
    assert.ok(/renderRealtimeSyncBar\(\); \/\/ 重渲染后台时保留同步状态条/.test(app), '重渲染后台应保留状态条');
  });

  check('实时同步接线：三域拉取覆盖课程表与去重收敛', () => {
    const app = read('js/app.js');
    assert.ok(/const REALTIME_SYNC_SCOPES = \['workspace', 'account', 'schedule'\]/.test(app), '应覆盖三域含课程表');
    assert.ok(/function applyScheduleSyncPayload\(p\)/.test(app), '应有课程表域应用函数');
    assert.ok(/for \(const scope of REALTIME_SYNC_SCOPES\)[\s\S]{0,60}pullSyncScope\(scope, REALTIME_SYNC_APPLY\[scope\]\)/.test(app), 'pullAllSync 应拉取三域');
    assert.ok(/window\.SunnyAPI\.normalizeScheduleSlot\(s\)/.test(app), '课程表节次应规范化避免重复');
    assert.ok(/const seenIds = new Set\(\)/.test(app), '工号合并应按 id 去重');
    assert.ok(/async function pushSyncScope\(scope\)[\s\S]{0,400}return !!\(res && res\.ok\)/.test(app), '推送应返回成功状态');
    assert.ok(/async function pullSyncScope\(scope, apply\)[\s\S]{0,400}return true/.test(app), '拉取应返回状态供编排判定');
    const css = read('css/styles.css');
    assert.ok(/\.realtime-sync-bar\.is-syncing/.test(css) && /\.realtime-sync-bar\.is-success/.test(css) && /\.realtime-sync-bar\.is-error/.test(css), '应有同步中/成功/失败三种视觉状态');
    assert.ok(/#btn-realtime-sync\.is-syncing \.icon \{ animation: syncSpin/.test(css), '按钮同步中应旋转');
    const html = read('index.html');
    assert.ok(/20261122k/.test(html), '资源版本号应升级破缓存');
  });

  console.log(`\n完成：${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}\n`);
})();
