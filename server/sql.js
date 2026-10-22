// Consulta SQL dos admins (tela "Consulta SQL"). Só leitura, em camadas:
//  1. a consulta roda com SET LOCAL ROLE gestoque_leitura (papel criado no SCHEMA, só SELECT, sem segredos);
//  2. numa transação READ ONLY, com tempo máximo e no máximo MAX_ROWS linhas;
//  3. um comando só (protocolo estendido do Postgres recusa vários) e só SELECT / WITH / TABLE / VALUES;
//  4. sem funções que troquem de papel ou executem outro SQL dentro da consulta.
// Cada execução fica no Registro da API (/partner), com o SQL enviado.
const db = require('./db');
const { HttpError } = require('./security');

const READER = 'gestoque_leitura';
const MAX_ROWS = 1000;
const TIMEOUT = '8s';
const MAX_SQL = 10000;
const WRAP = 'select * from (\n'; // envolve a consulta da pessoa (ver run)

// Tabelas que o papel de leitura enxerga (colunas da users limitadas no próprio banco).
const TABLES = ['items', 'movements', 'overrides', 'settings', 'users', 'user_requests', 'removed_items',
  'removed_items_history', 'removed_items_purchases', 'api_logs'];
const USERS_COLUMNS = ['id', 'username', 'name', 'role', 'active', 'totp_enabled', 'failed_logins', 'locked_until',
  'created_at', 'keep_alive', 'code_failures', 'code_locked', 'tutorial_seen_at'];

// Funções que trocariam o papel no meio da consulta ou rodariam outro SQL por dentro: bloqueadas.
const BLOCKED = /\b(set_config|query_to_xml\w*|query_to_xmlschema|table_to_xml\w*|cursor_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|ts_stat|dblink\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|lo_\w+|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory\w*)\s*\(/i;

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

function check(raw) {
  const sql = String(raw || '').trim().replace(/;\s*$/, '');
  if (!sql) throw new HttpError(400, 'Escreva uma consulta. Ex.: SELECT * FROM items WHERE cost >= 3');
  if (sql.length > MAX_SQL) throw new HttpError(400, 'Consulta grande demais (limite de 10 mil caracteres).');
  const plain = stripComments(sql).trim();
  if (!/^(select|with|table|values)\b/i.test(plain)) {
    throw new HttpError(400, 'Só consultas de leitura: comece com SELECT (ou WITH). Alterar dados pela consulta não é permitido.');
  }
  if (plain.includes(';')) throw new HttpError(400, 'Uma consulta por vez: tire o ";" do meio.');
  const bad = BLOCKED.exec(plain);
  if (bad) throw new HttpError(400, `A função ${bad[1]} não é permitida na consulta.`);
  return sql;
}

function translate(err) {
  const m = String(err.message || '');
  if (err.code === '57014' || /statement timeout/i.test(m)) return `A consulta passou de ${TIMEOUT.replace('s', ' segundos')}. Use filtros (WHERE) ou LIMIT.`;
  if (err.code === '42501' || /permission denied/i.test(m)) return `Dado protegido: ${m}. Senhas, segredos do autenticador e sessões não podem ser lidos.`;
  if (err.code === '25006' || /read-only transaction/i.test(m)) return 'Só leitura: esta consulta tenta alterar dados.';
  if (/role .*gestoque_leitura|permission denied to set role/i.test(m)) return 'O papel de leitura não está configurado neste banco. Reinicie o sistema ou fale com quem administra o banco.';
  let x = /relation "([^"]+)" does not exist/i.exec(m);
  if (x) return `A tabela "${x[1]}" não existe. Veja a lista de tabelas ao lado (ex.: items, movements).`;
  x = /column "([^"]+)" does not exist/i.exec(m);
  if (x) return `A coluna "${x[1]}" não existe. Abra a tabela na lista ao lado para ver as colunas (ex.: o preço do item é "cost").`;
  // A posição conta a partir da consulta da pessoa (tira o "select * from (" que envolve a consulta).
  const at = Number(err.position) - WRAP.length;
  return `Erro no SQL: ${m}${at > 0 ? ` (perto do caractere ${at})` : ''}`;
}

const plainValue = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object' && !Array.isArray(v)) return v; // json
  return v;
};

async function run(ctx) {
  const sql = check(ctx.body.sql);
  const started = Date.now();
  let result;
  try {
    result = await db.tx(async (q) => {
      await q.query('set transaction read only');
      await q.query(
        `select set_config('statement_timeout', $1, true), set_config('search_path', 'gestoque', true), set_config('role', $2, true)`,
        [TIMEOUT, READER]
      );
      // Envolver numa subconsulta limita as linhas e impede que a consulta "escape" para outro comando.
      return q.query(`${WRAP}${sql}\n) as consulta limit ${MAX_ROWS + 1}`, [], { rowMode: 'array' });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, translate(err));
  }
  const columns = (result.fields || []).map((f) => f.name);
  const rows = (result.rows || []).slice(0, MAX_ROWS).map((r) => r.map(plainValue));
  const truncated = result.rows.length > MAX_ROWS;
  const ms = Date.now() - started;
  // O resultado é volátil: vai só para a tela. O Registro da API guarda o SQL (no pedido) e este resumo,
  // nunca as linhas que voltaram.
  ctx.logResponse = { resultado: 'não guardado', linhas: rows.length, colunas: columns, truncado: truncated, ms };
  return { columns, rows, truncated, max_rows: MAX_ROWS, ms };
}

// Tabelas e colunas que a consulta enxerga, para a lista ao lado do editor.
async function tables() {
  const { rows } = await db.query(
    `select table_name, column_name, data_type
       from information_schema.columns
      where table_schema = 'gestoque' and table_name = any($1)
      order by table_name, ordinal_position`,
    [TABLES]
  );
  const out = new Map(TABLES.map((t) => [t, []]));
  for (const r of rows) {
    if (r.table_name === 'users' && !USERS_COLUMNS.includes(r.column_name)) continue;
    out.get(r.table_name).push({ name: r.column_name, type: r.data_type });
  }
  return { tables: [...out].filter(([, cols]) => cols.length).map(([name, columns]) => ({ name, columns })), max_rows: MAX_ROWS, timeout: TIMEOUT };
}

module.exports = { run, tables, check };
