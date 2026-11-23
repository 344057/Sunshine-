/* Sunshine个人工作站 — 主题切换与工具页通用逻辑
   主站与独立工具页共用：主题偏好持久化到 localStorage，退出工具页时清除登录态回到登录页。 */
(function () {
  'use strict';
  var DEFAULT_STORE_KEY = 'sunny-classroom-web-v1';
  var storeKey = (window.APP_CONFIG && window.APP_CONFIG.storageKey) || DEFAULT_STORE_KEY;
  var THEME_KEY = storeKey + ':theme';
  var GATE_KEY = storeKey + ':session-gate';
  var TOOL_RETURN_KEY = storeKey + ':tool-return';

  function readTheme() {
    try { return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }

  function applyTheme(theme) {
    var isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#1B1917' : '#F2653A');
    // 按钮图标语义：浅色模式显示月亮（点击切到黑暗）；黑暗模式显示太阳（点击切回浅色）
    var label = isDark ? '切换到浅色模式' : '切换到黑暗模式';
    var iconId = isDark ? '#i-sun' : '#i-moon';
    var btns = document.querySelectorAll('[data-action="toggle-theme"]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      var use = btn.querySelector('use');
      if (use) use.setAttribute('href', iconId);
    }
  }

  function toggleTheme() {
    var next = readTheme() === 'dark' ? 'light' : 'dark';
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
    return next;
  }

  // 从工具页关闭返回首页：写入会话内标记。首页启动时据此在浏览器会话内恢复登录态，
  // 使用户从首页进入工具页、再关闭返回时，仍停留在登录后的操作首页（不重复登录）。
  // 标记存 sessionStorage，关闭浏览器即失效；首页读取后立即清除，不影响普通刷新行为。
  function markToolReturn() {
    try { window.sessionStorage.setItem(TOOL_RETURN_KEY, '1'); } catch (e) {}
  }

  // 保留：主动退出系统时清除本系统全部登录态（当前工具页关闭已改为返回首页，不再调用）。
  function exitToLogin() {
    try { window.sessionStorage.removeItem(GATE_KEY); } catch (e) {}
    try {
      var raw = window.localStorage.getItem(storeKey);
      if (raw) {
        var data = JSON.parse(raw);
        data.authed = false;
        data.remember = false;
        data.sessions = [];
        data.activeSessionId = null;
        data.cloudAuthKey = null;
        window.localStorage.setItem(storeKey, JSON.stringify(data));
      }
    } catch (e) {}
    // 仅清理本系统写入的 sessionStorage 键，避免影响同一来源的其它功能
    try {
      var keys = [];
      for (var i = 0; i < window.sessionStorage.length; i++) {
        var k = window.sessionStorage.key(i);
        if (k && k.indexOf(storeKey) === 0) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) window.sessionStorage.removeItem(keys[j]);
    } catch (e) {}
    var search = window.location.search || '';
    window.location.href = 'index.html' + search;
  }

  applyTheme(readTheme());

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('[data-action="toggle-theme"]');
    if (!btn) return;
    e.preventDefault();
    toggleTheme();
  });

  window.SunnyTools = {
    themeKey: THEME_KEY,
    getTheme: readTheme,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    markToolReturn: markToolReturn,
    toolReturnKey: TOOL_RETURN_KEY,
    exitToLogin: exitToLogin
  };
})();
