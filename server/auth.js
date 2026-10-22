const QRCode = require('qrcode');
const db = require('./db');
const config = require('./config');
const sec = require('./security');
const photos = require('./photos');
const { HttpError } = sec;

const COOKIE = 'gt_sessao';
const DEVICE_COOKIE = 'gt_aparelho';
const PENDING_MS = 10 * 60 * 1000; // senha conferida, falta o código
const IDLE_MINUTES = 45; // sem uso por esse tempo, a sessão termina
const IDLE_MS = IDLE_MINUTES * 60 * 1000;
const KEEP_MS = 400 * 24 * 60 * 60 * 1000; // "Manter ativo": na prática, não expira
const MAX_FAILS = 5; // erros de senha seguidos antes do bloqueio de 15 min
const LOCK_MS = 15 * 60 * 1000;

// Código do autenticador errado: espera de 10 s, 100 s e 1000 s após o 1º, 2º e 3º erro.
// O 4º erro bloqueia o acesso de vez, até um admin liberar. Só um código certo zera a contagem.
// GT_ESPERAS_CODIGO (ex.: "1,2,3") troca as esperas: serve para testar sem esperar 18 minutos.
const CODE_WAITS = (process.env.GT_ESPERAS_CODIGO || '10,100,1000').split(',').map(Number);
const BLOCKED_MESSAGE = 'Acesso bloqueado por erros seguidos no código do autenticador. Peça a um admin para liberar.';

// Hash fixo para gastar o mesmo tempo quando o usuário não existe.
const dummyHash = sec.hashPassword('senha-que-nao-existe');

function readCookie(req, name = COOKIE) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// Acrescenta um cookie à resposta sem apagar os que já foram definidos nela.
function addCookie(res, name, value, maxAgeMs) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  // Em https (Vercel informa pelo x-forwarded-proto) o cookie só trafega criptografado.
  const https = res.req && res.req.headers['x-forwarded-proto'] === 'https';
  if (config.PRODUCTION || https) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), parts.join('; ')]);
}
const setCookie = (res, token, maxAgeMs) => addCookie(res, COOKIE, token, maxAgeMs);

// Identifica o navegador (aparelho) por um cookie próprio, que sobrevive à saída do sistema.
function deviceId(req, res) {
  let id = readCookie(req, DEVICE_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
    id = sec.newToken();
    addCookie(res, DEVICE_COOKIE, id, KEEP_MS);
  }
  return id;
}

const sessionMs = (user) => (user.keep_alive ? KEEP_MS : IDLE_MS);

// Token de acesso da API: entregue à tela depois do login completo (senha + código) e exigido no
// cabeçalho "Authorization: Bearer ..." em toda rota que pede login, GET ou não. É derivado do cookie
// de sessão (HttpOnly, que o JavaScript não lê): só quem tem a sessão e recebeu o token pela própria
// tela consegue chamar a API. Vale para todas as abas da mesma sessão e morre junto com ela.
const apiToken = (sessionToken) => sec.hashToken('api:' + sessionToken);

function checkApiToken(req) {
  const session = readCookie(req);
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!session || !m) return false;
  return sec.sameText(m[1], apiToken(session));
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  keep_alive: u.keep_alive,
  idle_minutes: IDLE_MINUTES,
});

async function loadSession(req) {
  const token = readCookie(req);
  if (!token) return null;
  const { rows } = await db.query(
    `select s.token_hash, s.mfa_ok, s.expires_at as session_expires, u.*
       from gestoque.sessions s join gestoque.users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.active`,
    [sec.hashToken(token)]
  );
  return rows[0] || null;
}

// Cada uso do sistema empurra o fim da sessão: 45 min depois do último uso, ou bem longe com "Manter ativo".
// Grava no máximo uma vez por minuto.
async function touchSession(s) {
  if (!s || !s.mfa_ok) return;
  const want = Date.now() + sessionMs(s);
  if (want - new Date(s.session_expires).getTime() < 60000) return;
  await db.query('update gestoque.sessions set expires_at = $2 where token_hash = $1', [s.token_hash, new Date(want)]);
}

async function registerFailure(user) {
  const fails = user.failed_logins + 1;
  const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null;
  await db.query('update gestoque.users set failed_logins = $2, locked_until = $3 where id = $1', [
    user.id,
    lock ? 0 : fails,
    lock,
  ]);
}

function waitText(seconds) {
  if (seconds < 120) return `${seconds} segundos`;
  return `${Math.ceil(seconds / 60)} minutos`;
}

// Erro de espera: além do texto pronto, manda os segundos e o modelo da frase ({tempo} = o que falta),
// para a tela mostrar a contagem regressiva ao vivo.
function waitError(status, template, seconds) {
  return new HttpError(status, template.replace('{tempo}', waitText(seconds)), { retry_in: seconds, message_template: template });
}

// codeLock: false na etapa da senha, para o bloqueio permanente só ser revelado a quem acertou a senha.
function assertNotLocked(user, { codeLock = true } = {}) {
  if (codeLock && user.code_locked) throw new HttpError(423, BLOCKED_MESSAGE);
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const seconds = Math.ceil((new Date(user.locked_until) - Date.now()) / 1000);
    throw waitError(429, 'Muitas tentativas. Tente de novo em {tempo}.', seconds);
  }
}

// Código errado: aplica a próxima espera da escada, ou o bloqueio permanente. Sempre termina com erro.
async function registerCodeFailure(user) {
  const n = user.code_failures + 1;
  if (n > CODE_WAITS.length) {
    await db.query('update gestoque.users set code_failures = $2, code_locked = true, locked_until = null where id = $1', [user.id, n]);
    await db.query('delete from gestoque.sessions where user_id = $1 and not mfa_ok', [user.id]);
    throw new HttpError(423, BLOCKED_MESSAGE);
  }
  const wait = CODE_WAITS[n - 1];
  await db.query('update gestoque.users set code_failures = $2, locked_until = $3 where id = $1', [
    user.id,
    n,
    new Date(Date.now() + wait * 1000),
  ]);
  const last = n === CODE_WAITS.length ? ' Mais um erro bloqueia o acesso até um admin liberar.' : '';
  throw waitError(401, `Código incorreto ou já usado. Espere {tempo} para tentar de novo.${last}`, wait);
}

async function enrollPayload(user, secret) {
  const qr = await QRCode.toDataURL(sec.totpUri(secret, user.username, config.STORE_NAME), {
    margin: 1,
    width: 220,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return { step: 'ativar', secret, qr };
}

async function login(ctx) {
  const username = String(ctx.body.username || '').trim().toLowerCase();
  const password = String(ctx.body.password || '');
  const wrong = new HttpError(401, 'Usuário ou senha incorretos.');
  if (!username || !password) throw wrong;

  const user = (await db.query('select * from gestoque.users where username = $1', [username])).rows[0];
  if (!user) {
    await sec.verifyPassword(password, await dummyHash);
    throw wrong;
  }
  assertNotLocked(user, { codeLock: false });
  if (!(await sec.verifyPassword(password, user.pass_hash)) || !user.active) {
    await registerFailure(user);
    throw wrong;
  }
  if (user.code_locked) throw new HttpError(423, BLOCKED_MESSAGE);
  if (user.failed_logins) await db.query('update gestoque.users set failed_logins = 0 where id = $1', [user.id]);

  await db.query('delete from gestoque.sessions where expires_at < now()');
  const token = sec.newToken();
  await db.query(
    'insert into gestoque.sessions (token_hash, user_id, mfa_ok, expires_at, device_id) values ($1, $2, false, $3, $4)',
    [sec.hashToken(token), user.id, new Date(Date.now() + PENDING_MS), deviceId(ctx.req, ctx.res)]
  );
  setCookie(ctx.res, token, PENDING_MS);

  // Os erros de código têm contagem própria (code_failures), que a senha certa não zera:
  // só um código certo zera. Assim, saber a senha não libera novas tentativas de código.
  if (user.totp_enabled) return { step: 'codigo' };
  const secret = sec.newTotpSecret();
  await db.query('update gestoque.users set totp_secret = $2 where id = $1', [user.id, secret]);
  return enrollPayload(user, secret);
}

// Confere o código do autenticador. No primeiro acesso, também ativa a verificação em duas etapas.
async function verifyCode(ctx) {
  const s = await loadSession(ctx.req);
  if (!s) throw new HttpError(401, 'Sua tentativa de entrada expirou. Informe usuário e senha de novo.');
  assertNotLocked(s);
  const step = sec.verifyTotp(s.totp_secret, ctx.body.code, Number(s.last_totp_step));
  if (!step) await registerCodeFailure(s);
  // Marca o código como usado de forma atômica: se outra requisição usou o mesmo código
  // no mesmo instante, só uma consegue gravar, e a outra é recusada.
  const used = await db.query(
    `update gestoque.users set totp_enabled = true, last_totp_step = $2, failed_logins = 0, code_failures = 0, locked_until = null
      where id = $1 and last_totp_step < $2 and not code_locked returning id`,
    [s.id, step]
  );
  if (!used.rows.length) await registerCodeFailure(s);
  // Troca o token ao concluir a entrada e encerra as sessões anteriores deste usuário neste mesmo navegador.
  const device = deviceId(ctx.req, ctx.res);
  const token = sec.newToken();
  await db.query('delete from gestoque.sessions where user_id = $1 and (token_hash = $2 or device_id = $3)', [
    s.id,
    s.token_hash,
    device,
  ]);
  await db.query(
    'insert into gestoque.sessions (token_hash, user_id, mfa_ok, expires_at, device_id) values ($1, $2, true, $3, $4)',
    [sec.hashToken(token), s.id, new Date(Date.now() + sessionMs(s)), device]
  );
  // O cookie dura bastante; quem decide o fim da sessão é o servidor, pelo tempo sem uso.
  setCookie(ctx.res, token, KEEP_MS);
  return { user: publicUser(s), token: apiToken(token) };
}

// Chamado pela tela quando a pessoa mexe no sistema sem gerar outra requisição (digitando, rolando).
async function ping() {
  return { ok: true };
}

async function setPreferences(ctx) {
  const keep = Boolean(ctx.body.keep_alive);
  await db.query('update gestoque.users set keep_alive = $2 where id = $1', [ctx.user.id, keep]);
  await db.query('update gestoque.sessions set expires_at = $2 where token_hash = $1', [
    ctx.user.token_hash,
    new Date(Date.now() + (keep ? KEEP_MS : IDLE_MS)),
  ]);
  return { user: publicUser({ ...ctx.user, keep_alive: keep }) };
}

async function logout(ctx) {
  const token = readCookie(ctx.req);
  if (token) await db.query('delete from gestoque.sessions where token_hash = $1', [sec.hashToken(token)]);
  setCookie(ctx.res, '', 0);
  return { ok: true };
}

// Rota aberta: sem sessão devolve user null em vez de erro. Com sessão completa, devolve também o
// token de acesso, para a tela recuperá-lo ao recarregar (outro site não consegue ler esta resposta).
async function me(ctx) {
  const s = await loadSession(ctx.req);
  if (!s || !s.mfa_ok) return { user: null };
  return { user: publicUser(s), token: apiToken(readCookie(ctx.req)) };
}

// ---------- Perfil (cada um vê o próprio) ----------
// Separado de /api/eu, que a tela consulta a cada minuto. A foto não vem junto: vem só o endereço com a
// versão (/api/eu/foto?v=N), que o navegador guarda em cache até a foto mudar. Arquivos em server/photos.js.
// Registro da API (/partner): grava só inserir, trocar e remover foto; buscar a foto nunca é gravado.

const photoKey = (userId) => `usuarios/${userId}`;
// O id no endereço separa o cache de cada pessoa no mesmo navegador (sem ele, quem entra depois veria a foto
// do anterior). O servidor ignora os parâmetros: entrega sempre a foto de quem está logado.
const photoUrl = (u) => (u.photo_key || u.legacy ? `/api/eu/foto?u=${u.id}&v=${u.photo_version}` : null);

// Grava a foto no Storage e só então aponta o usuário para ela, com versão nova.
// Devolve também se já havia foto (para o registro dizer "inserida" ou "trocada").
async function storePhoto(userId, { buffer, type }) {
  const key = photoKey(userId);
  await photos.put(key, buffer, type);
  const { rows } = await db.query(
    `update gestoque.users u set photo_key = $2, photo_type = $3, photo_version = u.photo_version + 1, photo = null
       from (select photo_key is not null or photo is not null as had from gestoque.users where id = $1) old
      where u.id = $1 returning u.id, u.photo_key, u.photo_version, old.had`,
    [userId, key, type]
  );
  return rows[0];
}

async function profile(ctx) {
  const { rows } = await db.query(
    `select id, name, username, role, created_at, photo_key, photo_version, (photo is not null) as legacy
       from gestoque.users where id = $1`,
    [ctx.user.id]
  );
  const u = rows[0];
  // Foto da primeira versão (dentro do banco): leva para o Storage uma vez e apaga do banco.
  // É manutenção do sistema, não ação da pessoa: não entra no registro (a leitura do perfil é GET).
  if (u.legacy && photos.provider()) {
    try {
      const old = (await db.query('select photo from gestoque.users where id = $1', [u.id])).rows[0].photo;
      const saved = await storePhoto(u.id, photos.decode(old));
      Object.assign(u, { photo_key: saved.photo_key, photo_version: saved.photo_version, legacy: false });
    } catch (err) {
      console.error('Foto antiga não migrada:', err.message);
    }
  }
  const { photo_key, photo_version, legacy, ...rest } = u;
  return { profile: { ...rest, photo: photoUrl(u) } };
}

// Inserir ou trocar a foto. A tela manda a foto já reduzida (256x256 JPG); a imagem nunca vai para o registro.
async function setPhoto(ctx) {
  const { buffer, type } = photos.decode(ctx.body.photo);
  const saved = await storePhoto(ctx.user.id, { buffer, type });
  ctx.logResponse = { foto: saved.had ? 'trocada' : 'inserida', versao: saved.photo_version, tipo: type, bytes: buffer.length };
  return { photo: photoUrl(saved) };
}

// Entrega a foto de quem está logado. Cache privado de 1 ano: o endereço muda (v=N) quando a foto muda.
// Nunca entra no registro (ver logs.js, NEVER_LOG).
async function getPhoto(ctx) {
  const u = (await db.query('select photo_key, photo_type, photo from gestoque.users where id = $1', [ctx.user.id])).rows[0];
  let buffer = null;
  let type = u.photo_type;
  if (u.photo_key) buffer = await photos.get(u.photo_key);
  else if (u.photo) ({ buffer, type } = photos.decode(u.photo)); // primeira versão, ainda no banco
  if (!buffer) throw new HttpError(404, 'Sem foto.');
  return { file: buffer, type, name: 'foto', inline: true, cache: 'private, max-age=31536000, immutable' };
}

// Cada um pode trocar o próprio nome (o que aparece no sistema). Login, perfil e situação só o admin muda.
async function setOwnName(ctx) {
  const name = cleanName(ctx.body.name);
  await db.query('update gestoque.users set name = $2 where id = $1', [ctx.user.id, name]);
  return { name };
}

// Remover a foto: primeiro o usuário deixa de apontar para ela, depois o arquivo é apagado do Storage.
async function removePhoto(ctx) {
  const { rows } = await db.query(
    `update gestoque.users u set photo_key = null, photo_type = null, photo = null, photo_version = u.photo_version + 1
       from (select photo_key, photo_key is not null or photo is not null as had from gestoque.users where id = $1) old
      where u.id = $1 returning old.photo_key, old.had`,
    [ctx.user.id]
  );
  const { photo_key: key, had } = rows[0] || {};
  if (key) await photos.remove(key).catch((err) => console.error('Foto não apagada do Storage:', err.message));
  ctx.logResponse = { foto: had ? 'removida' : 'não havia foto' };
  return { ok: true };
}

async function changeOwnPassword(ctx) {
  const current = String(ctx.body.current || '');
  const next = String(ctx.body.next || '');
  if (!(await sec.verifyPassword(current, ctx.user.pass_hash))) throw new HttpError(400, 'A senha atual não confere.');
  sec.checkPasswordRules(next);
  await db.query('update gestoque.users set pass_hash = $2 where id = $1', [ctx.user.id, await sec.hashPassword(next)]);
  // Encerra as outras sessões deste usuário.
  await db.query('delete from gestoque.sessions where user_id = $1 and token_hash <> $2', [ctx.user.id, ctx.user.token_hash]);
  return { ok: true };
}

// ---------- Usuários (somente admin) ----------

function cleanUsername(raw) {
  const username = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'O usuário deve ter de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.');
  }
  return username;
}

function cleanRole(raw) {
  if (raw !== 'admin' && raw !== 'gestor') throw new HttpError(400, 'Perfil inválido.');
  return raw;
}

function cleanName(raw) {
  const name = String(raw || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Informe o nome.');
  return name;
}

async function listUsers() {
  const { rows } = await db.query(
    'select id, username, name, role, active, totp_enabled, code_locked, code_failures, created_at from gestoque.users order by name'
  );
  return { users: rows };
}

// Cria o usuário e devolve o id. Usada pela criação direta e pela aprovação de uma solicitação.
async function insertUser(b) {
  const username = cleanUsername(b.username);
  const name = cleanName(b.name);
  const role = cleanRole(b.role);
  sec.checkPasswordRules(b.password);
  const exists = await db.query('select 1 from gestoque.users where username = $1', [username]);
  if (exists.rows.length) throw new HttpError(409, 'Já existe um usuário com esse login.');
  const { rows } = await db.query(
    'insert into gestoque.users (username, name, role, pass_hash) values ($1, $2, $3, $4) returning id',
    [username, name, role, await sec.hashPassword(b.password)]
  );
  return rows[0].id;
}

async function createUser(ctx) {
  await insertUser(ctx.body);
  return { ok: true };
}

// ---------- Solicitações de novo usuário (gestor pede, admin aprova ou recusa) ----------

const REQUEST_SELECT = `select r.id, r.name, r.username, r.role, r.note, r.status, r.decision_note,
         r.created_at, r.decided_at, coalesce(p.name, '') as requested_by_name, coalesce(d.name, '') as decided_by_name
    from gestoque.user_requests r
    left join gestoque.users p on p.id = r.requested_by
    left join gestoque.users d on d.id = r.decided_by`;

async function createRequest(ctx) {
  const name = cleanName(ctx.body.name);
  const username = cleanUsername(ctx.body.username);
  const role = cleanRole(ctx.body.role || 'gestor');
  const note = String(ctx.body.note || '').trim().slice(0, 300);
  if ((await db.query('select 1 from gestoque.users where username = $1', [username])).rows.length) {
    throw new HttpError(409, 'Já existe um usuário com esse login. Escolha outro.');
  }
  const pending = await db.query("select 1 from gestoque.user_requests where username = $1 and status = 'pendente'", [username]);
  if (pending.rows.length) throw new HttpError(409, 'Já existe uma solicitação aguardando para esse login.');
  await db.query('insert into gestoque.user_requests (requested_by, name, username, role, note) values ($1, $2, $3, $4, $5)', [
    ctx.user.id,
    name,
    username,
    role,
    note,
  ]);
  return { ok: true };
}

// Admin vê todas (as que aguardam primeiro); gestor vê só as que ele mesmo enviou.
async function listRequests(ctx) {
  const admin = ctx.user.role === 'admin';
  const { rows } = await db.query(
    `${REQUEST_SELECT} ${admin ? '' : 'where r.requested_by = $1'}
      order by (r.status = 'pendente') desc, r.created_at desc limit 100`,
    admin ? [] : [ctx.user.id]
  );
  return { requests: rows };
}

async function pendingRequests() {
  const { rows } = await db.query("select count(*)::int as n from gestoque.user_requests where status = 'pendente'");
  return { pending: rows[0].n };
}

async function pendingRequest(id) {
  const r = (await db.query('select * from gestoque.user_requests where id = $1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Solicitação não encontrada.');
  if (r.status !== 'pendente') throw new HttpError(409, 'Esta solicitação já foi respondida.');
  return r;
}

// Aprovar = criar o usuário. O admin pode corrigir nome, login e perfil e define a senha inicial.
async function approveRequest(ctx) {
  const r = await pendingRequest(Number(ctx.params[0]));
  const b = ctx.body;
  const userId = await insertUser({
    name: b.name ?? r.name,
    username: b.username ?? r.username,
    role: b.role ?? r.role,
    password: b.password,
  });
  await db.query(
    `update gestoque.user_requests set status = 'aprovada', decided_by = $2, decided_at = now(), created_user_id = $3,
            decision_note = $4 where id = $1`,
    [r.id, ctx.user.id, userId, String(b.note || '').trim().slice(0, 300)]
  );
  return { ok: true };
}

async function rejectRequest(ctx) {
  const r = await pendingRequest(Number(ctx.params[0]));
  await db.query(
    "update gestoque.user_requests set status = 'recusada', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1",
    [r.id, ctx.user.id, String(ctx.body.note || '').trim().slice(0, 300)]
  );
  return { ok: true };
}

async function updateUser(ctx) {
  const id = Number(ctx.params[0]);
  const target = (await db.query('select * from gestoque.users where id = $1', [id])).rows[0];
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const b = ctx.body;
  const name = b.name !== undefined ? cleanName(b.name) : target.name;
  const role = b.role !== undefined ? cleanRole(b.role) : target.role;
  const active = b.active !== undefined ? Boolean(b.active) : target.active;

  if (target.id === ctx.user.id && (role !== 'admin' || !active)) {
    throw new HttpError(400, 'Você não pode remover o próprio acesso de admin. Peça a outro admin.');
  }
  await db.query('update gestoque.users set name = $2, role = $3, active = $4 where id = $1', [id, name, role, active]);

  let dropSessions = !active;
  if (b.password) {
    sec.checkPasswordRules(b.password);
    await db.query('update gestoque.users set pass_hash = $2, failed_logins = 0, locked_until = null where id = $1', [
      id,
      await sec.hashPassword(b.password),
    ]);
    dropSessions = true;
  }
  // Liberar: tira o bloqueio permanente e zera as esperas. Refazer o autenticador também libera.
  if (b.unlock || b.reset2fa) {
    await db.query(
      'update gestoque.users set code_locked = false, code_failures = 0, failed_logins = 0, locked_until = null where id = $1',
      [id]
    );
  }
  if (b.reset2fa) {
    await db.query(
      'update gestoque.users set totp_secret = null, totp_enabled = false, last_totp_step = 0 where id = $1',
      [id]
    );
    dropSessions = true;
  }
  if (dropSessions && target.id !== ctx.user.id) await db.query('delete from gestoque.sessions where user_id = $1', [id]);
  return { ok: true };
}

module.exports = {
  loadSession,
  checkApiToken,
  touchSession,
  ping,
  setPreferences,
  login,
  verifyCode,
  logout,
  me,
  profile,
  setPhoto,
  getPhoto,
  removePhoto,
  setOwnName,
  changeOwnPassword,
  listUsers,
  createUser,
  updateUser,
  createRequest,
  listRequests,
  pendingRequests,
  approveRequest,
  rejectRequest,
};
