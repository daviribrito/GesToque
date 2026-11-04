// Banco da demonstração: o mesmo Postgres (PGlite), rodando dentro do navegador e guardado no IndexedDB
// deste navegador. Nada sai do aparelho. Mesma interface de server/db.js (query, tx, kind).
const { PGlite } = require('@electric-sql/pglite');
const { SCHEMA } = require('../server/db');

const DB_NAME = 'gestoque-demo';
// Fotos de perfil da demonstração (no sistema real ficam no Supabase Storage; ver demo/photos.js).
const DEMO_SCHEMA = `
create table if not exists gestoque.demo_fotos (key text primary key, type text not null, data bytea not null);
`;

let pg = null;
let starting = null;

// Os arquivos do Postgres (wasm e dados iniciais) ficam em pglite/, ao lado da página.
async function connect(base) {
  const [wasmModule, fsBundle] = await Promise.all([
    WebAssembly.compileStreaming(fetch(new URL('pglite/postgres.wasm', base))),
    fetch(new URL('pglite/postgres.data', base)).then((r) => r.blob()),
  ]);
  pg = await PGlite.create(`idb://${DB_NAME}`, { wasmModule, fsBundle });
  await pg.exec(SCHEMA);
  await pg.exec(DEMO_SCHEMA);
}

function init(base) {
  if (!starting) starting = connect(base).catch((err) => { starting = null; throw err; });
  return starting;
}

// Apaga tudo: fecha o banco e remove o IndexedDB. A página recarrega em seguida.
async function wipe() {
  if (pg) await pg.close().catch(() => {});
  pg = null;
  // O PGlite dá ao IndexedDB um nome derivado de DB_NAME (ex.: /pglite/gestoque-demo).
  const names = indexedDB.databases
    ? (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.includes(DB_NAME))
    : [`/pglite/${DB_NAME}`];
  await Promise.all(names.map((name) => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  })));
}

module.exports = {
  init,
  wipe,
  kind: () => 'demo',
  query: async (text, params) => { await starting; return pg.query(text, params); },
  exec: async (text) => { await starting; return pg.exec(text); },
  tx: async (fn) => {
    await starting;
    return pg.transaction((t) => fn({ query: (text, params, opts) => t.query(text, params, opts) }));
  },
  close: () => pg && pg.close(),
};
