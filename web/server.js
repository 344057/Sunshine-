/* Sunshine个人工作站 Web · 零依赖本地静态服务器 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
// 部署环境会注入 PORT，此时绑定 0.0.0.0 才能经反向代理对外服务；
// 本地直接运行时默认只监听回环地址，更安全。
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.resolve(ROOT, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function sendFile(res, file, status = 200, method = 'GET') {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(status, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
    });
    // HEAD 请求只返回响应头，不发送响应体（符合 HTTP 规范）
    res.end(method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const urlPath = req.url || '/';
  // 禁止访问以 . 开头的隐藏文件/目录（如 .idea、.env、.git）
  if (urlPath.split('/').some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const method = req.method;
  let file = safeResolve(urlPath);
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, file, 200, method);
      return;
    }
    // 目录默认 index.html
    if (!err && stat.isDirectory()) {
      sendFile(res, path.join(file, 'index.html'), 200, method);
      return;
    }
    // SPA 回退：无扩展名路径都返回首页
    if (!path.extname(urlPath.split('?')[0])) {
      sendFile(res, path.join(ROOT, 'index.html'), 200, method);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Sunshine个人工作站 Web 已启动：http://${HOST}:${PORT}`);
  console.log('按 Ctrl+C 停止服务。');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置 PORT 环境变量后重试，例如：PORT=5174 npm start`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});
