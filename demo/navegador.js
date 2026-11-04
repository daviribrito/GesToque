// Demonstração do GesToque que roda inteira no navegador, sem servidor (ex.: GitHub Pages).
// Este arquivo entra antes do app.js em todas as páginas da demo (scripts/build-demo.js) e troca o fetch:
// toda chamada a /api/... é respondida aqui, pelas mesmas rotas e o mesmo código de server/, com o
// banco Postgres (PGlite) guardado no IndexedDB deste navegador. Nada sai do aparelho.
const { Buffer } = require('buffer');
const { routes } = require('../server/app');
const logs = require('../server/logs');
const exemplo = require('../scripts/exemplo-dados');
const db = require('./db');
const auth = require('./auth');
const { HttpError } = require('./security');

globalThis.Buffer = globalThis.Buffer || Buffer;

// Pasta do site (no GitHub Pages fica em /GesToque/): este script está em js/, a raiz é a pasta acima.
const BASE = new URL('../', document.currentScript.src);

// Usuários de exemplo: o visitante (admin) e um gestor, para ver o sistema pelos dois perfis.
async function seedUsers() {
  await db.query(
    `insert into gestoque.users (username, name, role, pass_hash, totp_enabled) values
       ($1, 'Visitante', 'admin', 'demo$', true), ('gestor', 'Gestor de exemplo', 'gestor', 'demo$', true)
     on conflict (username) do nothing`,
    [auth.VISITOR]
  );
}

// Na primeira visita (ou depois de "Recomeçar"), cria os usuários e carrega o estoque de exemplo.
// Se o exemplo guardado é de uma versão anterior (exemplo.VERSION), recomeça a demonstração uma vez.
async function start() {
  await db.init(BASE);
  const saved = (await db.query("select value from gestoque.settings where key = 'demo_exemplo'")).rows[0];
  const has = (await db.query('select count(*)::int as n from gestoque.items')).rows[0].n;
  if (has && (!saved || saved.value !== exemplo.VERSION)) {
    await reset();
    return new Promise(() => {}); // a página está recarregando
  }
  await seedUsers();
  if (!has) {
    await exemplo.seed(db);
    await db.query(
      "insert into gestoque.settings (key, value) values ('demo_exemplo', $1::jsonb) on conflict (key) do update set value = excluded.value",
      [JSON.stringify(exemplo.VERSION)]
    );
  }
}

// Apaga o banco e as marcas da demo neste navegador e recarrega a página.
async function reset() {
  await db.wipe();
  try {
    // Apaga sessão, avisos vistos e alertas; mantém só o modo de cor e a posição do menu.
    const keep = new Set(['gt_tema', 'gt_menu_posicao', 'gt_menu_recolhido']);
    for (const k of Object.keys(localStorage)) if (k.startsWith('gt_') && !keep.has(k)) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch { /* sem armazenamento */ }
  location.reload();
}

const ready = start();
ready.catch((err) => console.error('Demonstração: o banco não iniciou.', err));

const json = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

// Mesmo caminho de server/app.js (handleApi), sem cookies: a sessão é a da demo (demo/auth.js).
async function handleApi(url, init) {
  const method = (init.method || 'GET').toUpperCase();
  const route = routes.find(([m, re]) => m === method && re.test(url.pathname));
  const log = {
    started: Date.now(),
    method,
    path: url.pathname,
    fullPath: url.pathname + url.search,
    ip: 'navegador (demonstração)',
    request: null,
    user: null,
    side: [],
  };
  try {
    await ready;
    if (!route) throw new HttpError(404, 'Recurso não encontrado.');
    const [, re, handler, access] = route;
    const ctx = { req: { headers: {} }, res: {}, url, params: url.pathname.match(re).slice(1), body: {}, raw: null, user: null };
    if (method !== 'GET' && init.body != null) {
      const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : init.body;
      ctx.raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      const headers = new Headers(init.headers || {});
      if ((headers.get('content-type') || '').includes('application/json') && ctx.raw.length) {
        ctx.body = JSON.parse(ctx.raw.toString('utf8')) || {};
        log.request = ctx.body;
      } else if (ctx.raw.length) log.request = { _arquivo: 'enviado', bytes: ctx.raw.length };
    }
    if (access !== 'aberto') {
      const session = await auth.loadSession();
      if (!session) throw new HttpError(401, 'Entre para continuar.');
      if (access === 'admin' && session.role !== 'admin') throw new HttpError(403, 'Apenas admin pode fazer isso.');
      ctx.user = log.user = session;
    }
    const out = await handler(ctx);
    if (!log.user && out && out.user) log.user = out.user;
    if (out && out.file) {
      await logs.write(log, 200, { _arquivo: out.name, bytes: out.file.length });
      return new Response(new Blob([out.file], { type: out.type }), {
        status: 200,
        headers: {
          'Content-Type': out.type,
          'Content-Disposition': out.inline ? 'inline' : `attachment; filename="${out.name}"`,
        },
      });
    }
    await logs.write(log, 200, ctx.logResponse || out || { ok: true });
    return json(200, out || { ok: true });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = status === 500 ? 'Algo deu errado na demonstração. Tente de novo ou use "Recomeçar demonstração".' : err.message;
    await logs.write(log, status, { error: message, ...(err.extra || {}) }).catch(() => {});
    return json(status, { error: message, ...(err.extra || {}) });
  }
}

const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  // As páginas chamam /api/... a partir da raiz do domínio; no GitHub Pages a raiz do site é outra.
  const at = url.origin === location.origin ? url.pathname.indexOf('/api/') : -1;
  if (at < 0) return realFetch(input, init);
  const local = new URL(url.pathname.slice(at) + url.search, location.origin);
  return handleApi(local, init);
};

// Usado pela tela (app.js) para avisar que é demonstração e para o botão "Recomeçar demonstração".
window.GT_DEMO = {
  code: auth.DEMO_CODE,
  ready,
  async reset() {
    await ready.catch(() => {});
    await reset();
  },
};
