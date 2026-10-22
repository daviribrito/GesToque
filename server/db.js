const fs = require('fs');
const path = require('path');
const config = require('./config');

// Tudo fica no schema "gestoque": ele não é exposto pela Data API do Supabase,
// e o RLS ligado sem políticas fecha as tabelas mesmo que alguém exponha o schema.
const SCHEMA = `
create schema if not exists gestoque;

create table if not exists gestoque.users (
  id serial primary key,
  username text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'gestor')),
  pass_hash text not null,
  totp_secret text,
  totp_enabled boolean not null default false,
  last_totp_step bigint not null default 0,
  active boolean not null default true,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists gestoque.sessions (
  token_hash text primary key,
  user_id integer not null references gestoque.users(id) on delete cascade,
  mfa_ok boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists gestoque.items (
  id serial primary key,
  sku text not null unique,
  name text not null,
  category text not null default '',
  unit text not null default 'un',
  qty numeric(14,3) not null default 0,
  min_qty numeric(14,3) not null default 0,
  cost numeric(14,2) not null default 0,
  pack_size numeric(14,3) not null default 1,
  lead_days integer not null default 7,
  supplier text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists gestoque.movements (
  id serial primary key,
  item_id integer not null references gestoque.items(id) on delete cascade,
  type text not null check (type in ('entrada', 'saida', 'ajuste')),
  delta numeric(14,3) not null,
  balance_after numeric(14,3) not null,
  unit_cost numeric(14,2),
  note text not null default '',
  user_id integer references gestoque.users(id) on delete set null,
  occurred_at timestamptz not null default now()
);
-- Sessão: "Manter ativo" por usuário e o aparelho (navegador) de cada sessão.
alter table gestoque.users add column if not exists keep_alive boolean not null default false;
-- Erros seguidos no código do autenticador e o bloqueio permanente que só um admin libera.
alter table gestoque.users add column if not exists code_failures integer not null default 0;
alter table gestoque.users add column if not exists code_locked boolean not null default false;
alter table gestoque.sessions add column if not exists device_id text;
-- Foto do perfil: o arquivo fica no Supabase Storage (bucket privado fotos-perfil) ou, no banco local, em
-- data/fotos. Aqui só o caminho, o tipo e a versão (muda a cada troca; vai no endereço para o cache do navegador).
-- photo (data URL) é da primeira versão: é levada para o Storage na primeira leitura e apagada daqui.
alter table gestoque.users add column if not exists photo text;
alter table gestoque.users add column if not exists photo_key text;
alter table gestoque.users add column if not exists photo_type text;
alter table gestoque.users add column if not exists photo_version integer not null default 0;

-- Fornecedor no momento da compra: o do cadastro pode mudar depois.
alter table gestoque.movements add column if not exists supplier text not null default '';
create index if not exists movements_item_idx on gestoque.movements (item_id, occurred_at desc);
create index if not exists movements_when_idx on gestoque.movements (occurred_at desc);

-- Estimativa de uso informada à mão para um período (ex.: 60 copos neste fim de semana).
-- Datas no formato AAAA-MM-DD, no fuso da loja.
create table if not exists gestoque.overrides (
  id serial primary key,
  item_id integer not null references gestoque.items(id) on delete cascade,
  date_from text not null,
  date_to text not null,
  qty numeric(14,3) not null,
  note text not null default '',
  user_id integer references gestoque.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (item_id, date_from)
);

-- Itens excluídos: o item vem para cá com os dados que tinha na hora da exclusão...
create table if not exists gestoque.removed_items (
  id serial primary key,
  item_id integer not null,
  sku text not null,
  name text not null,
  category text not null default '',
  unit text not null default 'un',
  qty numeric(14,3) not null default 0,
  min_qty numeric(14,3) not null default 0,
  cost numeric(14,2) not null default 0,
  pack_size numeric(14,3) not null default 1,
  lead_days integer not null default 7,
  supplier text not null default '',
  active boolean not null default true,
  created_at timestamptz,
  updated_at timestamptz,
  removed_at timestamptz not null default now(),
  removed_by integer references gestoque.users(id) on delete set null,
  removed_by_name text not null default ''
);

-- Item em pacote: o estoque é contado em pacotes e este é o número de unidades em 1 pacote.
-- Vazio (null) = item comum, sem pacote.
alter table gestoque.items add column if not exists units_per_pack numeric(14,3);
alter table gestoque.removed_items add column if not exists units_per_pack numeric(14,3);

-- ...e todo o histórico dele (compras, saídas e contagens), ligado ao item removido.
create table if not exists gestoque.removed_items_history (
  id serial primary key,
  removed_item_id integer not null references gestoque.removed_items(id) on delete cascade,
  movement_id integer not null,
  type text not null,
  delta numeric(14,3) not null,
  balance_after numeric(14,3) not null,
  unit_cost numeric(14,2),
  note text not null default '',
  supplier text not null default '',
  user_id integer references gestoque.users(id) on delete set null,
  user_name text not null default '',
  occurred_at timestamptz not null
);
create index if not exists removed_items_history_item_idx on gestoque.removed_items_history (removed_item_id, occurred_at);

-- ...e as compras dele (entradas), com preço pago, total e fornecedor, também ligadas ao item removido.
create table if not exists gestoque.removed_items_purchases (
  id serial primary key,
  removed_item_id integer not null references gestoque.removed_items(id) on delete cascade,
  movement_id integer not null,
  qty numeric(14,3) not null,
  unit_cost numeric(14,2),
  total numeric(14,2) not null default 0,
  supplier text not null default '',
  note text not null default '',
  user_name text not null default '',
  occurred_at timestamptz not null,
  unique (removed_item_id, movement_id)
);
-- Itens removidos antes desta tabela existir: as compras saem do histórico já guardado.
insert into gestoque.removed_items_purchases (removed_item_id, movement_id, qty, unit_cost, total, supplier, note, user_name, occurred_at)
select h.removed_item_id, h.movement_id, h.delta, h.unit_cost, round(h.delta * coalesce(h.unit_cost, 0), 2),
       h.supplier, h.note, h.user_name, h.occurred_at
  from gestoque.removed_items_history h
 where h.type = 'entrada'
on conflict (removed_item_id, movement_id) do nothing;

-- Pedidos de novo usuário feitos por gestores, para um admin aprovar ou recusar.
create table if not exists gestoque.user_requests (
  id serial primary key,
  requested_by integer references gestoque.users(id) on delete set null,
  name text not null,
  username text not null,
  role text not null check (role in ('admin', 'gestor')),
  note text not null default '',
  status text not null default 'pendente' check (status in ('pendente', 'aprovada', 'recusada')),
  decided_by integer references gestoque.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_user_id integer references gestoque.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists gestoque.settings (
  key text primary key,
  value jsonb not null
);

-- Registro da API (tela /partner, só admin): ações, exportações e erros, com o pedido e a resposta.
-- Senhas, códigos e tokens são trocados por *** antes de gravar. Registros com mais de 90 dias são apagados.
create table if not exists gestoque.api_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id integer,
  user_name text,
  method text not null,
  path text not null,
  status smallint not null,
  duration_ms integer not null default 0,
  ip text,
  request json, -- json (não jsonb): guarda os campos na ordem exata em que vieram
  response json
);
create index if not exists api_logs_created_at on gestoque.api_logs (created_at desc);
-- Consulta SQL: o resultado é volátil e não fica no registro. Apaga o que tenha sido guardado antes dessa regra
-- (só as respostas com linhas; o SQL enviado e quem consultou continuam).
update gestoque.api_logs set response = json_build_object('resultado', 'removido', 'motivo', 'resultado da Consulta SQL não é guardado')
 where path = '/api/sql' and method = 'POST' and status < 400 and (response::jsonb ? 'rows' or response::jsonb ? 'trecho');
-- A primeira versão (só em testes locais) usava jsonb, que reordena os campos: converte uma vez.
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'gestoque' and table_name = 'api_logs' and column_name = 'request' and data_type = 'jsonb') then
    alter table gestoque.api_logs alter column request type json using request::json, alter column response type json using response::json;
  end if;
end $$;

-- Entradas antigas sem preço: congela o custo que o item tinha, para o histórico não mudar depois.
update gestoque.movements m set unit_cost = i.cost
  from gestoque.items i where i.id = m.item_id and m.type = 'entrada' and m.unit_cost is null;

alter table gestoque.users enable row level security;
alter table gestoque.sessions enable row level security;
alter table gestoque.items enable row level security;
alter table gestoque.movements enable row level security;
alter table gestoque.settings enable row level security;
alter table gestoque.overrides enable row level security;
alter table gestoque.user_requests enable row level security;
alter table gestoque.removed_items enable row level security;
alter table gestoque.removed_items_history enable row level security;
alter table gestoque.removed_items_purchases enable row level security;
alter table gestoque.api_logs enable row level security;

-- Consulta SQL dos admins (tela "Consulta SQL"): papel só de leitura, sem login próprio. As consultas rodam
-- com SET LOCAL ROLE gestoque_leitura numa transação read only. Ele lê as tabelas de operação; na users só
-- colunas sem segredo; sessions fica de fora. RLS: política de leitura só para ele. O usuário da conexão
-- recebe permissão de assumir o papel (SET) sem herdar nada dele (INHERIT FALSE).
-- Se o banco não permitir (ex.: sem CREATEROLE), o sistema sobe assim mesmo e a consulta SQL avisa.
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'gestoque_leitura') then
    create role gestoque_leitura nologin;
  end if;
  grant usage on schema gestoque to gestoque_leitura;
  foreach t in array array['items', 'movements', 'overrides', 'settings', 'user_requests', 'removed_items',
                           'removed_items_history', 'removed_items_purchases', 'api_logs', 'users'] loop
    if t <> 'users' then
      execute format('grant select on gestoque.%I to gestoque_leitura', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'gestoque' and tablename = t and policyname = 'leitura_sql') then
      execute format('create policy leitura_sql on gestoque.%I for select to gestoque_leitura using (true)', t);
    end if;
  end loop;
  revoke all on gestoque.users, gestoque.sessions from gestoque_leitura;
  grant select (id, username, name, role, active, totp_enabled, failed_logins, locked_until, created_at,
                keep_alive, code_failures, code_locked) on gestoque.users to gestoque_leitura;
  begin
    execute format('grant gestoque_leitura to %I with set true, inherit false', current_user);
  exception when syntax_error then
    execute format('grant gestoque_leitura to %I', current_user); -- Postgres antes do 16
  end;
exception when others then
  raise warning 'Consulta SQL: papel gestoque_leitura não configurado (%).', sqlerrm;
end $$;

-- Registro da API: apagar o que tem mais de 90 dias (mesmo número de KEEP_DAYS em server/logs.js).
-- No Supabase, o pg_cron (agendador do próprio Postgres) faz isso todo dia às 06:30 UTC (03:30 em São Paulo),
-- mesmo sem ninguém usando o sistema, e um VACUUM semanal deixa o espaço das linhas apagadas pronto para
-- as novas (a tabela para de crescer). Sem pg_cron (banco local), o servidor limpa sozinho (logs.js).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('gestoque-limpar-api-logs', '30 6 * * *',
      $cmd$delete from gestoque.api_logs where created_at < now() - interval '90 days'$cmd$);
    perform cron.schedule('gestoque-vacuum-api-logs', '0 7 * * 0', 'vacuum (analyze) gestoque.api_logs');
  end if;
exception when others then
  raise warning 'Registro da API: limpeza agendada não configurada (%); o servidor limpa sozinho.', sqlerrm;
end $$;

-- Fotos no Supabase Storage: bucket PRIVADO e fechado para fora. Só o servidor (chave de serviço, que ignora
-- o RLS) lê e grava; a foto chega ao navegador só pela API, para quem está logado. A política restritiva nega
-- tudo a anon e authenticated neste bucket, mesmo que um dia alguém crie outra política mais aberta.
-- Fora do Supabase (banco local) não existe o schema storage: o bloco não faz nada.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('fotos-perfil', 'fotos-perfil', false, 262144, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                    and policyname = 'fotos_perfil_fechado') then
      create policy fotos_perfil_fechado on storage.objects as restrictive for all to anon, authenticated
        using (bucket_id <> 'fotos-perfil') with check (bucket_id <> 'fotos-perfil');
    end if;
  end if;
exception when others then
  raise warning 'Fotos: bucket ou política do Storage não configurados (%).', sqlerrm;
end $$;
`;

let impl = null;
let starting = null;

// Várias requisições podem chegar juntas logo que a função da Vercel acorda: todas esperam a mesma inicialização.
function init() {
  if (!starting) starting = connect().catch((err) => { starting = null; impl = null; throw err; });
  return starting;
}

async function connect() {
  if (process.env.VERCEL && !config.DATABASE_URL) {
    throw new Error(
      process.env.VERCEL_ENV === 'preview'
        ? 'DATABASE_URL_Dev não está configurado para Preview nas variáveis de ambiente da Vercel.'
        : 'DATABASE_URL não está configurado nas variáveis de ambiente da Vercel.'
    );
  }
  if (config.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl = config.DATABASE_CA_FILE
      ? { ca: fs.readFileSync(config.DATABASE_CA_FILE, 'utf8') }
      : { rejectUnauthorized: false };
    // Na Vercel cada instância da função abre poucas conexões; quem segura a fila é o pooler do Supabase.
    // 4 por instância: as telas fazem até 4 consultas ao mesmo tempo (ex.: previsão), e cada uma custa uma ida ao banco.
    const pool = new Pool({ connectionString: config.DATABASE_URL, ssl, max: process.env.VERCEL ? 4 : 6, idleTimeoutMillis: 20000 });
    pool.on('error', (err) => console.error('Banco:', err.message));
    impl = {
      kind: 'supabase',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          // opts.rowMode = 'array': linhas como listas (colunas com o mesmo nome não se perdem).
          const out = await fn({ query: (text, params, opts) => client.query({ text, values: params, ...(opts || {}) }) });
          await client.query('commit');
          return out;
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.join(config.ROOT, 'data', 'pglite');
    fs.mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir);
    await pg.waitReady;
    // GT_ATRASO_BANCO=147 simula a ida e volta até o Supabase (só no banco local), para medir a demora sem tocar no dev.
    const delay = Number(process.env.GT_ATRASO_BANCO) || 0;
    const wait = () => (delay ? new Promise((r) => setTimeout(r, delay)) : null);
    impl = {
      kind: 'local',
      query: async (text, params) => { await wait(); return pg.query(text, params); },
      exec: (text) => pg.exec(text),
      // No Supabase, begin e commit também são idas ao banco: o atraso simulado conta os dois.
      tx: async (fn) => {
        await wait();
        const out = await pg.transaction((t) => fn({ query: async (text, params, opts) => { await wait(); return t.query(text, params, opts); } }));
        await wait();
        return out;
      },
      close: () => pg.close(),
    };
  }
  await impl.exec(SCHEMA);
}

module.exports = {
  init,
  kind: () => impl.kind,
  query: (text, params) => impl.query(text, params),
  tx: (fn) => impl.tx(fn),
  close: () => impl.close(),
};
