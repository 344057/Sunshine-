/* ==========================================================================
   Sunshine个人工作站 — 云服务公开配置
   说明：以下值由 WorkBuddy 云平台分配，可安全写入前端源码。
   - endpoint / publishableKey 用于初始化唯一的云客户端，每个模块复用它。
   - oauthRelayBaseUrl 用于 WorkBuddy 账号登录；本项目使用邮箱验证码登录，
     但仍按规范透传，便于后续扩展授权登录。
   - 底层环境 ID、provider 密钥等敏感信息不会下发到前端。
   ========================================================================== */
window.CLOUD_CONFIG = {
  endpoint: 'https://sunny-classroom-93077.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_siozdCIHUHKzVnUS2me8hs_q6o81fj5m8PnPPG3oM6l6shvvjKVHC4f',
};

/* 唯一云客户端：Auth / Database 共用同一个实例。
   SDK 优先从本地 vendor/ 加载（随站点发布，国内访问稳定），失败时回退 CDN。
   window.cloudReady() 返回一个 Promise，等待 SDK 就绪后给出客户端实例，
   避免脚本加载顺序或网络抖动导致“云服务未就绪”。 */
(function () {
  const cfg = window.CLOUD_CONFIG;

  function createClient() {
    if (window.cloud) return window.cloud;
    if (typeof window.WorkBuddyCloud === 'undefined' || !cfg || !cfg.endpoint) return null;
    try {
      window.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey,
      });
      console.info('[Sunshine个人工作站] 云服务初始化成功');
    } catch (e) {
      console.error('[Sunshine个人工作站] 云服务初始化失败：', e);
      return null;
    }
    return window.cloud;
  }

  createClient();

  // 等待 SDK 就绪（最多约 8 秒），供登录等交互在加载偏慢时调用。
  window.cloudReady = function (timeoutMs = 8000) {
    const immediate = createClient();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const client = createClient();
        if (client) { clearInterval(timer); resolve(client); }
        else if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          console.error('[Sunshine个人工作站] 等待云 SDK 超时');
          resolve(null);
        }
      }, 200);
    });
  };
})();
