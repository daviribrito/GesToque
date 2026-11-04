// Login da demonstração (no lugar das partes de login de server/auth.js; o resto é o mesmo código).
// Qualquer usuário e senha entram, até vazios. O 2FA é um código fixo, mostrado na tela e preenchido sozinho.
// A "sessão" é só o id do usuário guardado neste navegador. NUNCA usar isto no sistema real.
const real = require('../server/auth');
const db = require('./db');
const { HttpError } = require('./security');

const DEMO_CODE = '123456';
const SESSION_KEY = 'gt_demo_sessao';
const PENDING_KEY = 'gt_demo_pendente';
const VISITOR = 'visitante';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento: vale até recarregar */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

// Usuário digitado que existe (ex.: "gestor") entra como ele; qualquer outra coisa entra como o visitante (admin).
async function pickUser(username) {
  const name = String(username || '').trim().toLowerCase();
  const { rows } = await db.query(
    'select id from gestoque.users where active and username = any($1::text[]) order by (username = $2) desc limit 1',
    [[name, VISITOR], name]
  );
  return rows[0] ? rows[0].id : null;
}

async function login(ctx) {
  const id = await pickUser(ctx.body.username);
  if (!id) throw new HttpError(500, 'O usuário da demonstração não existe. Use "Recomeçar demonstração".');
  store.set(PENDING_KEY, String(id));
  return { step: 'codigo', demo_code: DEMO_CODE };
}

async function verifyCode(ctx) {
  const id = Number(store.get(PENDING_KEY));
  if (!id) throw new HttpError(401, 'Sua tentativa de entrada expirou. Informe usuário e senha de novo.');
  if (String(ctx.body.code || '').trim() !== DEMO_CODE) {
    throw new HttpError(401, `Código incorreto. Na demonstração o código é sempre ${DEMO_CODE}.`);
  }
  store.del(PENDING_KEY);
  store.set(SESSION_KEY, String(id));
  const s = await loadSession();
  return { user: real.publicUser(s), token: 'demo' };
}

async function loadSession() {
  const id = Number(store.get(SESSION_KEY));
  if (!id) return null;
  const { rows } = await db.query('select *, true as mfa_ok, $2::text as token_hash from gestoque.users where id = $1 and active', [id, 'demo']);
  return rows[0] || null;
}

async function me() {
  const s = await loadSession();
  return s ? { user: real.publicUser(s), token: 'demo' } : { user: null };
}

async function logout() {
  store.del(SESSION_KEY);
  store.del(PENDING_KEY);
  return { ok: true };
}

async function changeOwnPassword() {
  throw new HttpError(400, 'Na demonstração não há senha: o login aceita qualquer usuário e senha.');
}

async function setPreferences(ctx) {
  const keep = Boolean(ctx.body.keep_alive);
  await db.query('update gestoque.users set keep_alive = $2 where id = $1', [ctx.user.id, keep]);
  return { user: real.publicUser({ ...ctx.user, keep_alive: keep }) };
}

module.exports = {
  ...real,
  DEMO_CODE,
  VISITOR,
  login,
  verifyCode,
  loadSession,
  checkApiToken: () => true,
  touchSession: async () => {},
  me,
  logout,
  changeOwnPassword,
  setPreferences,
};
