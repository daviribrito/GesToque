// Registro da API (tabela gestoque.api_logs, tela /partner). Leve de propósito: grava as ações
// (POST, PUT, PATCH, DELETE), as exportações e qualquer pedido que deu erro. Consultas normais (GET)
// e o aviso de uso da tela (/api/eu/ativo, a cada minuto) não entram.
const db = require('./db');
const { HttpError } = require('./security');

const KEEP_DAYS = 90;
const MAX_JSON = 16000; // bytes por pedido/resposta; acima disso guarda só um trecho
const SECRET_KEYS = /^(password|senha|current|next|again|code|codigo|secret|token|qr|pass_hash|totp_secret)$/i;

// Nunca gravados, nem com erro: o aviso de uso da tela e a busca da foto do perfil (que o sistema faz sozinho
// ao abrir o Perfil). Da foto, ficam só inserir/trocar (PUT) e remover (DELETE).
const NEVER_LOG = new Set(['POST /api/eu/ativo', 'GET /api/eu/foto']);

function shouldLog(method, path, status) {
  if (NEVER_LOG.has(`${method} ${path}`)) return false;
  if (method !== 'GET') return true;
  return status >= 400 || /\/exportar$/.test(path);
}

// Troca senhas, códigos e tokens por *** em qualquer nível do JSON, e imagens embutidas (data URL,
// ex.: foto do perfil) por um resumo com o tamanho.
function redact(value) {
  if (typeof value === 'string' && value.startsWith('data:') && value.length > 100) {
    return `[imagem ${value.slice(5, value.indexOf(';')) || ''}, ${value.length} caracteres, não guardada]`;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) && v != null && v !== '' ? '***' : redact(v);
    return out;
  }
  return value;
}

function fit(value) {
  if (value === undefined) return null;
  const text = JSON.stringify(redact(value));
  if (text === undefined) return null;
  if (text.length <= MAX_JSON) return JSON.parse(text);
  return { _resumido: true, _tamanho_bytes: text.length, trecho: text.slice(0, 2000) + '…' };
}

// Apaga registros com mais de KEEP_DAYS dias. No Supabase quem faz isso todo dia é o pg_cron (ver SCHEMA em
// db.js); esta é a reserva (banco local, ou se o agendador falhar): roda na primeira gravação e depois no
// máximo a cada 6 horas por instância do servidor. Com o índice por data, é rápido.
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;
let lastCleanup = 0;
async function cleanup() {
  if (Date.now() - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = Date.now();
  await db.query(`delete from gestoque.api_logs where created_at < now() - interval '${KEEP_DAYS} days'`);
}

// Grava o registro de uma chamada. Nunca derruba a resposta: erro aqui só vai para o console.
async function write(entry, status, response) {
  if (entry.done) return;
  entry.done = true;
  if (!shouldLog(entry.method, entry.path, status)) return;
  try {
    const u = entry.user;
    const name = u ? `${u.name} (${u.username})` : entry.userHint || null;
    await db.query(
      `insert into gestoque.api_logs (user_id, user_name, method, path, status, duration_ms, ip, request, response)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        u ? u.id : null,
        name,
        entry.method,
        entry.fullPath.slice(0, 500),
        status,
        Date.now() - entry.started,
        entry.ip,
        JSON.stringify(fit(entry.request)),
        JSON.stringify(fit(response)),
      ]
    );
    await cleanup();
  } catch (err) {
    console.error('Registro da API:', err.message);
  }
}

// Trabalho que não precisa segurar a resposta (gravar o registro, renovar a sessão).
// Na Vercel, waitUntil mantém a função viva até terminar depois que a resposta sai; se não houver,
// espera antes de responder para não perder nada. No computador roda em segundo plano.
function afterReply(promises) {
  const pending = Promise.all(promises.map((p) => Promise.resolve(p).catch((err) => console.error(err.message))));
  const vercel = globalThis[Symbol.for('@vercel/request-context')];
  const ctx = vercel && typeof vercel.get === 'function' ? vercel.get() : null;
  if (ctx && typeof ctx.waitUntil === 'function') return ctx.waitUntil(pending);
  if (process.env.VERCEL) return pending;
  return undefined;
}

// ---------- Consulta (só admin) ----------

// Lista sem o JSON (fica leve); o pedido e a resposta completos vêm em detail().
async function list(ctx) {
  const p = ctx.url.searchParams;
  const where = [];
  const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  const before = Number(p.get('antes'));
  if (before > 0) add('id < ?', before);
  const result = p.get('resultado');
  if (result === 'sucesso') where.push('status < 400');
  if (result === 'erro') where.push('status >= 400');
  if (result === 'negado') where.push('status in (401, 403, 423, 429)');
  const method = String(p.get('metodo') || '').toUpperCase();
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) add('method = ?', method);
  const q = String(p.get('busca') || '').trim().slice(0, 80);
  if (q) {
    args.push(`%${q}%`);
    where.push(`(path ilike $${args.length} or coalesce(user_name, '') ilike $${args.length})`);
  }
  const from = p.get('de');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) add("created_at >= (?::date::timestamp at time zone 'America/Sao_Paulo')", from);
  const to = p.get('ate');
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) add("created_at < ((?::date + 1)::timestamp at time zone 'America/Sao_Paulo')", to);
  const { rows } = await db.query(
    `select id, created_at, user_id, user_name, method, path, status, duration_ms, ip
       from gestoque.api_logs ${where.length ? 'where ' + where.join(' and ') : ''}
      order by id desc limit 51`,
    args
  );
  return { logs: rows.slice(0, 50), more: rows.length > 50, keep_days: KEEP_DAYS };
}

async function detail(ctx) {
  const { rows } = await db.query('select * from gestoque.api_logs where id = $1', [Number(ctx.params[0])]);
  if (!rows[0]) throw new HttpError(404, 'Registro não encontrado.');
  return { log: rows[0] };
}

module.exports = { write, afterReply, list, detail };
