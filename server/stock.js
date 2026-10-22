const ExcelJS = require('exceljs');
const db = require('./db');
const forecast = require('./forecast');
const { HttpError } = require('./security');

const ITEM_SELECT = `id, sku, name, category, unit, supplier, lead_days, active, updated_at,
  qty::float8 as qty, min_qty::float8 as min_qty, cost::float8 as cost, pack_size::float8 as pack_size,
  units_per_pack::float8 as units_per_pack`;

// ---------- Itens ----------

async function listItems() {
  const [{ settings, profiles }, { rows }] = await Promise.all([
    forecast.settingsAndProfiles(),
    db.query(`select ${ITEM_SELECT} from gestoque.items order by name`),
  ]);
  for (const item of rows) {
    const profile = profiles.get(item.id);
    item.daily = Math.round((profile ? profile.mean : 0) * 1000) / 1000;
    item.cover_days = item.daily > 0 ? Math.floor(item.qty / item.daily) : null;
  }
  return { items: rows, window_days: settings.window_days };
}

function num(value, label, { min = 0, max = 1e9, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${label}: informe um valor.`);
  }
  const n = typeof value === 'number' ? value : parseNumber(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}: valor inválido.`);
  return n;
}

function text(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function itemFields(b, current = {}) {
  const pick = (key, fn) => (b[key] !== undefined ? fn(b[key]) : current[key]);
  const out = {
    sku: pick('sku', (v) => text(v, 40).toUpperCase()),
    name: pick('name', (v) => text(v)),
    category: pick('category', (v) => text(v, 60)) ?? '',
    unit: pick('unit', (v) => text(v, 12)) || 'un',
    min_qty: pick('min_qty', (v) => num(v, 'Estoque mínimo', { fallback: 0 })) ?? 0,
    cost: pick('cost', (v) => num(v, 'Custo unitário', { fallback: 0 })) ?? 0,
    pack_size: pick('pack_size', (v) => num(v, 'Lote de compra', { min: 0.001, fallback: 1 })) ?? 1,
    lead_days: Math.round(pick('lead_days', (v) => num(v, 'Prazo de entrega', { max: 365, fallback: 7 })) ?? 7),
    supplier: pick('supplier', (v) => text(v, 80)) ?? '',
    active: pick('active', (v) => Boolean(v)) ?? true,
    // Pacote: quantas unidades tem 1 pacote. Vazio ou 0 = item comum. is_pack: false (desmarcado na tela) tira o pacote.
    units_per_pack:
      b.is_pack === false
        ? null
        : pick('units_per_pack', (v) => (v === null || v === '' || Number(v) === 0 ? null : num(v, 'Unidades em 1 pacote', { min: 1, max: 1e6 }))) ?? null,
  };
  if (b.is_pack === true && !out.units_per_pack) throw new HttpError(400, 'Informe quantas unidades tem 1 pacote.');
  if (!out.sku) throw new HttpError(400, 'Informe o SKU.');
  if (!out.name) throw new HttpError(400, 'Informe o nome do item.');
  return out;
}

async function insertMovement(q, { itemId, type, delta, balance, unitCost, note, userId, at, supplier }) {
  await q.query(
    `insert into gestoque.movements (item_id, type, delta, balance_after, unit_cost, note, user_id, occurred_at, supplier)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)`,
    [itemId, type, delta, balance, unitCost ?? null, note || '', userId, at ?? null, supplier || '']
  );
}

async function createItem(ctx) {
  const f = itemFields(ctx.body);
  const qty = num(ctx.body.qty, 'Quantidade', { fallback: 0 });
  return db.tx(async (q) => {
    const dup = await q.query('select 1 from gestoque.items where sku = $1', [f.sku]);
    if (dup.rows.length) throw new HttpError(409, `Já existe um item com o SKU ${f.sku}.`);
    const { rows } = await q.query(
      `insert into gestoque.items (sku, name, category, unit, qty, min_qty, cost, pack_size, lead_days, supplier, active, units_per_pack)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [f.sku, f.name, f.category, f.unit, qty, f.min_qty, f.cost, f.pack_size, f.lead_days, f.supplier, f.active, f.units_per_pack]
    );
    if (qty > 0) {
      await insertMovement(q, { itemId: rows[0].id, type: 'ajuste', delta: qty, balance: qty, note: 'Saldo inicial', userId: ctx.user.id });
    }
    return { id: rows[0].id };
  });
}

async function updateItem(ctx) {
  const id = Number(ctx.params[0]);
  return db.tx(async (q) => {
    const current = (await q.query(`select ${ITEM_SELECT} from gestoque.items where id = $1`, [id])).rows[0];
    if (!current) throw new HttpError(404, 'Item não encontrado.');
    const f = itemFields(ctx.body, current);
    if (f.sku !== current.sku) {
      const dup = await q.query('select 1 from gestoque.items where sku = $1 and id <> $2', [f.sku, id]);
      if (dup.rows.length) throw new HttpError(409, `Já existe um item com o SKU ${f.sku}.`);
    }
    await q.query(
      `update gestoque.items set sku = $2, name = $3, category = $4, unit = $5, min_qty = $6, cost = $7,
              pack_size = $8, lead_days = $9, supplier = $10, active = $11, units_per_pack = $12, updated_at = now() where id = $1`,
      [id, f.sku, f.name, f.category, f.unit, f.min_qty, f.cost, f.pack_size, f.lead_days, f.supplier, f.active, f.units_per_pack]
    );
    return { ok: true };
  });
}

// Excluir não perde nada: numa transação, o item vai para removed_items com os dados atuais e todo o
// histórico dele (compras, saídas e contagens) para removed_items_history. Só então sai do estoque.
async function deleteItem(ctx) {
  const id = Number(ctx.params[0]);
  return db.tx(async (q) => {
    const found = await q.query('select id from gestoque.items where id = $1 for update', [id]);
    if (!found.rows.length) throw new HttpError(404, 'Item não encontrado.');
    const { rows } = await q.query(
      `insert into gestoque.removed_items (item_id, sku, name, category, unit, qty, min_qty, cost, pack_size,
              lead_days, supplier, active, created_at, updated_at, removed_by, removed_by_name, units_per_pack)
       select id, sku, name, category, unit, qty, min_qty, cost, pack_size, lead_days, supplier, active,
              created_at, updated_at, $2, $3, units_per_pack
         from gestoque.items where id = $1
       returning id`,
      [id, ctx.user.id, ctx.user.name]
    );
    const removedId = rows[0].id;
    const history = await q.query(
      `insert into gestoque.removed_items_history (removed_item_id, movement_id, type, delta, balance_after,
              unit_cost, note, supplier, user_id, user_name, occurred_at)
       select $1, m.id, m.type, m.delta, m.balance_after, m.unit_cost, m.note, m.supplier, m.user_id,
              coalesce(u.name, ''), m.occurred_at
         from gestoque.movements m left join gestoque.users u on u.id = m.user_id
        where m.item_id = $2`,
      [removedId, id]
    );
    const purchases = await q.query(
      `insert into gestoque.removed_items_purchases (removed_item_id, movement_id, qty, unit_cost, total, supplier,
              note, user_name, occurred_at)
       select $1, m.id, m.delta, coalesce(m.unit_cost, i.cost), round(m.delta * coalesce(m.unit_cost, i.cost), 2),
              m.supplier, m.note, coalesce(u.name, ''), m.occurred_at
         from gestoque.movements m
         join gestoque.items i on i.id = m.item_id
         left join gestoque.users u on u.id = m.user_id
        where m.item_id = $2 and m.type = 'entrada'`,
      [removedId, id]
    );
    await q.query('delete from gestoque.items where id = $1', [id]);
    return {
      ok: true,
      removed_id: removedId,
      history: history.rowCount ?? history.affectedRows ?? 0,
      purchases: purchases.rowCount ?? purchases.affectedRows ?? 0,
    };
  });
}

// ---------- Itens removidos (só admin) ----------

async function listRemoved() {
  const { rows } = await db.query(
    `select r.id, r.item_id, r.sku, r.name, r.category, r.unit, r.qty::float8 as qty, r.cost::float8 as cost,
            r.supplier, r.removed_at, r.removed_by_name,
            (select count(*)::int from gestoque.removed_items_history h where h.removed_item_id = r.id) as movimentos
       from gestoque.removed_items r
      order by r.removed_at desc, r.id desc limit 500`
  );
  return { removed: rows };
}

async function removedDetail(ctx) {
  const id = Number(ctx.params[0]);
  const [itemRes, historyRes, purchasesRes] = await Promise.all([
    db.query(
      `select id, item_id, sku, name, category, unit, qty::float8 as qty, min_qty::float8 as min_qty, cost::float8 as cost,
              pack_size::float8 as pack_size, lead_days, supplier, active, created_at, updated_at, removed_at, removed_by_name,
              units_per_pack::float8 as units_per_pack
         from gestoque.removed_items where id = $1`,
      [id]
    ),
    db.query(
      `select id, type, delta::float8 as delta, balance_after::float8 as balance_after, unit_cost::float8 as unit_cost,
              note, supplier, user_name, occurred_at
         from gestoque.removed_items_history where removed_item_id = $1
        order by occurred_at desc, movement_id desc`,
      [id]
    ),
    db.query(
      `select id, qty::float8 as qty, unit_cost::float8 as unit_cost, total::float8 as total, supplier, note, user_name, occurred_at
         from gestoque.removed_items_purchases where removed_item_id = $1
        order by occurred_at desc, movement_id desc`,
      [id]
    ),
  ]);
  const item = itemRes.rows[0];
  if (!item) throw new HttpError(404, 'Item removido não encontrado.');
  return { item, history: historyRes.rows, purchases: purchasesRes.rows };
}

// ---------- Movimentações ----------

async function createMovement(ctx) {
  const b = ctx.body;
  const type = b.type;
  if (!['entrada', 'saida', 'ajuste'].includes(type)) throw new HttpError(400, 'Tipo de movimentação inválido.');
  const qty = num(b.qty, 'Quantidade', { min: type === 'ajuste' ? 0 : 0.001 });
  const unitCost = b.unit_cost === undefined || b.unit_cost === '' || b.unit_cost === null ? null : num(b.unit_cost, 'Custo unitário');

  // Um comando só (uma ida ao banco), atômico: trava o item, calcula, confere, atualiza o saldo e grava
  // a movimentação. Se a conferência falhar, nada é gravado e a última linha diz por quê.
  // No ajuste, a quantidade informada é a contagem real: grava-se a diferença.
  // Toda compra guarda o preço pago e o fornecedor do momento: é o que forma o histórico de preços.
  const { rows } = await db.query(
    `with cur as (
       select id, qty, cost, unit, supplier from gestoque.items where id = $1 for update
     ), calc as (
       select cur.*, round(case $2::text when 'entrada' then $3::numeric when 'saida' then -$3::numeric else $3::numeric - cur.qty end, 3) as delta
         from cur
     ), ok as (
       select calc.*, calc.qty + calc.delta as balance
         from calc
        where calc.qty + calc.delta >= 0 and not ($2::text = 'ajuste' and calc.delta = 0)
     ), upd as (
       update gestoque.items i
          set qty = ok.balance,
              cost = case when $2::text = 'entrada' and $6::boolean and $4::numeric is not null then $4::numeric else i.cost end,
              updated_at = now()
         from ok where i.id = ok.id
       returning i.id
     ), ins as (
       insert into gestoque.movements (item_id, type, delta, balance_after, unit_cost, note, user_id, supplier)
       select ok.id, $2::text, ok.delta, ok.balance,
              case when $2::text = 'entrada' then coalesce($4::numeric, ok.cost) else $4::numeric end,
              $5::text, $7::int,
              case when $2::text = 'entrada' then coalesce(nullif($8::text, ''), ok.supplier) else '' end
         from ok
       returning balance_after
     )
     select calc.qty::float8 as qty, calc.delta::float8 as delta, calc.unit, (select balance_after::float8 from ins) as balance
       from calc`,
    [Number(b.item_id), type, qty, unitCost, text(b.note, 200), Boolean(b.update_cost), ctx.user.id, text(b.supplier, 80)]
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Item não encontrado.');
  if (r.balance === null) {
    if (type === 'ajuste' && r.delta === 0) throw new HttpError(400, 'A contagem informada é igual ao estoque atual.');
    throw new HttpError(400, `Saída maior que o estoque. Há ${r.qty.toLocaleString('pt-BR')} ${r.unit} em estoque.`);
  }
  return { balance: r.balance };
}

// Histórico de compras: cada entrada com o preço pago na época e o preço da compra anterior do mesmo item.
async function listPurchases(ctx) {
  const itemId = Number(ctx.url.searchParams.get('item')) || null;
  const { rows } = await db.query(
    `select * from (
       select m.id, m.item_id, i.sku, i.name, i.unit, i.cost::float8 as current_cost,
              m.delta::float8 as qty, coalesce(m.unit_cost, i.cost)::float8 as unit_cost,
              m.supplier, m.note, m.occurred_at, coalesce(u.name, '') as user_name,
              (lag(coalesce(m.unit_cost, i.cost)) over (partition by m.item_id order by m.occurred_at, m.id))::float8 as prev_cost
         from gestoque.movements m
         join gestoque.items i on i.id = m.item_id
         left join gestoque.users u on u.id = m.user_id
        where m.type = 'entrada'
     ) t
     ${itemId ? 'where item_id = $1' : ''}
     order by occurred_at desc, id desc limit 500`,
    itemId ? [itemId] : []
  );
  return { purchases: rows };
}

async function listMovements(ctx) {
  const itemId = Number(ctx.url.searchParams.get('item')) || null;
  const type = ctx.url.searchParams.get('tipo');
  const where = [];
  const params = [];
  if (itemId) where.push(`m.item_id = $${params.push(itemId)}`);
  if (['entrada', 'saida', 'ajuste'].includes(type)) where.push(`m.type = $${params.push(type)}`);
  const { rows } = await db.query(
    `select m.id, m.type, m.delta::float8 as delta, m.balance_after::float8 as balance_after,
            m.unit_cost::float8 as unit_cost, m.note, m.occurred_at,
            i.id as item_id, i.sku, i.name as item_name, i.unit, coalesce(u.name, '') as user_name
       from gestoque.movements m
       join gestoque.items i on i.id = m.item_id
       left join gestoque.users u on u.id = m.user_id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by m.occurred_at desc, m.id desc limit 300`,
    params
  );
  return { movements: rows };
}

// ---------- Planilha: colunas, exportação e importação ----------

const COLUMNS = [
  { key: 'sku', label: 'SKU', width: 14, alt: ['codigo', 'cod'] },
  { key: 'name', label: 'Nome', width: 34, alt: ['item', 'produto', 'descricao'] },
  { key: 'category', label: 'Categoria', width: 18 },
  { key: 'unit', label: 'Unidade', width: 10, alt: ['un', 'unid'] },
  { key: 'qty', label: 'Quantidade', width: 13, numeric: true, alt: ['estoque', 'qtd', 'saldo'] },
  { key: 'min_qty', label: 'Estoque mínimo', width: 16, numeric: true, alt: ['minimo'] },
  { key: 'cost', label: 'Custo unitário', width: 15, numeric: true, money: true, alt: ['custo'] },
  { key: 'pack_size', label: 'Lote de compra', width: 15, numeric: true, alt: ['lote'] },
  // Vazio = item comum; número = item em pacote com essas unidades (0 na importação tira o pacote).
  { key: 'units_per_pack', label: 'Unidades por pacote', width: 20, numeric: true, alt: ['unidades no pacote', 'un por pacote', 'qtd por pacote', 'unidades em 1 pacote'] },
  { key: 'lead_days', label: 'Prazo de entrega (dias)', width: 22, numeric: true, alt: ['prazo', 'prazo de entrega'] },
  { key: 'supplier', label: 'Fornecedor', width: 24 },
  { key: 'active', label: 'Ativo', width: 8 },
];

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Aceita "1.234,56", "1234.56", "R$ 12,90" e números já prontos.
function parseNumber(value) {
  if (typeof value === 'number') return value;
  let s = String(value ?? '').replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

const csvNumber = (n) => String(n).replace('.', ',');
const csvCell = (v) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Monta o arquivo de exportação. rows: objetos com as chaves das colunas; valor null vira célula vazia.
async function buildFile({ format, columns, rows, sheet, name }) {
  const stamp = new Date(Date.now() - SP_OFFSET_H * 3600000).toISOString().slice(0, 10); // dia no fuso da loja
  if (format === 'csv') {
    const lines = [columns.map((c) => c.label).join(';')];
    for (const row of rows) {
      lines.push(columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return '';
        return csvCell(c.numeric ? csvNumber(v) : String(v));
      }).join(';'));
    }
    // BOM + ponto e vírgula: abre direto no Excel em português.
    return { file: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), name: `${name}-${stamp}.csv`, type: 'text/csv; charset=utf-8' };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));
  for (const row of rows) ws.addRow(row);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
  for (const c of columns) if (c.money) ws.getColumn(c.key).numFmt = '"R$" #,##0.00';
  return {
    file: Buffer.from(await wb.xlsx.writeBuffer()),
    name: `${name}-${stamp}.xlsx`,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

const fileFormat = (ctx) => (ctx.url.searchParams.get('formato') === 'csv' ? 'csv' : 'xlsx');

async function exportItems(ctx) {
  const { rows } = await db.query(`select ${ITEM_SELECT} from gestoque.items order by name`);
  return buildFile({
    format: fileFormat(ctx),
    columns: COLUMNS,
    rows: rows.map((item) => ({ ...item, active: item.active ? 'Sim' : 'Não' })),
    sheet: 'Estoque',
    name: 'estoque-gestoque',
  });
}

// Lê o arquivo enviado (.xlsx ou .csv) e devolve as linhas não vazias; a primeira é o cabeçalho.
async function readRows(ctx) {
  const buf = ctx.raw;
  if (!buf || !buf.length) throw new HttpError(400, 'Envie um arquivo .xlsx ou .csv.');
  let rows;
  try {
    rows = buf[0] === 0x50 && buf[1] === 0x4b ? await parseXlsx(buf) : parseCsv(buf);
  } catch {
    throw new HttpError(400, 'Não foi possível ler o arquivo. Use .xlsx ou .csv.');
  }
  rows = rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  if (rows.length < 2) throw new HttpError(400, 'A planilha está vazia. A primeira linha deve ter os títulos das colunas.');
  return rows;
}

// Posição de cada coluna conhecida no cabeçalho da planilha.
function indexColumns(headerRow, columns) {
  const header = headerRow.map(norm);
  const index = {};
  for (const col of columns) {
    const names = [norm(col.label), ...(col.alt || [])];
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) index[col.key] = idx;
  }
  return index;
}

function parseCsv(buf) {
  let s = buf.toString('utf8');
  if (s.includes('�')) s = buf.toString('latin1'); // CSV salvo pelo Excel em ANSI
  s = s.replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0];
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = count(';') >= count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const plain = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      if (v.result !== undefined) return plain(v.result);
      if (v.richText) return v.richText.map((p) => p.text).join('');
      if (v.text !== undefined) return v.text;
      return '';
    }
    return v;
  };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const arr = [];
    r.eachCell({ includeEmpty: true }, (c, col) => { arr[col - 1] = plain(c.value); });
    rows.push(Array.from(arr, (v) => v ?? ''));
  });
  return rows;
}

function parseActive(v) {
  const s = norm(v);
  if (['sim', 's', '1', 'true', 'ativo', 'x'].includes(s)) return true;
  if (['nao', 'n', '0', 'false', 'inativo'].includes(s)) return false;
  return null;
}

// Importa pelo SKU: cria o que não existe, atualiza o que existe. Só mexe nas colunas presentes
// na planilha. Diferença de quantidade vira uma movimentação de ajuste.
// Com ?conferir=1 nada é gravado: devolve apenas o que seria feito.
async function importItems(ctx) {
  const dry = ctx.url.searchParams.get('conferir') === '1';
  const rows = await readRows(ctx);
  const header = rows[0].map(norm);
  if (header.includes('tipo') && header.includes('data')) {
    throw new HttpError(400, 'Esta planilha é de movimentações. Escolha "Movimentações" para importar.');
  }
  const colIndex = indexColumns(rows[0], COLUMNS);
  if (colIndex.sku === undefined) throw new HttpError(400, 'Não encontrei a coluna SKU. Exporte o estoque para usar a planilha como modelo.');

  const errors = [];
  const records = [];
  const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const rec = {};
    try {
      for (const col of COLUMNS) {
        if (colIndex[col.key] === undefined) continue;
        const raw = r[colIndex[col.key]];
        const empty = raw === undefined || String(raw).trim() === '';
        if (col.key === 'active') {
          if (empty) continue;
          const a = parseActive(raw);
          if (a === null) throw new Error('Ativo: use Sim ou Não.');
          rec.active = a;
        } else if (col.numeric) {
          if (empty) continue;
          const n = parseNumber(raw);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${col.label}: "${raw}" não é um número válido.`);
          rec[col.key] = col.key === 'units_per_pack' && n === 0 ? null : n;
        } else if (!empty) rec[col.key] = String(raw).trim();
      }
      if (!rec.sku) throw new Error('SKU em branco.');
      rec.sku = rec.sku.toUpperCase();
      if (seen.has(rec.sku)) throw new Error(`SKU ${rec.sku} repetido na planilha.`);
      seen.add(rec.sku);
      records.push({ line, rec });
    } catch (err) {
      errors.push({ line, message: err.message });
    }
  });

  const existing = new Map(
    (await db.query(`select ${ITEM_SELECT} from gestoque.items`)).rows.map((it) => [it.sku, it])
  );
  const plan = { created: 0, updated: 0, unchanged: 0, adjusted: 0 };
  const work = [];
  for (const { line, rec } of records) {
    const cur = existing.get(rec.sku);
    if (!cur) {
      if (!rec.name) { errors.push({ line, message: `SKU ${rec.sku} é novo e está sem Nome.` }); continue; }
      plan.created++;
      if (rec.qty > 0) plan.adjusted++;
      work.push({ rec, cur: null });
      continue;
    }
    const changed = Object.keys(rec).filter((k) => k !== 'sku' && k !== 'qty' && rec[k] !== cur[k]);
    const qtyChanged = rec.qty !== undefined && rec.qty !== cur.qty;
    if (!changed.length && !qtyChanged) { plan.unchanged++; continue; }
    plan.updated++;
    if (qtyChanged) plan.adjusted++;
    work.push({ rec, cur, changed, qtyChanged });
  }

  if (dry || errors.length) {
    if (!dry) throw new HttpError(400, 'A planilha tem erros. Corrija e envie de novo.', { errors });
    return { ...plan, errors: errors.slice(0, 50), total_errors: errors.length };
  }

  await db.tx(async (q) => {
    for (const w of work) {
      if (!w.cur) {
        const f = itemFields(w.rec);
        const qty = w.rec.qty || 0;
        const { rows: ins } = await q.query(
          `insert into gestoque.items (sku, name, category, unit, qty, min_qty, cost, pack_size, lead_days, supplier, active, units_per_pack)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [f.sku, f.name, f.category, f.unit, qty, f.min_qty, f.cost, f.pack_size, f.lead_days, f.supplier, f.active, f.units_per_pack]
        );
        if (qty > 0) {
          await insertMovement(q, { itemId: ins[0].id, type: 'ajuste', delta: qty, balance: qty, note: 'Saldo inicial (planilha)', userId: ctx.user.id });
        }
        continue;
      }
      const f = itemFields(w.rec, w.cur);
      await q.query(
        `update gestoque.items set name = $2, category = $3, unit = $4, min_qty = $5, cost = $6,
                pack_size = $7, lead_days = $8, supplier = $9, active = $10, units_per_pack = $11, updated_at = now() where id = $1`,
        [w.cur.id, f.name, f.category, f.unit, f.min_qty, f.cost, f.pack_size, f.lead_days, f.supplier, f.active, f.units_per_pack]
      );
      if (w.qtyChanged) {
        await q.query('update gestoque.items set qty = $2 where id = $1', [w.cur.id, w.rec.qty]);
        await insertMovement(q, {
          itemId: w.cur.id, type: 'ajuste', delta: w.rec.qty - w.cur.qty, balance: w.rec.qty,
          note: 'Ajuste por planilha', userId: ctx.user.id,
        });
      }
    }
  });
  return { ...plan, errors: [], total_errors: 0 };
}

// ---------- Planilha de movimentações (saídas, entradas e contagens) ----------

const MOVE_COLUMNS = [
  { key: 'when', label: 'Data', width: 21, alt: ['data hora', 'data e hora', 'quando'] },
  { key: 'sku', label: 'SKU', width: 14, alt: ['codigo', 'cod'] },
  { key: 'name', label: 'Item', width: 34 }, // só para leitura; a importação usa o SKU
  { key: 'type', label: 'Tipo', width: 12 },
  { key: 'qty', label: 'Quantidade', width: 13, numeric: true, alt: ['qtd'] },
  { key: 'unit_cost', label: 'Custo unitário', width: 15, numeric: true, money: true, alt: ['custo'] },
  { key: 'note', label: 'Observação', width: 40, alt: ['obs'] },
];
const TYPE_LABEL = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Contagem' };
const TYPE_FROM = { entrada: 'entrada', entradas: 'entrada', saida: 'saida', saidas: 'saida', contagem: 'ajuste', contagens: 'ajuste', ajuste: 'ajuste' };
const SP_OFFSET_H = 3; // São Paulo é UTC-3 o ano todo (sem horário de verão desde 2019)
const round3 = (n) => Math.round(n * 1000) / 1000;

// Data e hora no relógio da loja: "dd/mm/aaaa hh:mm:ss".
function formatWhen(date) {
  const d = new Date(date.getTime() - SP_OFFSET_H * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Aceita "dd/mm/aaaa", "dd/mm/aaaa hh:mm[:ss]", "aaaa-mm-dd[ hh:mm[:ss]]" e datas do Excel.
// Sem hora, assume meio-dia. Devolve null se não for uma data.
function parseWhen(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  let y, mo, d, rest;
  if (m) { [d, mo, y] = [m[1], m[2], m[3]]; rest = m.slice(4); }
  else {
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    [y, mo, d] = [m[1], m[2], m[3]];
    rest = m.slice(4);
  }
  const [hh, mi, ss] = rest[0] === undefined ? [12, 0, 0] : [Number(rest[0]), Number(rest[1]), Number(rest[2] || 0)];
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (check.getUTCMonth() !== Number(mo) - 1 || hh > 23 || mi > 59 || ss > 59) return null;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hh + SP_OFFSET_H, mi, ss));
}

function dayBound(text, addDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return null;
  const [y, m, d] = text.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + addDays, SP_OFFSET_H));
}

async function exportMovements(ctx) {
  const sp = ctx.url.searchParams;
  const types = (sp.get('tipos') || '').split(',').filter((t) => TYPE_LABEL[t]);
  const where = [];
  const params = [];
  if (types.length) where.push(`m.type in (${types.map((t) => `$${params.push(t)}`).join(', ')})`);
  const from = dayBound(sp.get('de'), 0);
  const to = dayBound(sp.get('ate'), 1);
  if (from) where.push(`m.occurred_at >= $${params.push(from)}`);
  if (to) where.push(`m.occurred_at < $${params.push(to)}`);

  const { rows } = await db.query(
    `select m.type, m.delta::float8 as delta, m.balance_after::float8 as balance_after,
            m.unit_cost::float8 as unit_cost, m.note, m.occurred_at, i.sku, i.name
       from gestoque.movements m join gestoque.items i on i.id = m.item_id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by m.occurred_at, m.id limit 200000`,
    params
  );
  return buildFile({
    format: fileFormat(ctx),
    columns: MOVE_COLUMNS,
    rows: rows.map((m) => ({
      when: formatWhen(new Date(m.occurred_at)),
      sku: m.sku,
      name: m.name,
      type: TYPE_LABEL[m.type],
      // Na contagem vai o saldo contado; na entrada e na saída, a quantidade movimentada.
      qty: m.type === 'ajuste' ? m.balance_after : Math.abs(m.delta),
      unit_cost: m.unit_cost,
      note: m.note,
    })),
    sheet: 'Movimentações',
    name: 'movimentacoes-gestoque',
  });
}

const moveKey = (itemId, type, when, value) => `${itemId}|${type}|${Math.floor(new Date(when).getTime() / 1000)}|${round3(value)}`;

// Importa saídas, entradas e contagens pelo SKU. Linhas iguais a uma movimentação já registrada
// (mesmo item, tipo, data e quantidade) são ignoradas, então reimportar um arquivo não duplica nada.
// ?saldo=0 grava só o histórico, sem mexer no estoque atual (para carregar meses antigos).
// Com ?conferir=1 nada é gravado.
async function importMovements(ctx) {
  const dry = ctx.url.searchParams.get('conferir') === '1';
  const updateStock = ctx.url.searchParams.get('saldo') !== '0';
  const rows = await readRows(ctx);
  const col = indexColumns(rows[0], MOVE_COLUMNS);
  for (const key of ['sku', 'type', 'qty']) {
    if (col[key] === undefined) {
      const label = MOVE_COLUMNS.find((c) => c.key === key).label;
      throw new HttpError(400, `Não encontrei a coluna ${label}. Exporte as movimentações para usar a planilha como modelo.`);
    }
  }

  const items = new Map(
    (await db.query('select id, sku, unit, supplier, qty::float8 as qty, cost::float8 as cost from gestoque.items')).rows.map((it) => [it.sku, it])
  );
  const now = new Date();
  const errors = [];
  const records = [];
  const cell = (r, key) => (col[key] === undefined || r[col[key]] === undefined ? '' : String(r[col[key]]).trim());

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    try {
      const sku = cell(r, 'sku').toUpperCase();
      if (!sku) throw new Error('SKU em branco.');
      const item = items.get(sku);
      if (!item) throw new Error(`SKU ${sku} não existe no estoque. Cadastre o item antes.`);
      const type = TYPE_FROM[norm(cell(r, 'type'))];
      if (!type) throw new Error(`Tipo: use Entrada, Saída ou Contagem.`);
      const qty = parseNumber(r[col.qty]);
      if (!Number.isFinite(qty) || qty < 0 || (type !== 'ajuste' && qty === 0)) throw new Error(`Quantidade: "${cell(r, 'qty')}" não é válida.`);
      let when = null;
      if (cell(r, 'when')) {
        when = parseWhen(cell(r, 'when'));
        if (!when) throw new Error(`Data: "${cell(r, 'when')}" não foi reconhecida. Use dd/mm/aaaa hh:mm.`);
        if (when > now) throw new Error('Data no futuro.');
      }
      let unitCost = null;
      if (cell(r, 'unit_cost')) {
        unitCost = parseNumber(r[col.unit_cost]);
        if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error(`Custo unitário: "${cell(r, 'unit_cost')}" não é válido.`);
      }
      records.push({ line, order: i, item, type, qty: round3(qty), when, unitCost, note: cell(r, 'note').slice(0, 200) });
    } catch (err) {
      errors.push({ line, message: err.message });
    }
  });

  // Movimentações já registradas no intervalo de datas da planilha.
  const dated = records.filter((r) => r.when);
  const existing = new Set();
  if (dated.length) {
    const times = dated.map((r) => r.when.getTime());
    const { rows: old } = await db.query(
      `select item_id, type, delta::float8 as delta, balance_after::float8 as balance_after, occurred_at
         from gestoque.movements where occurred_at >= $1 and occurred_at < $2`,
      [new Date(Math.min(...times)), new Date(Math.max(...times) + 1000)]
    );
    for (const m of old) existing.add(moveKey(m.item_id, m.type, m.occurred_at, m.type === 'ajuste' ? m.balance_after : Math.abs(m.delta)));
  }

  const plan = { entradas: 0, saidas: 0, contagens: 0, duplicates: 0, unchanged: 0 };
  const balance = new Map();
  const work = [];
  const fresh = records.filter((r) => {
    if (r.when && existing.has(moveKey(r.item.id, r.type, r.when, r.qty))) { plan.duplicates++; return false; }
    return true;
  });
  // Em ordem de data; linhas sem data entram como "agora", na ordem da planilha.
  fresh.sort((a, b) => (a.when || now) - (b.when || now) || a.order - b.order);
  for (const r of fresh) {
    const bal = balance.has(r.item.id) ? balance.get(r.item.id) : r.item.qty;
    let delta, after;
    if (!updateStock) {
      delta = r.type === 'entrada' ? r.qty : r.type === 'saida' ? -r.qty : 0;
      after = r.type === 'ajuste' ? r.qty : bal;
    } else {
      delta = r.type === 'entrada' ? r.qty : r.type === 'saida' ? -r.qty : round3(r.qty - bal);
      after = round3(bal + delta);
      if (after < 0) {
        errors.push({ line: r.line, message: `Saída maior que o estoque de ${r.item.sku}: havia ${bal.toLocaleString('pt-BR')} ${r.item.unit}.` });
        continue;
      }
      if (r.type === 'ajuste' && delta === 0) { plan.unchanged++; continue; }
      balance.set(r.item.id, after);
    }
    plan[r.type === 'entrada' ? 'entradas' : r.type === 'saida' ? 'saidas' : 'contagens']++;
    work.push({ ...r, delta, after });
  }

  errors.sort((a, b) => a.line - b.line);
  if (dry || errors.length) {
    if (!dry) throw new HttpError(400, 'A planilha tem erros. Corrija e envie de novo.', { errors });
    return { ...plan, errors: errors.slice(0, 50), total_errors: errors.length };
  }

  await db.tx(async (q) => {
    for (const w of work) {
      await insertMovement(q, {
        itemId: w.item.id, type: w.type, delta: w.delta, balance: w.after,
        unitCost: w.type === 'entrada' && w.unitCost === null ? w.item.cost : w.unitCost,
        supplier: w.type === 'entrada' ? w.item.supplier : '',
        note: w.note || 'Importado de planilha', userId: ctx.user.id, at: w.when,
      });
    }
    for (const [itemId, qty] of balance) {
      await q.query('update gestoque.items set qty = $2, updated_at = now() where id = $1', [itemId, qty]);
    }
  });
  return { ...plan, errors: [], total_errors: 0 };
}

module.exports = {
  listRemoved,
  removedDetail,
  listPurchases,
  exportMovements,
  importMovements,
  listItems,
  createItem,
  updateItem,
  deleteItem,
  createMovement,
  listMovements,
  exportItems,
  importItems,
};
