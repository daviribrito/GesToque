// Serve a demonstração gerada (demo-site/) em http://localhost:3600/GesToque/, do mesmo jeito que o
// GitHub Pages (site numa subpasta). Só para testar antes de publicar. Uso: npm run demo:servir
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', 'demo-site');
const PREFIX = '/GesToque/';
const PORT = Number(process.env.PORT) || 3600;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/GesToque') {
    res.writeHead(302, { Location: PREFIX });
    return res.end();
  }
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(404);
    return res.end('Não encontrado');
  }
  const rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
  const file = path.normalize(path.join(SITE, rel.endsWith('/') ? rel + 'index.html' : rel));
  if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Não encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Demonstração em http://localhost:${PORT}${PREFIX}`));
