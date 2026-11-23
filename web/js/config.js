/* Sunshine个人工作站 Web 本地部署配置 */
window.APP_CONFIG = {
  name: 'Sunshine个人工作站',
  mode: 'local-demo',
  storageKey: 'sunny-classroom-web-v1',
  defaultPort: 5173,
  // 演示口令默认值与策略（仅用于本地演示，非生产级安全）
  auth: {
    // 初始口令唯一来源：内置账户与超级管理员共用同一初始值，避免两端/两处配置漂移。
    // 修改此处即同时更新电脑端与手机端首次初始化的超管初始密码。
    defaultPassword: '123456', // 内置/快捷创建账户的初始口令（超管默认口令同源）
    minLength: 6,              // 口令最小长度
    // 邮箱验证策略：true=未验证账户首次登录必须完成绑定验证（验证状态持久化后不再重复）；
    // false=不强制验证向导，新建账户凭管理员分配的口令即可直接使用。
    emailVerifyOnce: true,
    // 会话有效期（天）：有效期内新标签页/新链接自动恢复登录，无需重复登录
    sessionTtlDays: 7,
    // 闲置超时（分钟）：同一浏览器无人操作超过该时长进入二次验证，仅需当前账户密码即可继续
    idleTimeoutMinutes: 60,
    // 学习感悟实时同步轮询间隔（秒）
    shareSyncSeconds: 12,
    // 系统不开放自助注册：所有账户由超级管理员在人员管理中创建
    allowSelfRegistration: false,
    // 超级管理员初始化默认值（配置入口）
    // 仅首次初始化 / 未显式配置时生效；一旦已初始化或已存在同名账号，绝不覆盖已有账号。
    // 修改这里可自定义默认用户名与初始密码；对已初始化的账号无效（保护既有凭据）。
    superAdmin: {
      // 默认登录用户名（可用用户名或带 @ 的邮箱，留空回退 admin）
      username: 'admin',
      // 默认初始密码（留空回退到 auth.defaultPassword，二者同源；默认均为 123456）
      password: '123456',
      // 显示名称 / 头像首字来源（留空回退「超级管理员」）
      displayName: '超级管理员',
    },
    // 账户清理：仅保留 admin 账户，删除其余账户及其关联数据。
    // 必须先在后台预览影响范围，再输入下方短语完成第二次确认。
    accountCleanup: {
      confirmPhrase: '仅保留ADMIN',
      // 受保护账户的识别优先级：云端绑定邮箱 → 默认用户名 → 当前登录超管。
      protectedEmail: '3440576634@qq.com',
      protectedUsername: 'admin',
    },
  },
  // 云端超级管理员绑定邮箱：该邮箱通过邮箱验证码登录时自动获得超管权限。
  // 与云端 profiles 表的提权触发器保持一致；如需变更，必须同时更新触发器。
  adminEmail: '3440576634@qq.com',
  // 登录与凭据处理策略（电脑端 / 手机端统一使用同一份配置）
  authUi: {
    // 是否显示"记住密码"选项（与"记住登录状态"并列展示）
    showRememberPassword: true,
    // "记住密码"默认勾选状态
    rememberPasswordDefault: false,
    // 记住的凭据保存在此 localStorage 键（跨浏览器重开后回填账号/密码）
    credentialKey: 'sunny-classroom-login-credential',
    // "记住登录状态"默认勾选状态：false=默认不勾选，由用户手动选择。
    // 未勾选时登录态只保留在内存中（刷新/重开页面都回到登录页），不写入本地会话快照。
    rememberLoginDefault: false,
    // 登录态保存策略：session=仅本次浏览器会话（刷新不掉、关闭浏览器后需重新登录）
    // 说明：为满足"关闭并重新打开浏览器必须重新登录"，当前固定使用 session。
    loginStateScope: 'session',
  },
  // 内置权限项与默认视图门禁：供接口层做"内置不可删 / 门禁回退"判定。
  // 与 data.js 的 BUILTIN_PERMISSIONS / DEFAULT_VIEW_PERMISSIONS 保持一致。
  builtinPermissions: [
    { key:'view_material', name:'查看学习资料', desc:'浏览与搜索资料库', builtin:true },
    { key:'download',      name:'下载资料',     desc:'下载课件与练习册', builtin:true },
    { key:'publish',       name:'发布资料',     desc:'上传并发布新资料', builtin:true },
    { key:'message',       name:'内部消息',     desc:'发送与查看站内消息', builtin:true },
    { key:'publish_notice',name:'发布消息通知', desc:'向全体成员发布广播通知', builtin:true },
    { key:'manage_user',   name:'用户管理',     desc:'创建与管理用户账户', builtin:true },
    { key:'manage_role',   name:'角色权限',     desc:'自定义角色与权限', builtin:true },
    { key:'view_stats',    name:'数据看板',     desc:'查看平台统计数据', builtin:true },
    { key:'manage_schedule',name:'课程表管理',  desc:'配置班级课程表与任课教师', builtin:true },
    { key:'use_morning_radio', name:'早安电台', desc:'生成早安主题海报与短视频（含实时天气与语音播报）', builtin:true },
  ],
  defaultViewPerms: { library:'view_material', shares:'message', directory:'message', notices:'publish_notice', schedule:'view_material', 'morning-radio':'use_morning_radio' },
};
