// Gera a demonstração estática do GesToque em demo-site/ (para o GitHub Pages ou qualquer hospedagem estática).
// Tudo roda no navegador: as rotas e o código de server/ são empacotados em js/demo.js, com o Postgres (PGlite)
// guardado no IndexedDB do visitante. Login e 2FA são de demonstração (demo/auth.js).
// Uso: npm run demo:build  ->  demo-site/
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo-site');
const PUBLIC = path.join(ROOT, 'public');
const PGLITE = path.join(ROOT, 'node_modules', '@electric-sql', 'pglite');
const VERSION = require('../package.json').version;

// Módulos de server/ trocados pela versão da demo (demo/*). Só quando quem importa está em server/.
const SWAP = { './db': 'db.js', './config': 'config.js', './security': 'security.js', './auth': 'auth.js', './photos': 'photos.js' };
// Módulos do Node que o código de servidor cita mas a demo não usa.
const EMPTY = new Set(['pg', 'http', 'https', 'crypto', 'util', 'zlib', 'url', 'module', 'os', 'stream', 'worker_threads', 'child_process', 'net', 'tls']);

// Arquivos que server/app.js lê com fs.readFileSync (notas de versão e documentação técnica): vão embutidos.
const EMBED = {
  'novidades.json': fs.readFileSync(path.join(ROOT, 'server', 'novidades.json'), 'utf8'),
  'duvidasdev.html': fs.readFileSync(path.join(ROOT, 'server', 'paginas', 'duvidasdev.html'), 'utf8'),
};

const demoPlugin = {
  name: 'gestoque-demo',
  setup(build) {
    build.onResolve({ filter: /^\.\/(db|config|security|auth|photos)$/ }, (args) => {
      if (path.basename(args.resolveDir) !== 'server') return undefined;
      return { path: path.join(ROOT, 'demo', SWAP[args.path]) };
    });
    build.onResolve({ filter: /^@electric-sql\/pglite$/ }, () => ({ path: path.join(PGLITE, 'dist', 'index.js') }));
    build.onResolve({ filter: /^exceljs$/ }, () => ({ path: path.join(ROOT, 'node_modules', 'exceljs', 'dist', 'exceljs.min.js') }));
    build.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qrcode', namespace: 'stub' }));
    build.onResolve({ filter: /^(node:)?(fs|path)$/ }, (args) => ({ path: args.path.replace('node:', ''), namespace: 'stub' }));
    build.onResolve({ filter: /^(node:)?[a-z_]+$/ }, (args) => {
      const name = args.path.replace('node:', '');
      return EMPTY.has(name) ? { path: name, namespace: 'stub' } : undefined;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'fs') {
        return {
          contents: `const files = ${JSON.stringify(EMBED)};
            const base = (p) => String(p).split(/[\\\\/]/).pop();
            module.exports = {
              readFileSync: (p) => { const t = files[base(p)]; if (t === undefined) throw new Error('Arquivo indisponível na demonstração: ' + p); return t; },
              existsSync: (p) => base(p) in files,
              mkdirSync() {}, writeFileSync() {}, unlinkSync() {},
            };`,
          loader: 'js',
        };
      }
      if (args.path === 'path') {
        return {
          contents: `module.exports = {
              sep: '/',
              join: (...p) => p.filter(Boolean).join('/').replace(/\\/+/g, '/'),
              normalize: (p) => p, dirname: (p) => String(p).replace(/\\/[^/]*$/, ''),
              basename: (p) => String(p).split('/').pop(), extname: (p) => (/\\.[^./]*$/.exec(p) || [''])[0],
              resolve: (...p) => p.join('/'),
            };`,
          loader: 'js',
        };
      }
      if (args.path === 'qrcode') return { contents: 'module.exports = { toDataURL: async () => "" };', loader: 'js' };
      return { contents: 'module.exports = {};', loader: 'js' };
    });
  },
};

// Endereços absolutos (/img, /js, /version...) viram relativos: no GitHub Pages o site fica em /GesToque/.
const PAGES = { version: 'novidades.html', novidades: 'novidades.html', duvidas: 'duvidas.html', duvidasdev: 'duvidasdev.html', partner: 'partner.html' };
function rewrite(text, ext) {
  const up = ext === '.css' ? '../' : './';
  return text
    .replace(/(["'`(])\/(img|js|css)\//g, `$1${up}$2/`)
    .replace(/(href=["'])\/(version|novidades|duvidas|duvidasdev|partner)(["'])/g, (m, a, page, b) => `${a}${PAGES[page]}${b}`)
    .replace(/href="\/"/g, 'href="./"')
    .replace(/location\.assign\('\/'\)/g, "location.assign('./')");
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (/\.(html|js|css)$/.test(entry.name)) {
      let text = rewrite(fs.readFileSync(src, 'utf8'), path.extname(entry.name));
      // O script da demo entra antes de todos os outros: ele responde as chamadas /api/ no lugar do servidor.
      if (entry.name.endsWith('.html')) text = text.replace('</head>', '  <script src="./js/demo.js"></script>\n</head>');
      fs.writeFileSync(dst, text);
    } else fs.copyFileSync(src, dst);
  }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(PUBLIC, OUT);
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'demo', 'navegador.js')],
    outfile: path.join(OUT, 'js', 'demo.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { GT_VERSAO: JSON.stringify(VERSION), 'process.env': '{}', 'import.meta.url': 'document.baseURI', __dirname: '"/server"' },
    plugins: [demoPlugin],
    logLevel: 'warning',
  });
  fs.mkdirSync(path.join(OUT, 'pglite'), { recursive: true });
  for (const f of ['postgres.wasm', 'postgres.data']) fs.copyFileSync(path.join(PGLITE, 'dist', f), path.join(OUT, 'pglite', f));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // GitHub Pages: servir os arquivos como estão
  const size = fs.statSync(path.join(OUT, 'js', 'demo.js')).size;
  console.log(`Demonstração v${VERSION} gerada em demo-site/ (js/demo.js: ${(size / 1024).toFixed(0)} KB).`);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
