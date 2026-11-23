/* ==========================================================================
   Sunshine个人工作站 — 早安电台（Web 版）
   把原 Python 桌面版「早安电台」的核心体验搬到浏览器：
     · Canvas 竖屏日出动画（渐变天空 + 光晕太阳 + 云海 + 文案逐层淡入）
     · Open-Meteo 实时天气（免费无 Key，30 分钟本地缓存，失败优雅降级）
     · Web Speech API 中文语音播报（替代 Windows SAPI5）
     · Web Audio 合成轻柔 BGM（替代本地音乐文件）
     · 导出 PNG 海报 / WebM 短视频（浏览器原生能力，MP4 需转码故用 WebM）
   配置持久化到 localStorage（独立键，不污染主state）。
   仅作展示与生成，不含任何联网上传；权限由主站 canView('morning-radio') 统一拦截。
   ========================================================================== */
(function () {
  'use strict';

  var STORE_KEY = ((window.APP_CONFIG && window.APP_CONFIG.storageKey) || 'sunny-classroom-web-v1') + ':morning-radio';
  var WEATHER_CACHE_KEY = STORE_KEY + ':weather';
  var W = 540, H = 960; // 内部绘制分辨率（竖屏 9:16），兼顾清晰与流畅
  var WMO = { 0:'晴',1:'多云转晴',2:'多云',3:'阴',45:'雾',48:'雾凇',
    51:'小毛雨',53:'毛雨',55:'大毛雨',56:'冻毛雨',57:'强冻毛雨',
    61:'小雨',63:'中雨',65:'大雨',66:'冻雨',67:'强冻雨',
    71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'中等阵雨',
    82:'强阵雨',85:'小阵雪',86:'大阵雪',95:'雷阵雨',96:'雷阵雨伴冰雹',99:'强雷阵雨伴冰雹' };

  /* 播报音色风格预设：通过「系统音色匹配 + 语速/音调微调」模拟不同播音风格。
     浏览器只能用系统已安装的嗓音，无法内嵌抖音等 App 的专有音色；
     预设会优先匹配名字关键词对应的嗓音，匹配不到则退化为同语言嗓音 + 参数模拟。 */
  var VOICE_STYLES = [
    { key:'default',   name:'默认 · 温柔女声',    lang:'zh-CN', rate:1.00, pitch:1.00, want:['Xiaoxiao','晓晓','Huihui','慧慧','Ting-Ting','Tingting'] },
    { key:'douyin',    name:'抖音热门 · 播音腔',  lang:'zh-CN', rate:1.10, pitch:0.90, want:['Yunxi','云希','Yunyang','云扬','Kangkang','康康'] },
    { key:'news',      name:'新闻播报 · 沉稳',    lang:'zh-CN', rate:0.98, pitch:0.94, want:['Yunxi','云希','Kangkang','康康'] },
    { key:'sweet',     name:'甜美女声 · 软萌',    lang:'zh-CN', rate:1.05, pitch:1.35, want:['Xiaoxiao','晓晓','Xiaoyi','晓伊','Yaoyao','瑶瑶'] },
    { key:'magnetic',  name:'磁性男声 · 低沉',    lang:'zh-CN', rate:0.92, pitch:0.72, want:['Yunxi','云希','Yunyang','云扬','Kangkang','康康'] },
    { key:'energetic', name:'活力少年 · 元气',    lang:'zh-CN', rate:1.16, pitch:1.16, want:['Yunxi','云希','Xiaoxiao','晓晓'] },
    { key:'healing',   name:'治愈轻声 · 助眠',    lang:'zh-CN', rate:0.85, pitch:0.94, want:['Xiaoxiao','晓晓','Xiaoyi','晓伊','Huihui','慧慧'] },
    { key:'child',     name:'童声 · 卡通',        lang:'zh-CN', rate:1.12, pitch:1.55, want:['Hanhan','涵涵','Xiaoshuang','晓双'] },
    { key:'formal',    name:'正式演讲 · 庄重',    lang:'zh-CN', rate:0.94, pitch:0.88, want:['Kangkang','康康','Yunxi','云希'] },
    { key:'tw',        name:'国语 · 台湾腔',      lang:'zh-TW', rate:1.00, pitch:1.05, want:['Sin-ji','Ting-Ting','Meijia'] },
    { key:'hk',        name:'粤语 · 广东话',      lang:'zh-HK', rate:1.00, pitch:1.00, want:['HiuGaai','Sin-ji','Dongdong'] },
    { key:'enus',      name:'英语 · 美式',        lang:'en-US', rate:1.00, pitch:1.00, want:['Aria','Jenny','Guy','Zira','Daniel'] },
    { key:'engb',      name:'英语 · 英式',        lang:'en-GB', rate:0.98, pitch:0.98, want:['Sonia','George','Ryan','Libby'] },
    { key:'ja',        name:'日语 · 标准',        lang:'ja-JP', rate:1.00, pitch:1.05, want:['Kyoko','Nanami','O-ren'] },
    { key:'ko',        name:'韩语 · 标准',        lang:'ko-KR', rate:1.00, pitch:1.00, want:['Yuna','Heami','Seoyeon'] }
  ];

  var DEFAULT = {
    title: '早安电台',
    greeting: '早安，新的一天\n愿你眼里有光，心中有爱',
    sub: '今天是元气满满的一天，记得吃早餐哦',
    displayTime: '06:01', // 留空则用当前系统时间
    duration: 8,
    bgTop: '#FFB75E', bgBottom: '#FFECB3', sunColor: '#FFF5DC', textColor: '#783C0A', accentColor: '#E6643C',
    city: '东营', latitude: 37.45, longitude: 118.48,
    weatherOn: true,
    voiceOn: false, voiceStyle: 'default', voiceURI: '', voiceRate: 1.0, voicePitch: 1.0, voiceVolume: 1.0, voiceDelay: 1.2,
    bgmOn: true, bgmVolume: 0.25
  };

  var cfg = loadCfg();
  var weather = null;
  var rafId = null, startTs = 0, running = false;
  var cvs = null, ctx = null;
  var audioCtx = null, masterGain = null, bgmTimer = null, streamDest = null;
  var recorder = null, recChunks = [], recStopTimer = null;
  var root = null;

  function loadCfg() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign({}, DEFAULT, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULT);
  }
  function saveCfg() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fade(t, at, len) { return clamp((t - at) / (len || 0.8), 0, 1); }
  function hexA(hex, a) {
    var h = String(hex || '#ffffff').replace('#','');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16); if (isNaN(n)) return 'rgba(255,255,255,'+a+')';
    return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
  }
  function wrapText(text, maxChars) {
    var out = [];
    String(text).split('\n').forEach(function (line) {
      while (line.length > maxChars) { out.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
      out.push(line);
    });
    return out;
  }
  function nowHM() {
    var d = new Date();
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  /* ---------- 天气 ---------- */
  function windDesc(kmh) {
    if (kmh < 5) return '微风';
    if (kmh < 20) return '和风';
    if (kmh < 39) return '清风拂面';
    return '风稍大，注意保暖';
  }
  function weatherShort() {
    if (!weather) return '';
    var s = weather.city + ' · ' + weather.desc + ' ' + weather.temp + '°C';
    if (weather.feels != null) s += ' · 体感 ' + weather.feels + '°C'; // 兼容旧缓存无 feels 字段
    return s + ' · ' + weather.wind;
  }
  function weatherSpeak() {
    if (!weather) return '';
    return '今天' + weather.city + weather.desc + '，气温' + weather.temp + '度，体感' + weather.feels + '度，' + weather.wind + '。';
  }
  function readWeatherCache() {
    try {
      var c = JSON.parse(window.localStorage.getItem(WEATHER_CACHE_KEY) || 'null');
      if (c && c.ts && Date.now() - c.ts < 30 * 60 * 1000 && c.data) return c.data;
    } catch (e) {}
    return null;
  }
  function writeWeatherCache(data) {
    try { window.localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
  }
  function fetchWeather(force) {
    if (!cfg.weatherOn) { weather = null; return Promise.resolve(null); }
    if (!force) {
      var cached = readWeatherCache();
      if (cached) { weather = cached; updateWeatherUI(); return Promise.resolve(cached); }
    }
    var lat = cfg.latitude, lon = cfg.longitude;
    function request(la, lo, city) {
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + la + '&longitude=' + lo +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto';
      return fetch(url).then(function (r) { if (!r.ok) throw new Error('net'); return r.json(); }).then(function (d) {
        var cur = d && d.current; if (!cur) throw new Error('data');
        var info = {
          city: city || cfg.city || '当前位置',
          desc: WMO[Math.round(cur.weather_code)] || '多云',
          temp: Math.round(cur.temperature_2m),
          feels: Math.round(cur.apparent_temperature),
          humidity: Math.round(cur.relative_humidity_2m),
          wind: windDesc(cur.wind_speed_10m)
        };
        weather = info; writeWeatherCache(info); updateWeatherUI();
        return info;
      });
    }
    var p;
    if (lat != null && lon != null && lat !== '' && lon !== '') {
      p = request(lat, lon, cfg.city);
    } else if (cfg.city && cfg.city.trim()) {
      var q = encodeURIComponent(cfg.city.trim());
      p = fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + q + '&count=1&language=zh')
        .then(function (r) { return r.json(); })
        .then(function (g) {
          var r0 = g && g.results && g.results[0];
          if (r0) return request(r0.latitude, r0.longitude, cfg.city);
          throw new Error('geocode');
        });
    } else {
      p = Promise.reject(new Error('no-loc'));
    }
    return p.catch(function () { weather = readWeatherCache(); updateWeatherUI(); return weather || null; });
  }

  /* ---------- 绘制 ---------- */
  function drawClouds(t) {
    var layers = [
      { y: 0.80, amp: 14, sp: 0.25, col: 'rgba(255,255,255,0.30)', h: 120 },
      { y: 0.88, amp: 18, sp: 0.18, col: 'rgba(255,248,232,0.55)', h: 130 },
      { y: 0.95, amp: 12, sp: 0.34, col: 'rgba(255,240,214,0.85)', h: 120 }
    ];
    layers.forEach(function (L) {
      ctx.fillStyle = L.col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (var x = 0; x <= W; x += 8) {
        var y = H * L.y + Math.sin(x / 70 + t * L.sp) * L.amp + Math.sin(x / 33 - t * L.sp * 0.7) * (L.amp / 2);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    });
  }
  function drawFrame(t) {
    if (!ctx) return;
    // 天空
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, cfg.bgTop); g.addColorStop(1, cfg.bgBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 太阳 + 光晕（起伏）
    var cx = W / 2, cy = H * 0.33 + Math.sin(t * 0.6) * 16, R = W * 0.115;
    var glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 3.4);
    glow.addColorStop(0, hexA(cfg.sunColor, 0.85));
    glow.addColorStop(0.5, hexA(cfg.sunColor, 0.28));
    glow.addColorStop(1, hexA(cfg.sunColor, 0));
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = cfg.sunColor; ctx.fill();
    // 云海
    drawClouds(t);
    // 文案逐层淡入
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var font = "'PingFang SC','Microsoft YaHei','Hiragino Sans GB',sans-serif";
    // 标题
    ctx.globalAlpha = fade(t, 0.15);
    ctx.fillStyle = cfg.accentColor; ctx.font = '600 ' + Math.round(W * 0.042) + 'px ' + font;
    ctx.fillText(cfg.title, W / 2, H * 0.10);
    // 时间（大）
    ctx.globalAlpha = fade(t, 0.5);
    ctx.fillStyle = cfg.textColor; ctx.font = '700 ' + Math.round(W * 0.16) + 'px ' + font;
    ctx.fillText(cfg.displayTime ? cfg.displayTime : nowHM(), W / 2, H * 0.50);
    // 主文案
    ctx.globalAlpha = fade(t, 1.0);
    ctx.fillStyle = cfg.textColor; ctx.font = '600 ' + Math.round(W * 0.062) + 'px ' + font;
    var lines = wrapText(cfg.greeting, 12), lh = Math.round(W * 0.095), gy = H * 0.62;
    lines.forEach(function (ln, i) { ctx.fillText(ln, W / 2, gy + (i - (lines.length - 1) / 2) * lh); });
    // 天气简报
    if (cfg.weatherOn) {
      ctx.globalAlpha = fade(t, 1.7);
      ctx.fillStyle = cfg.accentColor; ctx.font = '500 ' + Math.round(W * 0.037) + 'px ' + font;
      var wl = weatherShort() || (cfg.city + ' · 天气获取中…');
      ctx.fillText(wl, W / 2, H * 0.745, W * 0.94); // 限宽，长城市名+体感也不会溢出画面
    }
    // 副文案
    ctx.globalAlpha = fade(t, 2.2);
    ctx.fillStyle = hexA(cfg.textColor, 0.9); ctx.font = '400 ' + Math.round(W * 0.042) + 'px ' + font;
    wrapText(cfg.sub, 16).forEach(function (ln, i, arr) {
      ctx.fillText(ln, W / 2, H * 0.82 + i * Math.round(W * 0.065));
    });
    ctx.globalAlpha = 1;
  }
  function loop(ts) {
    if (!running) return;
    if (!startTs) startTs = ts;
    drawFrame((ts - startTs) / 1000);
    rafId = window.requestAnimationFrame(loop);
  }
  function play() {
    if (running || !cvs) return;
    running = true; startTs = 0;
    rafId = window.requestAnimationFrame(loop);
    updatePlayBtn();
  }
  function pause() {
    running = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = null; updatePlayBtn();
  }

  /* ---------- 语音 ---------- */
  function narrationText() {
    var g = String(cfg.greeting || '').replace(/\n/g, '，');
    var parts = [g];
    if (cfg.weatherOn && weather) parts.push(weatherSpeak().replace(/·/g, '，'));
    parts.push(cfg.sub || '');
    return parts.filter(Boolean).map(function (p) { return p.replace(/[。，]+$/, ''); }).join('。') + '。';
  }
  function currentStyle() {
    for (var i = 0; i < VOICE_STYLES.length; i++) if (VOICE_STYLES[i].key === cfg.voiceStyle) return VOICE_STYLES[i];
    return VOICE_STYLES[0];
  }
  // 语音表异步加载：首次 getVoices() 常为空，需监听 voiceschanged 后再填充下拉
  function allVoices() {
    try { return ('speechSynthesis' in window) ? (window.speechSynthesis.getVoices() || []) : []; } catch (e) { return []; }
  }
  // 按「精确 voiceURI → 风格关键词 → 语言前缀 → 任意嗓音」优先级选嗓音
  function pickVoice(voices, style, uri) {
    if (!voices.length) return null;
    if (uri) {
      var exact = null;
      for (var e = 0; e < voices.length; e++) if (voices[e].voiceURI === uri) { exact = voices[e]; break; }
      if (exact) return exact;
    }
    var want = style.want || [];
    for (var w = 0; w < want.length; w++) {
      var kw = String(want[w]).toLowerCase();
      for (var i = 0; i < voices.length; i++) {
        var name = String(voices[i].name || '').toLowerCase();
        var vu = String(voices[i].voiceURI || '').toLowerCase();
        if (name.indexOf(kw) >= 0 || vu.indexOf(kw) >= 0) return voices[i];
      }
    }
    var langPrefix = String(style.lang || 'zh').slice(0, 2).toLowerCase();
    for (var j = 0; j < voices.length; j++) if (String(voices[j].lang || '').toLowerCase().indexOf(langPrefix) === 0) return voices[j];
    for (var k = 0; k < voices.length; k++) if (/zh|cmn/i.test(voices[k].lang || '')) return voices[k];
    return voices[0];
  }
  function styleOptions() {
    return VOICE_STYLES.map(function (s) { return { value: s.key, label: s.name }; });
  }
  function refreshVoiceSelect() {
    if (!root) return;
    var sel = root.querySelector('[data-mr-key="voiceURI"]');
    if (!sel) return;
    var voices = allVoices();
    var cur = cfg.voiceURI;
    var html = '<option value="">自动匹配（按所选风格）</option>';
    voices.forEach(function (v) {
      html += '<option value="' + esc(v.voiceURI) + '">' + esc(v.name) + '（' + esc(v.lang) + '）</option>';
    });
    sel.innerHTML = html;
    sel.value = cur;
    var line = root.querySelector('.mr-voice-line');
    if (line) {
      var picked = pickVoice(voices, currentStyle(), cfg.voiceURI);
      line.textContent = voices.length
        ? '当前匹配：' + (picked ? picked.name + ' · ' + picked.lang : '无可用嗓音') + '（系统共 ' + voices.length + ' 种嗓音）'
        : '尚未读取到系统嗓音，点击「试听语音」时会自动加载；也可手动刷新页面。';
    }
  }
  function speak() {
    if (!cfg.voiceOn) { toastMsg('语音播报未开启，请先在设置里打开'); return; }
    if (!('speechSynthesis' in window)) { toastMsg('当前浏览器不支持语音播报'); return; }
    window.speechSynthesis.cancel();
    var style = currentStyle();
    var u = new SpeechSynthesisUtterance(narrationText());
    var voices = allVoices();
    var picked = pickVoice(voices, style, cfg.voiceURI);
    // 精确嗓音或风格关键词命中时用嗓音自带语言；否则用风格语言播报
    u.lang = picked ? (picked.lang || style.lang) : style.lang;
    u.rate = cfg.voiceRate; u.volume = cfg.voiceVolume; u.pitch = cfg.voicePitch;
    if (picked) u.voice = picked;
    u.onstart = function () { toastMsg('正在播报：' + style.name + (picked ? '（' + picked.name + '）' : '')); };
    u.onerror = function (ev) { if (ev && ev.error && ev.error !== 'interrupted' && ev.error !== 'canceled') toastMsg('播报失败：' + ev.error); };
    window.speechSynthesis.speak(u);
  }

  /* ---------- BGM（Web Audio 合成五声音阶） ---------- */
  function ensureAudio() {
    if (audioCtx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = cfg.bgmVolume;
    masterGain.connect(audioCtx.destination);
    return true;
  }
  var SCALE = [523.25, 587.33, 659.25, 783.99, 880.00, 783.99, 659.25, 587.33];
  var noteIdx = 0;
  function bgmTick() {
    if (!audioCtx || !masterGain) return;
    var now = audioCtx.currentTime;
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = SCALE[noteIdx % SCALE.length]; noteIdx++;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    o.connect(g); g.connect(masterGain);
    o.start(now); o.stop(now + 0.75);
  }
  function startBgm() {
    if (!cfg.bgmOn) return;
    if (!ensureAudio()) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (bgmTimer) return;
    bgmTick(); bgmTimer = window.setInterval(bgmTick, 620);
  }
  function stopBgm() {
    if (bgmTimer) { window.clearInterval(bgmTimer); bgmTimer = null; }
  }

  /* ---------- 导出 ---------- */
  function downloadURL(url, name) {
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function stamp() {
    var d = new Date();
    return '' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') +
      '_' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0');
  }
  function exportPNG() {
    if (!cvs) return;
    drawFrame(2.6); // 取文案全部淡入后的画面
    try { downloadURL(cvs.toDataURL('image/png'), '早安电台_' + stamp() + '.png'); toastMsg('海报已保存为 PNG'); }
    catch (e) { toastMsg('导出失败：' + e.message); }
  }
  function exportVideo(btn) {
    if (!cvs || !('MediaRecorder' in window) || !cvs.captureStream) {
      toastMsg('当前浏览器不支持视频录制，请用 Chrome / Edge 或改用导出 PNG'); return;
    }
    if (recorder && recorder.state === 'recording') { toastMsg('正在录制中…'); return; }
    pause();
    try {
      var stream = cvs.captureStream(30);
      if (cfg.bgmOn && ensureAudio()) {
        if (!streamDest) streamDest = audioCtx.createMediaStreamDestination();
        masterGain.connect(streamDest);
        stream.getAudioTracks().forEach(function (t) { stream.removeTrack(t); });
        streamDest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      }
      var types = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
      var mt = '';
      for (var i = 0; i < types.length; i++) {
        if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(types[i])) { mt = types[i]; break; }
      }
      recorder = new window.MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
      recChunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.onstop = function () {
        var blob = new Blob(recChunks, { type: (recorder.mimeType || 'video/webm') });
        var url = URL.createObjectURL(blob);
        downloadURL(url, '早安电台_' + stamp() + '.webm');
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        if (btn) { btn.disabled = false; btn.textContent = '录制短视频 (WebM)'; }
        setProgress(0); toastMsg('视频已保存（WebM 格式）');
      };
      recorder.start();
      if (btn) { btn.disabled = true; btn.textContent = '录制中…'; }
      // 从头播放动画与语音
      startTs = 0; running = true;
      rafId = window.requestAnimationFrame(loop);
      if (cfg.bgmOn) startBgm();
      if (cfg.voiceOn) window.setTimeout(speak, Math.round(cfg.voiceDelay * 1000));
      var total = Math.max(2, cfg.duration) * 1000, begun = Date.now();
      recStopTimer = window.setInterval(function () {
        setProgress((Date.now() - begun) / total);
        if (Date.now() - begun >= total) {
          window.clearInterval(recStopTimer); recStopTimer = null;
          if (recorder && recorder.state === 'recording') recorder.stop();
          stopBgm();
        }
      }, 100);
    } catch (e) {
      toastMsg('录制失败：' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '录制短视频 (WebM)'; }
    }
  }

  /* ---------- UI 更新助手 ---------- */
  function toastMsg(msg) {
    var el = root && root.querySelector('.mr-toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('is-on');
    window.clearTimeout(toastMsg._t);
    toastMsg._t = window.setTimeout(function () { el.classList.remove('is-on'); }, 2600);
  }
  function setProgress(p) {
    var bar = root && root.querySelector('.mr-progress__bar');
    if (bar) bar.style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
  }
  function updatePlayBtn() {
    var b = root && root.querySelector('[data-mr="play"]');
    if (b) b.textContent = running ? '暂停动画' : '播放动画';
  }
  function updateWeatherUI() {
    var el = root && root.querySelector('.mr-weather-line');
    if (el) el.textContent = weatherShort() || '天气暂不可用（将自动降级）';
  }

  /* ---------- 渲染 ---------- */
  function field(label, key, opts) {
    opts = opts || {};
    var val = cfg[key];
    if (opts.type === 'textarea') {
      return '<label class="mr-field"><span>' + label + '</span><textarea data-mr-key="' + key + '" rows="' + (opts.rows||2) + '">' + esc(val) + '</textarea></label>';
    }
    if (opts.type === 'color') {
      return '<label class="mr-field mr-field--color"><span>' + label + '</span><input type="color" data-mr-key="' + key + '" value="' + esc(val) + '" /></label>';
    }
    if (opts.type === 'check') {
      return '<label class="mr-check"><input type="checkbox" data-mr-key="' + key + '"' + (val ? ' checked' : '') + ' /><span>' + label + '</span></label>';
    }
    if (opts.type === 'select') {
      var optsHtml = (opts.options || []).map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(val) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('');
      return '<label class="mr-field"><span>' + label + '</span><select data-mr-key="' + key + '">' + optsHtml + '</select></label>';
    }
    var extra = opts.min != null ? ' min="' + opts.min + '"' : '';
    var step = opts.step ? ' step="' + opts.step + '"' : '';
    return '<label class="mr-field"><span>' + label + '</span><input type="' + (opts.type||'text') + '" data-mr-key="' + key + '" value="' + esc(val) + '"' + extra + step + ' /></label>';
  }

  function render(container) {
    stop();
    root = container;
    root.innerHTML =
      '<div class="mr">' +
        '  <div class="mr-head">' +
        '    <div class="mr-head__ic">☀️</div>' +
        '    <div><h2 class="mr-head__title">早安电台</h2><p class="mr-head__sub">生成早安主题竖屏海报与短视频 · 实时天气 · 中文语音播报</p></div>' +
        '  </div>' +
        '  <div class="mr-grid">' +
        '    <section class="mr-panel card">' +
        '      <h3 class="mr-sec">① 问候内容</h3>' +
        '      <div class="mr-fields">' +
                field('标题', 'title') +
                field('主文案（\\n 换行）', 'greeting', { type:'textarea', rows:3 }) +
                field('副文案', 'sub', { type:'textarea', rows:2 }) +
                field('显示时间（留空=当前时间）', 'displayTime', { placeholder:'06:01' }) +
                field('视频时长（秒）', 'duration', { type:'number', min:2, step:1 }) +
        '      </div>' +
        '      <h3 class="mr-sec">② 实时天气 <small>Open-Meteo 免费源</small></h3>' +
        '      <div class="mr-fields">' +
                field('城市名', 'city') +
                field('纬度', 'latitude', { type:'number', step:0.01 }) +
                field('经度', 'longitude', { type:'number', step:0.01 }) +
                field('显示天气', 'weatherOn', { type:'check' }) +
        '      </div>' +
        '      <p class="mr-weather-line"></p>' +
        '      <h3 class="mr-sec">③ 语音与音乐 <small>15 种音色风格</small></h3>' +
        '      <div class="mr-fields">' +
                field('开启语音播报', 'voiceOn', { type:'check' }) +
                field('音色风格（播音腔/方言/外语）', 'voiceStyle', { type:'select', options: styleOptions() }) +
                field('具体嗓音（留空自动匹配）', 'voiceURI', { type:'select', options: [{ value:'', label:'自动匹配（按所选风格）' }] }) +
                field('语速（0.5~2）', 'voiceRate', { type:'number', min:0.5, step:0.1 }) +
                field('音调（0~2，越高越尖）', 'voicePitch', { type:'number', min:0, step:0.05 }) +
                field('音量（0~1）', 'voiceVolume', { type:'number', min:0, step:0.1 }) +
                field('开启背景音乐', 'bgmOn', { type:'check' }) +
                field('背景乐音量（0~1）', 'bgmVolume', { type:'number', min:0, step:0.05 }) +
        '      </div>' +
        '      <p class="mr-voice-line"></p>' +
        '      <h3 class="mr-sec">④ 配色</h3>' +
        '      <div class="mr-colors">' +
                field('天空顶', 'bgTop', { type:'color' }) +
                field('天空底', 'bgBottom', { type:'color' }) +
                field('太阳', 'sunColor', { type:'color' }) +
                field('文字', 'textColor', { type:'color' }) +
                field('强调', 'accentColor', { type:'color' }) +
        '      </div>' +
        '      <div class="mr-actions">' +
        '        <button class="btn btn--soft" data-mr="save">保存设置</button>' +
        '        <button class="btn btn--soft" data-mr="weather">刷新天气</button>' +
        '        <button class="btn btn--soft" data-mr="speak">试听语音</button>' +
        '      </div>' +
        '    </section>' +
        '    <section class="mr-stage">' +
        '      <div class="mr-phone"><canvas class="mr-canvas" width="' + W + '" height="' + H + '"></canvas></div>' +
        '      <div class="mr-controls">' +
        '        <button class="btn btn--primary" data-mr="play">播放动画</button>' +
        '        <button class="btn btn--soft" data-mr="png">导出海报 PNG</button>' +
        '        <button class="btn btn--soft" data-mr="video">录制短视频 (WebM)</button>' +
        '      </div>' +
        '      <div class="mr-progress"><div class="mr-progress__bar"></div></div>' +
        '      <p class="mr-note">浏览器原生导出为 WebM 短视频（MP4 需额外转码）；语音为实时试听，视频内含背景音乐。</p>' +
        '      <div class="mr-toast"></div>' +
        '    </section>' +
        '  </div>' +
        '</div>';

    cvs = root.querySelector('.mr-canvas');
    ctx = cvs.getContext('2d');
    weather = readWeatherCache();
    updateWeatherUI();
    refreshVoiceSelect();
    // 系统嗓音常异步加载，首次为空时等 voiceschanged 事件回填
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.getVoices(); window.speechSynthesis.onvoiceschanged = refreshVoiceSelect; } catch (e) {}
    }
    drawFrame(2.6);
    bind();
    play();
    // 后台静默拉取最新天气
    if (cfg.weatherOn) fetchWeather(false);
  }

  function bind() {
    root.querySelectorAll('[data-mr-key]').forEach(function (el) {
      var key = el.getAttribute('data-mr-key');
      var handler = function () {
        if (el.type === 'checkbox') cfg[key] = el.checked;
        else if (el.type === 'number') cfg[key] = parseFloat(el.value);
        else cfg[key] = el.value;
        // 切换音色风格时，自动套用该风格的推荐语速/音调，并回填到输入框
        if (key === 'voiceStyle') {
          var st = currentStyle();
          cfg.voiceRate = st.rate; cfg.voicePitch = st.pitch;
          var rEl = root.querySelector('[data-mr-key="voiceRate"]'); if (rEl) rEl.value = st.rate;
          var pEl = root.querySelector('[data-mr-key="voicePitch"]'); if (pEl) pEl.value = st.pitch;
          refreshVoiceSelect();
        }
        if (key === 'voiceURI') refreshVoiceSelect();
        saveCfg();
        if (key === 'bgmVolume' && masterGain) masterGain.gain.value = cfg.bgmVolume;
        if (key === 'bgTop' || key === 'bgBottom' || key === 'sunColor' || key === 'textColor' || key === 'accentColor' || key === 'title' || key === 'greeting' || key === 'sub' || key === 'displayTime') {
          if (!running) drawFrame(2.6);
        }
      };
      el.addEventListener('change', handler);
      if (el.tagName === 'TEXTAREA' || el.type === 'text') el.addEventListener('input', handler);
    });
    root.querySelector('[data-mr="save"]').addEventListener('click', function () { saveCfg(); toastMsg('设置已保存'); });
    root.querySelector('[data-mr="weather"]').addEventListener('click', function () {
      toastMsg('正在获取最新天气…');
      fetchWeather(true).then(function (w) { toastMsg(w ? '天气已更新：' + weatherShort() : '天气获取失败，将自动降级'); });
    });
    root.querySelector('[data-mr="speak"]').addEventListener('click', speak);
    root.querySelector('[data-mr="play"]').addEventListener('click', function () { running ? pause() : play(); });
    root.querySelector('[data-mr="png"]').addEventListener('click', exportPNG);
    root.querySelector('[data-mr="video"]').addEventListener('click', function (e) { exportVideo(e.currentTarget); });
  }

  /* ---------- 生命周期：离开视图时彻底清理 ---------- */
  function stop() {
    pause();
    stopBgm();
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {}
    if (recStopTimer) { window.clearInterval(recStopTimer); recStopTimer = null; }
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop(); } catch (e) {}
    }
    recorder = null; recChunks = [];
    // 保留 audioCtx 以便再次进入复用；仅在存在时静音
    if (masterGain) { try { masterGain.gain.value = 0; } catch (e) {} }
    root = null; cvs = null; ctx = null;
  }

  window.MorningRadio = { render: render, stop: stop, DEFAULT: DEFAULT };
})();
