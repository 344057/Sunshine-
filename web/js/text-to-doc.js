/* ==========================================================================
   文字转文档工具 — 浏览器端逻辑（无构建、离线可用）
   依赖：vendor/docx.umd.js（window.docx）、vendor/jspdf.umd.min.js（window.jspdf）
   文字仅在本机处理，不上传任何服务器。权限与可用范围与图片转文档一致：所有成员可用。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const MM_TO_TWIPS = 1440 / 25.4;
  const CONFIG_KEY = 'sunny_text_to_doc_config_v1';
  const SAMPLE_TEXT = [
    'Sunshine个人工作站学习心得',
    '',
    '今天我学习了新的知识，收获很大。老师讲的每一个知识点我都认真记了下来，回家后还复习了一遍。',
    '学习让我感到快乐，也希望以后能帮助到更多的同学。',
    '',
    '—— Sunshine个人工作站',
  ].join('\n');

  const state = {
    text: '',
    config: { format: 'word', orientation: 'portrait', fontSize: 14, lineSpacing: 1.5, margin: 20 },
    lastBlob: null,
    lastFilename: '',
    lastMime: '',
    busy: false,
  };

  // ---------- 通用反馈（与图片转文档保持一致的交互状态） ----------
  function toast(msg, type) {
    const root = $('#toast-root');
    if (!root) return;
    const ic = type === 'error' ? 'i-alert' : type === 'info' ? 'i-info' : 'i-check';
    const el = document.createElement('div');
    el.className = 'toast toast--' + (type || 'success');
    el.innerHTML = '<svg class="icon"><use href="#' + ic + '"/></svg><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220); }, 2600);
  }
  function showOverlay(text) {
    const ov = $('#overlay'); if (!ov) return;
    const t = $('#overlay-text');
    if (t) t.textContent = text || '正在生成，请稍候…';
    ov.hidden = false;
  }
  function hideOverlay() { const ov = $('#overlay'); if (ov) ov.hidden = true; }
  function setNotice(text, isError) {
    const box = $('#notice'), span = $('#notice-text');
    if (!box || !span) return;
    if (!text) { box.hidden = true; return; }
    span.textContent = text;
    box.classList.toggle('is-error', !!isError);
    box.hidden = false;
  }

  // ---------- 配置记忆 ----------
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (!c || typeof c !== 'object') return;
      if (c.format === 'word' || c.format === 'pdf') state.config.format = c.format;
      if (c.orientation === 'portrait' || c.orientation === 'landscape') state.config.orientation = c.orientation;
      if ([12, 14, 16, 18].indexOf(Number(c.fontSize)) >= 0) state.config.fontSize = Number(c.fontSize);
      if ([1, 1.5, 2].indexOf(Number(c.lineSpacing)) >= 0) state.config.lineSpacing = Number(c.lineSpacing);
      const m = Number(c.margin);
      if (Number.isFinite(m) && m >= 0 && m <= 40) state.config.margin = Math.round(m);
    } catch (e) { /* 配置损坏时静默用默认值 */ }
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch (e) { /* 忽略 */ }
  }

  // ---------- 输入与预览 ----------
  function paragraphs() {
    return String(state.text || '').replace(/\r/g, '').split('\n');
  }
  function updateCount() {
    const el = $('#char-count'); if (!el) return;
    const chars = String(state.text || '').replace(/\s/g, '').length;
    const paras = paragraphs().filter((p) => p.trim()).length;
    el.textContent = chars + ' 字 · ' + Math.max(1, paras) + ' 段';
  }
  function renderPreview() {
    const c = state.config;
    const paper = $('#paper'), area = $('#paper-area'), title = $('#paper-title');
    const body = $('#paper-text'), caption = $('#preview-caption');
    if (!paper || !area || !body || !caption) return;
    paper.classList.toggle('paper--portrait', c.orientation === 'portrait');
    paper.classList.toggle('paper--landscape', c.orientation === 'landscape');

    const pageW = c.orientation === 'landscape' ? 297 : 210;
    const pageH = c.orientation === 'landscape' ? 210 : 297;
    const mx = Math.min(40, c.margin) / pageW * 100;
    const my = Math.min(40, c.margin) / pageH * 100;
    area.style.left = mx + '%'; area.style.right = mx + '%';
    area.style.top = my + '%'; area.style.bottom = my + '%';

    const name = ($('#name-input') && $('#name-input').value.trim()) || '文字文档';
    if (title) title.textContent = name;
    body.textContent = state.text || '';
    const previewFs = Math.max(6, c.fontSize * 0.55);
    body.style.setProperty('--preview-fs', previewFs.toFixed(1) + 'px');
    body.style.setProperty('--preview-lh', String(c.lineSpacing));

    const sizeName = { 12: '小四', 14: '四号', 16: '三号', 18: '二号' }[c.fontSize] || String(c.fontSize);
    const lineName = { 1: '单倍', 1.5: '1.5 倍', 2: '2 倍' }[c.lineSpacing] || String(c.lineSpacing);
    caption.textContent = 'A4 ' + (c.orientation === 'landscape' ? '横版' : '竖版') + ' · ' + sizeName + ' · ' + lineName + '行距 · 边距 ' + c.margin + 'mm';
    updateCount();
  }
  function syncSegUI() {
    $$('.seg__btn').forEach((btn) => {
      const active = String(state.config[btn.dataset.group]) === String(btn.dataset.value);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    renderPreview();
  }
  function clearResultOnly() {
    const result = $('#result'), saveRow = $('#save-row');
    if (result) result.hidden = true;
    if (saveRow) saveRow.hidden = true;
  }
  function clearResult() {
    state.lastBlob = null; state.lastFilename = ''; state.lastMime = '';
    clearResultOnly();
    const prog = $('#progress-wrap'); if (prog) prog.hidden = true;
  }

  // ---------- 文件名 ----------
  function safeFilename(raw, ext) {
    let name = String(raw == null ? '' : raw).trim() || '文字文档';
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 80) || '文字文档';
    return name + ext;
  }

  // ---------- Word 生成 ----------
  async function buildWord(lines, config, name, onProgress) {
    if (typeof window.docx === 'undefined') throw new Error('Word 组件未加载，请刷新页面重试');
    const D = window.docx;
    const pageW = config.orientation === 'landscape' ? 297 : 210;
    const pageH = config.orientation === 'landscape' ? 210 : 297;
    const margin = config.margin;
    const sectionProps = {
      page: {
        size: {
          width: Math.round(pageW * MM_TO_TWIPS), height: Math.round(pageH * MM_TO_TWIPS),
          orientation: config.orientation === 'landscape' ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT,
        },
        margin: {
          top: Math.round(margin * MM_TO_TWIPS), bottom: Math.round(margin * MM_TO_TWIPS),
          left: Math.round(margin * MM_TO_TWIPS), right: Math.round(margin * MM_TO_TWIPS),
        },
      },
    };
    const lineTwips = Math.round(config.lineSpacing * 240);
    const children = [new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 280, line: 360 },
      children: [new D.TextRun({ text: name, bold: true, size: 32, font: 'SimSun' })],
    })];
    for (let i = 0; i < lines.length; i++) {
      children.push(new D.Paragraph({
        spacing: { before: 0, after: 120, line: lineTwips },
        children: [new D.TextRun({ text: lines[i], size: Math.round(config.fontSize * 2), font: 'SimSun' })],
      }));
      onProgress(i + 1, lines.length);
      if (i % 20 === 19) await nextFrame();
    }
    const doc = new D.Document({ sections: [{ properties: sectionProps, children }] });
    return D.Packer.toBlob(doc);
  }

  // ---------- PDF 生成（canvas 排版，原生支持中文，无需外部字体） ----------
  function wrapLine(ctx, text, maxWidth) {
    if (!text) return [''];
    const out = [];
    let cur = '';
    for (const ch of String(text)) {
      if (ctx.measureText(cur + ch).width > maxWidth && cur) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  async function buildPdf(lines, config, name, onProgress) {
    if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF !== 'function') throw new Error('PDF 组件未加载，请刷新页面重试');
    const jsPDF = window.jspdf.jsPDF;
    const landscape = config.orientation === 'landscape';
    const pageWmm = landscape ? 297 : 210, pageHmm = landscape ? 210 : 297;
    const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });

    const scale = 2;                       // 提高清晰度
    const pxPerMm = (96 / 25.4) * scale;   // 96dpi × 2
    const W = Math.round(pageWmm * pxPerMm);
    const H = Math.round(pageHmm * pxPerMm);
    const pad = Math.round(config.margin * pxPerMm);
    const fontPx = config.fontSize * (96 / 72) * scale;
    const linePx = fontPx * config.lineSpacing;
    const titlePx = fontPx * 1.6;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';

    let page = 1;
    let y = pad;
    const maxWidth = W - 2 * pad;

    function newPage() {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageWmm, pageHmm);
      pdf.addPage();
      page++;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      y = pad;
      onProgress(page, page + 1);
    }
    function write(text, px, alignCenter) {
      ctx.font = 'bold '.concat(Math.round(px), 'px SimSun, "宋体", serif');
      const wrapped = wrapLine(ctx, text, maxWidth);
      for (const line of wrapped) {
        if (y + linePx > H - pad) newPage();
        const x = alignCenter ? (W - ctx.measureText(line).width) / 2 : pad;
        ctx.fillText(line, x, y);
        y += linePx;
      }
    }

    write(name || '文字文档', titlePx, true);
    y += linePx * 0.5;
    ctx.font = Math.round(fontPx) + 'px SimSun, "宋体", serif';
    for (let i = 0; i < lines.length; i++) {
      for (const line of wrapLine(ctx, lines[i], maxWidth)) {
        if (y + linePx > H - pad) newPage();
        ctx.fillText(line, pad, y);
        y += linePx;
      }
      onProgress(i + 1, lines.length);
      if (i % 20 === 19) await nextFrame();
    }
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageWmm, pageHmm);
    onProgress(lines.length, lines.length);
    return pdf.output('blob');
  }

  // ---------- 生成流程 ----------
  async function generate() {
    if (state.busy) return;
    if (!String(state.text || '').trim()) { toast('请先输入或粘贴文字', 'error'); setNotice('请先输入或粘贴文字', true); return; }

    const c = state.config;
    const ext = c.format === 'word' ? '.docx' : '.pdf';
    const name = ($('#name-input') && $('#name-input').value.trim()) || '文字文档';
    const filename = safeFilename(name, ext);
    const mime = c.format === 'word'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';
    const lines = paragraphs();

    state.busy = true;
    const genBtn = $('#btn-generate'); if (genBtn) genBtn.disabled = true;
    const pw = $('#progress-wrap'); if (pw) pw.hidden = false;
    clearResultOnly(); setNotice('');
    showOverlay('正在排版并生成文档…');
    updateProgress(0, lines.length, '准备文字');
    await nextFrame();

    try {
      const onProgress = (done, total) => updateProgress(done, total, '排版生成');
      const blob = c.format === 'word' ? await buildWord(lines, c, name, onProgress) : await buildPdf(lines, c, name, onProgress);
      if (!blob || blob.size === 0) throw new Error('生成的文档为空');

      state.lastBlob = blob; state.lastFilename = filename; state.lastMime = mime;
      const rName = $('#result-name'), rMeta = $('#result-meta');
      if (rName) rName.textContent = filename;
      if (rMeta) rMeta.textContent = (blob.size / 1024).toFixed(1) + ' KB · ' + lines.length + ' 段文字';
      const result = $('#result'), saveRow = $('#save-row');
      if (result) result.hidden = false;
      if (saveRow) saveRow.hidden = false;

      updateProgress(lines.length, lines.length, '完成');
      setNotice('文档已生成。点击「保存到本地」下载，或点击「系统分享」发送给其他应用。');
      toast('文档生成成功', 'success');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setNotice('生成失败：' + msg, true);
      toast('生成失败：' + msg, 'error');
    } finally {
      state.busy = false;
      if (genBtn) genBtn.disabled = false;
      hideOverlay();
    }
  }
  function updateProgress(done, total, phase) {
    const bar = $('#progress-bar'), text = $('#progress-text');
    const pct = total ? Math.round(done / total * 100) : 100;
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = phase + '（' + done + ' / ' + total + '）';
  }

  // ---------- 保存本地 / 系统分享（与图片转文档一致） ----------
  async function saveDoc() {
    if (!state.lastBlob) { toast('请先生成文档', 'error'); return; }
    const blob = state.lastBlob, filename = state.lastFilename, mime = state.lastMime;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const ext = filename.slice(filename.lastIndexOf('.'));
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: ext === '.pdf' ? 'PDF 文档' : 'Word 文档', accept: { [mime]: [ext] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('已保存到本地', 'success');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    downloadBlob(blob, filename);
    toast('已开始下载，请在浏览器下载列表或「文件」应用中查看', 'info');
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 12000);
  }
  async function shareDoc() {
    if (!state.lastBlob) { toast('请先生成文档', 'error'); return; }
    const file = new File([state.lastBlob], state.lastFilename, { type: state.lastMime });
    if (typeof navigator.share !== 'function') {
      setNotice('当前浏览器不支持系统分享。请使用「保存到本地」，再从系统的文件应用中分享。', false);
      toast('当前设备不支持系统分享，请保存到本地后分享', 'info');
      return;
    }
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
      setNotice('当前设备不支持分享此类型文件。请使用「保存到本地」，再从系统应用中分享。', false);
      toast('此设备不支持分享文件类型', 'info');
      return;
    }
    try {
      await navigator.share({ files: [file], title: state.lastFilename, text: '文字转文档' });
      toast('已打开系统分享', 'success');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      const msg = err && err.message ? err.message : '未知错误';
      setNotice('系统分享失败：' + msg, true);
      toast('分享失败：' + msg, 'error');
    }
  }

  // ---------- 恢复默认 ----------
  function resetConfig() {
    state.config = { format: 'word', orientation: 'portrait', fontSize: 14, lineSpacing: 1.5, margin: 20 };
    const nameInput = $('#name-input'); if (nameInput) nameInput.value = '文字文档';
    const marginInput = $('#margin-input'); if (marginInput) marginInput.value = '20';
    syncSegUI(); saveConfig(); clearResult(); setNotice('');
    toast('已恢复默认配置', 'info');
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    const back = $('#btn-back');
    if (back) back.addEventListener('click', () => {
      // 关闭功能页返回主站登录后的首页：写入会话内返回标记，首页据此恢复会话登录态
      if (window.SunnyTools && typeof window.SunnyTools.markToolReturn === 'function') window.SunnyTools.markToolReturn();
      try { window.sessionStorage.setItem('sunny-classroom-web-v1:tool-return', '1'); } catch (e) {}
      window.location.href = 'index.html' + window.location.search;
    });

    const input = $('#text-input');
    if (input) input.addEventListener('input', () => { state.text = input.value; clearResult(); renderPreview(); });

    const paste = $('#btn-paste');
    if (paste) paste.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
        toast('当前浏览器不支持读取剪贴板，请直接按 Ctrl/Cmd + V 粘贴', 'info');
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast('剪贴板中没有文字', 'info'); return; }
        state.text = (state.text ? state.text.replace(/\s+$/, '') + '\n' : '') + text;
        if (input) input.value = state.text;
        clearResult(); renderPreview();
        toast('已粘贴到编辑区', 'success');
      } catch (e) {
        toast('读取剪贴板失败，请直接按 Ctrl/Cmd + V 粘贴', 'error');
      }
    });

    const sample = $('#btn-sample');
    if (sample) sample.addEventListener('click', () => {
      state.text = SAMPLE_TEXT;
      if (input) input.value = state.text;
      clearResult(); renderPreview(); setNotice('');
      toast('已填入示例文字', 'info');
    });

    const clear = $('#btn-clear');
    if (clear) clear.addEventListener('click', () => {
      state.text = '';
      if (input) { input.value = ''; input.focus(); }
      clearResult(); renderPreview(); setNotice('');
      toast('已清空文字', 'info');
    });

    $$('.seg__btn').forEach((btn) => btn.addEventListener('click', () => {
      const group = btn.dataset.group, value = btn.dataset.value;
      if (!group || !(group in state.config)) return;
      state.config[group] = ['fontSize', 'lineSpacing', 'margin'].indexOf(group) >= 0 ? Number(value) : value;
      syncSegUI(); saveConfig(); clearResult();
    }));

    const marginInput = $('#margin-input');
    if (marginInput) marginInput.addEventListener('input', () => {
      let v = parseInt(marginInput.value, 10);
      if (!Number.isFinite(v)) return;
      v = Math.max(0, Math.min(40, v));
      state.config.margin = v;
      renderPreview(); saveConfig(); clearResult();
    });
    if (marginInput) marginInput.addEventListener('blur', () => {
      const v = parseInt(marginInput.value, 10);
      marginInput.value = String(Number.isFinite(v) ? Math.max(0, Math.min(40, v)) : 20);
    });

    const nameInput = $('#name-input');
    if (nameInput) nameInput.addEventListener('input', () => { renderPreview(); clearResult(); });

    const gen = $('#btn-generate'); if (gen) gen.addEventListener('click', generate);
    const save = $('#btn-save'); if (save) save.addEventListener('click', saveDoc);
    const share = $('#btn-share'); if (share) share.addEventListener('click', shareDoc);
    const reset = $('#btn-reset'); if (reset) reset.addEventListener('click', resetConfig);
  }

  function init() {
    loadConfig();
    const marginInput = $('#margin-input'); if (marginInput) marginInput.value = String(state.config.margin);
    const input = $('#text-input'); if (input) { input.value = state.text; }
    syncSegUI();
    bindEvents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
