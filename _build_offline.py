# -*- coding: utf-8 -*-
"""把 site/ 下的站点打包成单文件离线版：内联所有 CSS / JS / favicon，并注入访问密码门。
运行一次即可生成 index.html / image-to-doc.html / text-to-doc.html，
每个文件都自包含，双击即可离线使用（不需要服务器、不需要联网）。

修改访问密码：改下面的 ACCESS_PASSWORD，重新运行本脚本即可。
密码以哈希形式写入 HTML，源码中不出现明文；前端密码门仅用于防止他人随意打开，
不具备密码学级保密性（懂技术者仍可绕过），请勿用于真正的机密保护。
"""
import os
import re
import base64

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, '..', 'site'))
OUT = HERE

# ===== 访问密码（修改这里后重新运行本脚本）=====
ACCESS_PASSWORD = 'yfw123698'


def fnv1a(text):
    """与前端 JS 中 fnv1a 实现一致（UTF-8 字节，FNV-1a 32 位）。"""
    h = 0x811c9dc5
    for b in text.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xffffffff
    return h


PAGES = ['index.html', 'image-to-doc.html', 'text-to-doc.html']

with open(os.path.join(SRC, 'favicon.svg'), 'rb') as f:
    favicon_b64 = base64.b64encode(f.read()).decode('ascii')
FAVICON_URI = 'data:image/svg+xml;base64,' + favicon_b64

GATE_HASH = str(fnv1a(ACCESS_PASSWORD))

GATE_CSS = """
<style id="pw-gate-style">
#pw-gate{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(251,247,240,.97);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font-family:'Nunito','PingFang SC','Microsoft YaHei',system-ui,sans-serif}
:root[data-theme="dark"] #pw-gate{background:rgba(27,25,23,.97)}
.pw-card{width:100%;max-width:384px;background:var(--surface,#FFFDF9);border:1px solid var(--line,#EDE5D7);border-radius:22px;padding:32px 28px 28px;box-shadow:0 20px 56px rgba(74,58,36,.16);text-align:center}
.pw-logo{width:58px;height:58px;margin:0 auto 16px;border-radius:16px;background:var(--brand,#F2653A);color:#fff;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 8px 20px rgba(242,101,58,.28)}
.pw-logo svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pw-card h2{font-size:20px;margin:0 0 6px;color:var(--ink,#2C2A27)}
.pw-sub{font-size:13px;color:var(--ink-3,#6E685E);margin:0 0 22px}
.pw-input{width:100%;padding:13px 16px;border:1px solid var(--line-2,#E2D8C7);border-radius:12px;background:var(--surface-2,#FFF9F1);color:var(--ink,#2C2A27);font-size:16px;letter-spacing:1px;outline:none;text-align:center}
.pw-input:focus{border-color:var(--brand,#F2653A);box-shadow:0 0 0 3px var(--brand-ring,rgba(242,101,58,.22))}
.pw-err{color:var(--danger,#E05252);font-size:13px;margin:10px 0 0;min-height:18px}
.pw-remember{display:flex;align-items:center;justify-content:center;gap:7px;font-size:13px;color:var(--ink-2,#57534C);margin:14px 0 18px;cursor:pointer}
.pw-remember input{accent-color:var(--brand,#F2653A);width:15px;height:15px}
.pw-btn{width:100%;padding:13px;border:none;border-radius:12px;background:var(--brand,#F2653A);color:#fff;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 8px 20px rgba(242,101,58,.24)}
.pw-btn:hover{background:var(--brand-600,#DC5229)}
.pw-btn:active{transform:scale(.98)}
@media(max-width:420px){.pw-card{padding:26px 20px 22px}}
</style>
"""

GATE_HTML_TEMPLATE = """
<div id="pw-gate" role="dialog" aria-modal="true" aria-labelledby="pw-title">
  <div class="pw-card">
    <span class="pw-logo"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
    <h2 id="pw-title">需要访问密码</h2>
    <p class="pw-sub">本地工具站已启用密码保护，请输入密码继续使用</p>
    <form id="pw-form" autocomplete="off">
      <input class="pw-input" id="pw-input" type="password" inputmode="text" autocomplete="current-password" placeholder="请输入访问密码" aria-label="访问密码" autofocus />
      <p class="pw-err" id="pw-error" role="alert" hidden>密码不正确，请重试</p>
      <label class="pw-remember"><input type="checkbox" id="pw-remember" checked /> 记住此设备</label>
      <button class="pw-btn" type="submit">进入工具站</button>
    </form>
  </div>
</div>
<script>
(function(){
  var HASH = __GATE_HASH__;
  var KEY = 'sunny_tools_gate_ok_v1';
  var gate = document.getElementById('pw-gate');
  var form = document.getElementById('pw-form');
  var input = document.getElementById('pw-input');
  var err = document.getElementById('pw-error');
  var remember = document.getElementById('pw-remember');

  function fnv1a(str){
    var h = 0x811c9dc5;
    var bytes = new TextEncoder().encode(str);
    for(var i=0;i<bytes.length;i++){ h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function closeGate(){ if(gate && gate.parentNode) gate.parentNode.removeChild(gate); }
  function readOk(){
    var v = null;
    try { v = window.localStorage.getItem(KEY); } catch(e){}
    if (v === String(HASH)) return true;
    try { v = window.sessionStorage.getItem(KEY); } catch(e){}
    return v === String(HASH);
  }
  if (readOk()) { closeGate(); return; }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (fnv1a(input.value) === HASH) {
      try {
        if (remember.checked) window.localStorage.setItem(KEY, String(HASH));
        else window.sessionStorage.setItem(KEY, String(HASH));
      } catch(e){}
      closeGate();
    } else {
      err.hidden = false;
      input.value = '';
      try { input.focus(); } catch(e){}
    }
  });
  try { input.focus(); } catch(e){}
})();
</script>
""".replace('__GATE_HASH__', GATE_HASH)


def inline_css(html):
    pattern = re.compile(r'<link\b[^>]*rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)["\'][^>]*>', re.I)
    def repl(m):
        href = m.group(1).split('?')[0]
        path = os.path.join(SRC, href.replace('/', os.sep))
        with open(path, 'r', encoding='utf-8') as f:
            css = f.read()
        return '<style>\n' + css + '\n</style>'
    return pattern.sub(repl, html)


def inline_js(html):
    pattern = re.compile(r'<script\b[^>]*src=["\']([^"\']+)["\'][^>]*>\s*</script>', re.I)
    def repl(m):
        src = m.group(1).split('?')[0]
        path = os.path.join(SRC, src.replace('/', os.sep))
        with open(path, 'r', encoding='utf-8') as f:
            js = f.read()
        js = js.replace('</script>', '<\\/script>')
        return '<script>\n' + js + '\n</script>'
    return pattern.sub(repl, html)


def inline_favicon(html):
    return re.sub(
        r'(<link\b[^>]*rel=["\']icon["\'][^>]*href=["\'])[^"\']+(["\'])',
        lambda m: m.group(1) + FAVICON_URI + m.group(2),
        html, flags=re.I,
    )


def inject_gate(html):
    # 样式进 head（尽早生效），遮罩与脚本放 body 开头（先于页面内容渲染，避免闪现）
    html = html.replace('</head>', GATE_CSS + '\n</head>', 1)
    html = re.sub(r'(<body[^>]*>)', r'\1' + '\n' + GATE_HTML_TEMPLATE, html, count=1, flags=re.I)
    return html


for name in PAGES:
    with open(os.path.join(SRC, name), 'r', encoding='utf-8') as f:
        html = f.read()
    html = inline_favicon(html)
    html = inline_css(html)
    html = inline_js(html)
    html = inject_gate(html)
    out_path = os.path.join(OUT, name)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('生成: {} ({:,} bytes)'.format(name, os.path.getsize(out_path)))

print('离线版打包完成（含访问密码门），输出目录:', OUT)
print('密码哈希(FNV-1a):', GATE_HASH)
