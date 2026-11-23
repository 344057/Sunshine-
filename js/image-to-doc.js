/* ==========================================================================
   图片转文档工具 — 浏览器端逻辑（无构建、离线可用）
   依赖：vendor/docx.umd.js（window.docx）、vendor/jspdf.umd.min.js（window.jspdf）
   图片仅在本机 canvas 内处理，不上传任何服务器。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'];
  const ALLOWED_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/bmp': '.bmp', 'image/gif': '.gif', 'image/webp': '.webp', 'image/tiff': '.tiff' };
  const MM_TO_TWIPS = 1440 / 25.4;   // docx 页尺寸/边距单位
  const MM_TO_PX = 96 / 25.4;        // docx 图片 transformation 单位（1px = 9525 EMU）
  const CONFIG_KEY = 'sunny_image_to_doc_config_v1';

  // ---------- 状态 ----------
  const state = {
    images: [],        // { id, file, name, thumbUrl }
    config: {
      format: 'word',
      orientation: 'portrait',
      layout: 'one',
      arrange: 'horizontal',
      margin: 10,
    },
    lastBlob: null,
    lastFilename: '',
    lastMime: '',
    busy: false,
    seq: 0,
  };

  // ---------- 通用反馈 ----------
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
    const ov = $('#overlay');
    if (!ov) return;
    const t = $('#overlay-text');
    if (t) t.textContent = text || '正在生成，请稍候…';
    ov.hidden = false;
  }
  function hideOverlay() { const ov = $('#overlay'); if (ov) ov.hidden = true; }

  function setNotice(text, isError) {
    const box = $('#notice');
    const span = $('#notice-text');
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
      if (c.layout === 'one' || c.layout === 'two') state.config.layout = c.layout;
      if (c.arrange === 'horizontal' || c.arrange === 'vertical') state.config.arrange = c.arrange;
      const m = Number(c.margin);
      if (Number.isFinite(m) && m >= 0 && m <= 40) state.config.margin = Math.round(m);
    } catch (e) { /* 配置损坏时静默用默认值 */ }
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch (e) { /* 忽略 */ }
  }

  // ---------- 图片管理 ----------
  function isAllowedFile(file) {
    const type = (file.type || '').toLowerCase();
    if (ALLOWED_TYPES[type]) return true;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return IMAGE_EXTS.indexOf(ext) >= 0;
  }

  function naturalKey(name) {
    return String(name).split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? parseInt(part, 10) : part.toLowerCase()));
  }
  function compareNatural(a, b) {
    const x = naturalKey(a), y = naturalKey(b);
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len; i++) {
      if (x[i] === y[i]) continue;
      if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i];
      return String(x[i]) < String(y[i]) ? -1 : 1;
    }
    return x.length - y.length;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const valid = files.filter(isAllowedFile);
    const skipped = files.length - valid.length;
    let added = 0;
    valid.forEach((file) => {
      const thumbUrl = URL.createObjectURL(file);
      state.images.push({ id: ++state.seq, file, name: file.name, thumbUrl });
      added++;
    });
    if (added) {
      state.images.sort((a, b) => compareNatural(a.name, b.name));
      clearResult();
      renderThumbs();
      setNotice('');
      toast('已添加 ' + added + ' 张图片' + (skipped ? '（跳过 ' + skipped + ' 个非图片文件）' : ''), skipped ? 'info' : 'success');
    } else if (skipped) {
      toast('未识别到可用图片，请选择 JPG / PNG / WEBP 等格式', 'error');
    }
  }

  function revokeThumbs() { state.images.forEach((it) => URL.revokeObjectURL(it.thumbUrl)); }

  function renderThumbs() {
    const list = $('#thumbs');
    if (!list) return;
    const n = state.images.length;
    $('#thumb-head').hidden = n === 0;
    $('#thumb-actions').hidden = n === 0;
    $('#img-count').textContent = String(n);
    list.innerHTML = state.images.map((it, idx) => `
      <li class="thumb" data-id="${it.id}">
        <img src="${it.thumbUrl}" alt="${esc(it.name)}" loading="lazy" />
        <span class="thumb__index">${idx + 1}</span>
        <span class="thumb__tools">
          <button type="button" class="thumb__tool" data-act="up" data-id="${it.id}" aria-label="上移" ${idx === 0 ? 'disabled' : ''}><svg class="icon"><use href="#i-arrow-up"/></svg></button>
          <button type="button" class="thumb__tool" data-act="down" data-id="${it.id}" aria-label="下移" ${idx === n - 1 ? 'disabled' : ''}><svg class="icon"><use href="#i-arrow-down"/></svg></button>
          <button type="button" class="thumb__tool" data-act="remove" data-id="${it.id}" aria-label="移除"><svg class="icon"><use href="#i-x"/></svg></button>
        </span>
        <span class="thumb__name" title="${esc(it.name)}">${esc(it.name)}</span>
      </li>`).join('');
  }

  function removeImage(id) {
    const idx = state.images.findIndex((it) => it.id === id);
    if (idx < 0) return;
    URL.revokeObjectURL(state.images[idx].thumbUrl);
    state.images.splice(idx, 1);
    clearResult(); renderThumbs();
  }
  function moveImage(id, dir) {
    const idx = state.images.findIndex((it) => it.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= state.images.length) return;
    const tmp = state.images[idx]; state.images[idx] = state.images[target]; state.images[target] = tmp;
    clearResult(); renderThumbs();
  }
  function clearImages() {
    revokeThumbs(); state.images = [];
    clearResult(); renderThumbs(); setNotice('');
    toast('已清空图片列表', 'info');
  }

  // ---------- 预览 ----------
  function renderPreview() {
    const c = state.config;
    const paper = $('#paper'), area = $('#paper-area'), caption = $('#preview-caption');
    if (!paper || !area || !caption) return;
    paper.classList.toggle('paper--portrait', c.orientation === 'portrait');
    paper.classList.toggle('paper--landscape', c.orientation === 'landscape');

    const pageW = c.orientation === 'landscape' ? 297 : 210;
    const pageH = c.orientation === 'landscape' ? 210 : 297;
    const mx = Math.min(40, c.margin) / pageW * 100;
    const my = Math.min(40, c.margin) / pageH * 100;
    area.style.left = mx + '%'; area.style.right = mx + '%';
    area.style.top = my + '%'; area.style.bottom = my + '%';

    const two = c.layout === 'two';
    area.classList.toggle('paper__area--horizontal', two && c.arrange === 'horizontal');
    area.classList.toggle('paper__area--vertical', two && c.arrange === 'vertical');
    const slots = two ? 2 : 1;
    area.innerHTML = Array.from({ length: slots }, (_, i) => '<span class="paper__slot">' + (i + 1) + '</span>').join('');

    const parts = ['A4 ' + (c.orientation === 'landscape' ? '横版' : '竖版'), '每页 ' + slots + ' 张'];
    if (two) parts.push(c.arrange === 'horizontal' ? '左右并排' : '上下排列');
    parts.push('边距 ' + c.margin + 'mm');
    caption.textContent = parts.join(' · ');

    const af = $('#arrange-field');
    if (af) af.classList.toggle('is-disabled', !two);
  }

  function syncSegUI() {
    $$('.seg__btn').forEach((btn) => {
      const active = state.config[btn.dataset.group] === btn.dataset.value;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    renderPreview();
  }

  // ---------- 图片标准化（EXIF 方向 / 透明铺白 / 压缩） ----------
  async function normalizeImage(file) {
    let bitmap = null;
    let imgEl = null;
    try {
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      }
    } catch (e) { bitmap = null; }
    if (!bitmap) {
      const url = URL.createObjectURL(file);
      try {
        imgEl = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('图片解码失败'));
          im.src = url;
        });
      } catch (e) { URL.revokeObjectURL(url); throw e; }
    }
    const srcW = bitmap ? bitmap.width : imgEl.naturalWidth;
    const srcH = bitmap ? bitmap.height : imgEl.naturalHeight;
    if (!srcW || !srcH) { if (bitmap) bitmap.close(); else URL.revokeObjectURL(imgEl.src); throw new Error('图片尺寸异常'); }

    const maxSide = 2500;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap || imgEl, 0, 0, w, h);
    if (bitmap) bitmap.close(); else URL.revokeObjectURL(imgEl.src);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
    return { dataUrl, bytes, width: w, height: h };
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function containSize(srcW, srcH, boxW, boxH) {
    if (!srcW || !srcH) return [boxW, boxH];
    const scale = Math.min(boxW / srcW, boxH / srcH);
    return [srcW * scale, srcH * scale];
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function safeFilename(raw, ext) {
    let name = String(raw == null ? '' : raw).trim() || '图片文档';
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 80) || '图片文档';
    return name + ext;
  }

  // ---------- Word 生成 ----------
  async function buildWord(items, config, onProgress) {
    if (typeof window.docx === 'undefined') throw new Error('Word 组件未加载，请刷新页面重试');
    const D = window.docx;
    const pageW = config.orientation === 'landscape' ? 297 : 210;
    const pageH = config.orientation === 'landscape' ? 210 : 297;
    const margin = config.margin;
    const availW = pageW - 2 * margin;
    const availH = pageH - 2 * margin;

    const sectionProps = {
      page: {
        size: {
          width: Math.round(pageW * MM_TO_TWIPS),
          height: Math.round(pageH * MM_TO_TWIPS),
          orientation: config.orientation === 'landscape' ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT,
        },
        margin: {
          top: Math.round(margin * MM_TO_TWIPS), bottom: Math.round(margin * MM_TO_TWIPS),
          left: Math.round(margin * MM_TO_TWIPS), right: Math.round(margin * MM_TO_TWIPS),
        },
      },
    };

    const children = [];
    let done = 0;
    const total = items.length;

    if (config.layout === 'one') {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const [wMm, hMm] = containSize(it.width, it.height, availW, availH - 4);
        children.push(new D.Paragraph({
          alignment: D.AlignmentType.CENTER,
          spacing: { before: 0, after: 0, line: 240 },
          pageBreakBefore: i > 0,
          children: [new D.ImageRun({
            data: it.bytes, type: 'jpg',
            transformation: { width: Math.round(wMm * MM_TO_PX), height: Math.round(hMm * MM_TO_PX) },
          })],
        }));
        done++; onProgress(done, total);
        if (i % 3 === 2) await nextFrame();
      }
    } else {
      const groups = chunk(items, 2);
      const horizontal = config.arrange === 'horizontal';
      const rows = horizontal ? 1 : 2, cols = horizontal ? 2 : 1;
      const cellW = availW / cols, cellH = availH / rows;
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const tableRows = [];
        for (let r = 0; r < rows; r++) {
          const cells = [];
          for (let col = 0; col < cols; col++) {
            const slot = r * cols + col;
            const it = group[slot];
            const paraChildren = [];
            if (it) {
              const [wMm, hMm] = containSize(it.width, it.height, cellW - 8, cellH - 8);
              paraChildren.push(new D.ImageRun({
                data: it.bytes, type: 'jpg',
                transformation: { width: Math.round(wMm * MM_TO_PX), height: Math.round(hMm * MM_TO_PX) },
              }));
            }
            cells.push(new D.TableCell({
              width: { size: Math.round(cellW * MM_TO_TWIPS), type: D.WidthType.DXA },
              verticalAlign: D.VerticalAlign.CENTER,
              children: [new D.Paragraph({
                alignment: D.AlignmentType.CENTER,
                spacing: { before: 0, after: 0, line: 240 },
                pageBreakBefore: slot === 0 && gi > 0,
                children: paraChildren,
              })],
            }));
          }
          tableRows.push(new D.TableRow({ children: cells }));
        }
        children.push(new D.Table({ rows: tableRows, width: { size: Math.round(availW * MM_TO_TWIPS), type: D.WidthType.DXA } }));
        done += group.length; onProgress(done, total);
        if (gi % 2 === 1) await nextFrame();
      }
    }

    const doc = new D.Document({ sections: [{ properties: sectionProps, children }] });
    return D.Packer.toBlob(doc);
  }

  // ---------- PDF 生成 ----------
  async function buildPdf(items, config, onProgress) {
    if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF !== 'function') throw new Error('PDF 组件未加载，请刷新页面重试');
    const jsPDF = window.jspdf.jsPDF;
    const pdf = new jsPDF({ orientation: config.orientation, unit: 'mm', format: 'a4' });
    const pageW = config.orientation === 'landscape' ? 297 : 210;
    const pageH = config.orientation === 'landscape' ? 210 : 297;
    const margin = config.margin;
    const availW = pageW - 2 * margin, availH = pageH - 2 * margin;

    let done = 0, total = items.length;
    if (config.layout === 'one') {
      for (let i = 0; i < items.length; i++) {
        if (i > 0) pdf.addPage();
        const it = items[i];
        const [w, h] = containSize(it.width, it.height, availW, availH);
        pdf.addImage(it.dataUrl, 'JPEG', (pageW - w) / 2, (pageH - h) / 2, w, h);
        done++; onProgress(done, total);
        if (i % 3 === 2) await nextFrame();
      }
    } else {
      const groups = chunk(items, 2);
      const horizontal = config.arrange === 'horizontal';
      const cellW = availW / 2, cellH = availH / 2;
      const gap = 4;
      for (let gi = 0; gi < groups.length; gi++) {
        if (gi > 0) pdf.addPage();
        const group = groups[gi];
        for (let slot = 0; slot < group.length; slot++) {
          const it = group[slot];
          const [w, h] = containSize(it.width, it.height, cellW - 2 * gap, cellH - 2 * gap);
          let cellX, cellY;
          if (horizontal) { cellX = margin + slot * cellW; cellY = margin; }
          else { cellX = margin; cellY = margin + (1 - slot) * cellH; }
          pdf.addImage(it.dataUrl, 'JPEG', cellX + (cellW - w) / 2, cellY + (cellH - h) / 2, w, h);
          done++; onProgress(done, total);
        }
        if (gi % 2 === 1) await nextFrame();
      }
    }
    return pdf.output('blob');
  }

  // ---------- 生成流程 ----------
  function clearResult() {
    state.lastBlob = null; state.lastFilename = ''; state.lastMime = '';
    const result = $('#result'), saveRow = $('#save-row'), prog = $('#progress-wrap');
    if (result) result.hidden = true;
    if (saveRow) saveRow.hidden = true;
    if (prog) prog.hidden = true;
  }

  function updateProgress(done, total, phase) {
    const bar = $('#progress-bar'), text = $('#progress-text');
    const pct = total ? Math.round(done / total * 100) : 100;
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = phase + '（' + done + ' / ' + total + '）';
  }

  async function generate() {
    if (state.busy) return;
    if (!state.images.length) { toast('请先选择图片', 'error'); return; }

    const c = state.config;
    const ext = c.format === 'word' ? '.docx' : '.pdf';
    const filename = safeFilename($('#name-input') ? $('#name-input').value : '', ext);
    const mime = c.format === 'word'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';

    state.busy = true;
    const genBtn = $('#btn-generate');
    if (genBtn) genBtn.disabled = true;
    const pw = $('#progress-wrap');
    if (pw) pw.hidden = false;
    clearResultOnly();
    setNotice('');
    showOverlay('正在处理图片并生成文档…');
    updateProgress(0, state.images.length, '准备图片');
    await nextFrame();

    try {
      const items = [];
      for (let i = 0; i < state.images.length; i++) {
        const pre = await normalizeImage(state.images[i].file);
        items.push(pre);
        updateProgress(i + 1, state.images.length, '处理图片');
        if (i % 3 === 2) await nextFrame();
      }

      const onProgress = (done, total) => updateProgress(done, total, '排版生成');
      const blob = c.format === 'word' ? await buildWord(items, c, onProgress) : await buildPdf(items, c, onProgress);
      if (!blob || blob.size === 0) throw new Error('生成的文档为空');

      state.lastBlob = blob;
      state.lastFilename = filename;
      state.lastMime = mime;

      const rName = $('#result-name'), rMeta = $('#result-meta');
      if (rName) rName.textContent = filename;
      if (rMeta) rMeta.textContent = (blob.size / 1024).toFixed(1) + ' KB · ' + state.images.length + ' 张图片';
      const result = $('#result'), saveRow = $('#save-row');
      if (result) result.hidden = false;
      if (saveRow) saveRow.hidden = false;

      updateProgress(state.images.length, state.images.length, '完成');
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

  function clearResultOnly() {
    const result = $('#result'), saveRow = $('#save-row');
    if (result) result.hidden = true;
    if (saveRow) saveRow.hidden = true;
  }

  // ---------- 保存到本地 ----------
  async function saveDoc() {
    if (!state.lastBlob) { toast('请先生成文档', 'error'); return; }
    const blob = state.lastBlob, filename = state.lastFilename, mime = state.lastMime;
    // 桌面 Chromium 系：优先使用文件选择器，可自定义保存位置
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
        if (err && err.name === 'AbortError') return; // 用户取消
        // 其它情况回退到通用下载
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
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 12000);
  }

  // ---------- 系统分享 ----------
  async function shareDoc() {
    if (!state.lastBlob) { toast('请先生成文档', 'error'); return; }
    const file = new File([state.lastBlob], state.lastFilename, { type: state.lastMime });
    if (typeof navigator.share !== 'function') {
      setNotice('当前浏览器不支持系统分享。请使用「保存到本地」，再从系统的文件/相册应用中分享。', false);
      toast('当前设备不支持系统分享，请保存到本地后分享', 'info');
      return;
    }
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
      setNotice('当前设备不支持分享此类型文件。请使用「保存到本地」，再从系统应用中分享。', false);
      toast('此设备不支持分享文件类型', 'info');
      return;
    }
    try {
      await navigator.share({ files: [file], title: state.lastFilename, text: '图片转文档' });
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
    state.config = { format: 'word', orientation: 'portrait', layout: 'one', arrange: 'horizontal', margin: 10 };
    const nameInput = $('#name-input'); if (nameInput) nameInput.value = '图片文档';
    const marginInput = $('#margin-input'); if (marginInput) marginInput.value = '10';
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

    const fileInput = $('#file-input'), cameraInput = $('#camera-input');
    const pickFiles = $('#btn-pick-files'), pickCamera = $('#btn-pick-camera'), dropzone = $('#dropzone');
    if (pickFiles && fileInput) pickFiles.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    if (pickCamera && cameraInput) pickCamera.addEventListener('click', (e) => { e.stopPropagation(); cameraInput.click(); });
    if (fileInput) fileInput.addEventListener('change', (e) => { addFiles(e.target.files); fileInput.value = ''; });
    if (cameraInput) cameraInput.addEventListener('change', (e) => { addFiles(e.target.files); cameraInput.value = ''; });

    if (dropzone) {
      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (fileInput) fileInput.click();
      });
      dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (fileInput) fileInput.click(); }
      });
      ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('is-over'); }));
      ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('is-over'); }));
      dropzone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
    }

    const thumbs = $('#thumbs');
    if (thumbs) thumbs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      if (act === 'remove') removeImage(id);
      else if (act === 'up') moveImage(id, -1);
      else if (act === 'down') moveImage(id, 1);
    });
    const clearBtn = $('#btn-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearImages);

    $$('.seg__btn').forEach((btn) => btn.addEventListener('click', () => {
      const group = btn.dataset.group, value = btn.dataset.value;
      if (!group || !(group in state.config)) return;
      state.config[group] = value;
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
      marginInput.value = String(Number.isFinite(v) ? Math.max(0, Math.min(40, v)) : 10);
    });

    const nameInput = $('#name-input');
    if (nameInput) nameInput.addEventListener('input', clearResult);

    const gen = $('#btn-generate'); if (gen) gen.addEventListener('click', generate);
    const save = $('#btn-save'); if (save) save.addEventListener('click', saveDoc);
    const share = $('#btn-share'); if (share) share.addEventListener('click', shareDoc);
    const reset = $('#btn-reset'); if (reset) reset.addEventListener('click', resetConfig);

    // 全局拖拽兜底：防止浏览器直接打开图片导致离开工具页
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  function init() {
    loadConfig();
    const marginInput = $('#margin-input'); if (marginInput) marginInput.value = String(state.config.margin);
    syncSegUI();
    renderThumbs();
    bindEvents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
