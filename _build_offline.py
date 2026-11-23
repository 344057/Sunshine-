# -*- coding: utf-8 -*-
"""把 site/ 下的站点打包成单文件离线版：内联所有 CSS / JS / favicon。
运行一次即可生成 index.html / image-to-doc.html / text-to-doc.html，
每个文件都自包含，双击即可离线使用（不需要服务器、不需要联网）。
"""
import os
import re
import base64

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, '..', 'site'))
OUT = HERE

PAGES = ['index.html', 'image-to-doc.html', 'text-to-doc.html']

with open(os.path.join(SRC, 'favicon.svg'), 'rb') as f:
    favicon_b64 = base64.b64encode(f.read()).decode('ascii')
FAVICON_URI = 'data:image/svg+xml;base64,' + favicon_b64


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
        # 防止 JS 中出现 </script> 提前闭合（本次资源已确认无此字面量）
        js = js.replace('</script>', '<\\/script>')
        return '<script>\n' + js + '\n</script>'
    return pattern.sub(repl, html)


def inline_favicon(html):
    return re.sub(
        r'(<link\b[^>]*rel=["\']icon["\'][^>]*href=["\'])[^"\']+(["\'])',
        lambda m: m.group(1) + FAVICON_URI + m.group(2),
        html, flags=re.I,
    )


for name in PAGES:
    with open(os.path.join(SRC, name), 'r', encoding='utf-8') as f:
        html = f.read()
    html = inline_favicon(html)
    html = inline_css(html)
    html = inline_js(html)
    out_path = os.path.join(OUT, name)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('生成: {} ({:,} bytes)'.format(name, os.path.getsize(out_path)))

print('离线版打包完成，输出目录:', OUT)
