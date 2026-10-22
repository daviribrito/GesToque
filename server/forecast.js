const db = require('./db');
const config = require('./config');
const { HttpError } = require('./security');

const DAY = 86400000;
const CLOSED_MONTHS = 3;
const ESTIMATE_BLOCKS = 16; // 8 semanas: dias úteis e fim de semana de cada uma

const DEFAULTS = {
  window_days: 90, // quantos dias de saídas entram no cálculo do uso
  safety_days: 7, // folga de estoque que deve sobrar no fim de cada mês
  growth_pct: 0, // crescimento esperado de um mês para o outro
  months_ahead: 6, // quantas faturas mostrar, contando o mês atual
  seasonality: Array(12).fill(100), // peso de cada mês, jan..dez, em %
};

async function loadSettings() {
  const { rows } = await db.query("select value from gestoque.settings where key = 'previsao'");
  return { ...DEFAULTS, ...(rows[0] ? rows[0].value : {}) };
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}: use um valor entre ${min} e ${max}.`);
  return n;
}

async function saveSettings(ctx) {
  const b = ctx.body;
  const season = Array.isArray(b.seasonality) ? b.seasonality : [];
  if (season.length !== 12) throw new HttpError(400, 'Informe o peso dos 12 meses.');
  const value = {
    window_days: Math.round(intIn(b.window_days, 7, 365, 'Janela de análise')),
    safety_days: Math.round(intIn(b.safety_days, 0, 90, 'Dias de segurança')),
    growth_pct: intIn(b.growth_pct, -50, 100, 'Crescimento mensal'),
    months_ahead: Math.round(intIn(b.months_ahead, 1, 12, 'Meses à frente')),
    seasonality: season.map((v, i) => intIn(v, 10, 500, `Peso do mês ${i + 1}`)),
  };
  await db.query(
    `insert into gestoque.settings (key, value) values ('previsao', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)]
  );
  return { settings: value };
}

// ---------- Datas ----------
// Os dias são tratados como meia-noite UTC só para fazer contas; o dia em si é o do fuso da loja.

function today() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE }).format(new Date()).split('-').map(Number);
  return { y, m, d, ms: Date.UTC(y, m - 1, d) };
}

const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(y, m, k) {
  const idx = y * 12 + (m - 1) + k;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
const round3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

// Feriados nacionais. Feriados estaduais ou da cidade entram aqui, com fixed() ou moving().
// Carnaval não é feriado oficial, mas muda o movimento da loja do mesmo jeito.
const holidayCache = new Map();
function holidaysOf(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = Date.UTC(year, month - 1, day);

  const map = new Map();
  const fixed = (mm, dd, name) => map.set(`${year}-${mm}-${dd}`, name);
  const moving = (offset, name) => map.set(dayStr(easter + offset * DAY), name);
  fixed('01', '01', 'Confraternização Universal');
  moving(-48, 'Carnaval');
  moving(-47, 'Carnaval');
  moving(-2, 'Sexta-feira Santa');
  fixed('04', '21', 'Tiradentes');
  fixed('05', '01', 'Dia do Trabalho');
  moving(60, 'Corpus Christi');
  fixed('09', '07', 'Independência');
  fixed('10', '12', 'Nossa Senhora Aparecida');
  fixed('11', '02', 'Finados');
  fixed('11', '15', 'Proclamação da República');
  fixed('11', '20', 'Consciência Negra');
  fixed('12', '25', 'Natal');
  holidayCache.set(year, map);
  return map;
}
const holidayName = (ms) => holidaysOf(new Date(ms).getUTCFullYear()).get(dayStr(ms)) || null;

// ---------- Perfil de uso ----------

const EMPTY_PROFILE = { mean: 0, wd: Array(7).fill(0), holiday: 0, holiday_learned: false, byDate: new Map() };

// Para cada item, aprende das saídas da janela quanto sai em cada dia da semana (dom..sáb)
// e em feriado. Feriados ficam fora da média do dia da semana para não distorcer.
// Sem feriado no histórico, feriado vale a média de sábado e domingo.
// Configurações + perfis de uso, com as 3 consultas ao mesmo tempo (cada ida ao banco custa caro).
// A janela de dias sai das configurações dentro do próprio SQL, para não esperar uma consulta pela outra.
async function settingsAndProfiles(t = today()) {
  const midnight = new Date(t.ms + 3 * 3600000); // 00:00 de hoje em São Paulo
  const [settings, used, firsts] = await Promise.all([
    loadSettings(),
    db.query(
      `select item_id, to_char(occurred_at at time zone '${config.TIMEZONE}', 'YYYY-MM-DD') as d,
              sum(-delta)::float8 as used
         from gestoque.movements
        where type = 'saida'
          and occurred_at >= $1::timestamptz - make_interval(days => coalesce(
                (select (value->>'window_days')::int from gestoque.settings where key = 'previsao'), $2::int))
        group by 1, 2`,
      [midnight, DEFAULTS.window_days]
    ),
    db.query(
      `select item_id, to_char(min(occurred_at) at time zone '${config.TIMEZONE}', 'YYYY-MM-DD') as first
         from gestoque.movements group by 1`
    ),
  ]);
  return { settings, profiles: buildProfiles(used.rows, firsts.rows, settings.window_days, t) };
}

function buildProfiles(used, firsts, windowDays, t) {
  const cutoff = t.ms - windowDays * DAY;
  const byItem = new Map();
  for (const r of used) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, new Map());
    byItem.get(r.item_id).set(r.d, r.used);
  }

  const profiles = new Map();
  for (const { item_id, first } of firsts) {
    const byDate = byItem.get(item_id) || new Map();
    // Do início do histórico (ou da janela) até ontem; hoje ainda está pela metade.
    let start = Math.max(cutoff, dayMs(first));
    let end = t.ms - DAY;
    if (start > end) start = end = t.ms;

    const wdSum = Array(7).fill(0), wdN = Array(7).fill(0);
    let holSum = 0, holN = 0, total = 0, n = 0;
    for (let ms = start; ms <= end; ms += DAY) {
      const u = byDate.get(dayStr(ms)) || 0;
      total += u;
      n++;
      if (holidayName(ms)) { holSum += u; holN++; }
      else { const w = new Date(ms).getUTCDay(); wdSum[w] += u; wdN[w]++; }
    }
    const mean = total / n;
    const wd = wdSum.map((s, w) => (wdN[w] ? s / wdN[w] : mean));
    profiles.set(item_id, {
      mean,
      wd,
      holiday: holN ? holSum / holN : (wd[0] + wd[6]) / 2,
      holiday_learned: holN > 0,
      byDate,
    });
  }
  return profiles;
}

// Uso automático previsto para um dia: perfil do dia × peso do mês × crescimento acumulado.
function autoFor(profile, ms, settings, t) {
  const d = new Date(ms);
  const m = d.getUTCMonth();
  const k = Math.max(0, d.getUTCFullYear() * 12 + m - (t.y * 12 + t.m - 1));
  const base = holidayName(ms) ? profile.holiday : profile.wd[d.getUTCDay()];
  return base * (settings.seasonality[m] / 100) * Math.pow(1 + settings.growth_pct / 100, k);
}

const usedBetween = (profile, fromMs, toMs) => {
  let sum = 0;
  for (let ms = fromMs; ms <= toMs; ms += DAY) sum += profile.byDate.get(dayStr(ms)) || 0;
  return sum;
};

async function loadOverrides(t, itemId) {
  const params = [dayStr(t.ms)];
  const { rows } = await db.query(
    `select o.id, o.item_id, o.date_from, o.date_to, o.qty::float8 as qty, o.note, coalesce(u.name, '') as user_name
       from gestoque.overrides o left join gestoque.users u on u.id = o.user_id
      where o.date_to >= $1 ${itemId ? `and o.item_id = $${params.push(itemId)}` : ''}`,
    params
  );
  return rows;
}

// ---------- Faturas ----------

async function build() {
  const t = today();
  // Compras reais (entradas) dos meses fechados e do mês atual.
  const first = addMonths(t.y, t.m, -CLOSED_MONTHS);
  const since = new Date(Date.UTC(first.y, first.m - 1, 1, 3));
  // Tudo de uma vez: nenhuma destas consultas depende da outra.
  const [{ settings, profiles }, overrides, itemsRes, boughtRes] = await Promise.all([
    settingsAndProfiles(t),
    loadOverrides(t),
    db.query(
      `select id, sku, name, category, unit, supplier, lead_days,
              qty::float8 as qty, min_qty::float8 as min_qty, cost::float8 as cost, pack_size::float8 as pack_size
         from gestoque.items where active order by name`
    ),
    db.query(
      `select to_char(m.occurred_at at time zone '${config.TIMEZONE}', 'YYYY-MM') as ym,
              i.id as item_id, i.sku, i.name, i.unit,
              sum(m.delta)::float8 as qty,
              sum(m.delta * coalesce(m.unit_cost, i.cost))::float8 as total
         from gestoque.movements m join gestoque.items i on i.id = m.item_id
        where m.type = 'entrada' and m.occurred_at >= $1
        group by 1, 2, 3, 4, 5 order by i.name`,
      [since]
    ),
  ]);
  const items = itemsRes.rows;
  const bought = boughtRes.rows;

  const months = [];
  for (let k = CLOSED_MONTHS; k >= 1; k--) {
    const { y, m } = addMonths(t.y, t.m, -k);
    const key = ymKey(y, m);
    const lines = bought
      .filter((b) => b.ym === key)
      .map((b) => ({ item_id: b.item_id, sku: b.sku, name: b.name, unit: b.unit, buy: round3(b.qty), total: round2(b.total) }));
    months.push({ key, year: y, month: m, status: 'fechada', total: round2(lines.reduce((s, l) => s + l.total, 0)), lines });
  }

  // Previsão dia a dia de cada item, de hoje até o fim do último mês: automática e com os ajustes manuais.
  const last = addMonths(t.y, t.m, settings.months_ahead - 1);
  const horizon = Math.round((Date.UTC(last.y, last.m - 1, daysInMonth(last.y, last.m)) - t.ms) / DAY) + 1;
  const daily = new Map();
  for (const item of items) {
    const profile = profiles.get(item.id) || EMPTY_PROFILE;
    const auto = Array.from({ length: horizon }, (_, i) => autoFor(profile, t.ms + i * DAY, settings, t));
    const adjusted = auto.slice();
    for (const ov of overrides) {
      if (ov.item_id !== item.id) continue;
      const fromMs = dayMs(ov.date_from);
      const a = Math.max(0, Math.round((fromMs - t.ms) / DAY));
      const b = Math.min(horizon - 1, Math.round((dayMs(ov.date_to) - t.ms) / DAY));
      if (b < a) continue;
      // O ajuste vale para o período inteiro: desconta o que já saiu antes de hoje
      // e reparte o restante pelos dias que faltam, na proporção do automático.
      const target = Math.max(0, ov.qty - usedBetween(profile, fromMs, t.ms - DAY));
      let autoSum = 0;
      for (let i = a; i <= b; i++) autoSum += auto[i];
      for (let i = a; i <= b; i++) adjusted[i] = autoSum > 0 ? (auto[i] * target) / autoSum : target / (b - a + 1);
    }
    daily.set(item.id, { auto, adjusted });
  }

  const stock = new Map(items.map((i) => [i.id, i.qty]));
  let offset = 0;
  for (let k = 0; k < settings.months_ahead; k++) {
    const { y, m } = addMonths(t.y, t.m, k);
    const key = ymKey(y, m);
    const days = k === 0 ? daysInMonth(y, m) - t.d + 1 : daysInMonth(y, m);
    const lines = [];

    for (const item of items) {
      const d = daily.get(item.id);
      let consumption = 0, autoConsumption = 0;
      for (let i = offset; i < offset + days; i++) { consumption += d.adjusted[i]; autoConsumption += d.auto[i]; }
      const perDay = consumption / days;
      const start = stock.get(item.id);
      const reserve = Math.max(perDay * settings.safety_days, item.min_qty);
      const need = Math.max(0, consumption + reserve - start);
      const pack = item.pack_size > 0 ? item.pack_size : 1;
      const buy = need > 0 ? round3(Math.ceil(round3(need / pack)) * pack) : 0;
      stock.set(item.id, Math.max(0, start + buy - consumption));
      if (buy <= 0) continue;

      const orderMs = Date.UTC(y, m - 1, 1) - item.lead_days * DAY;
      lines.push({
        item_id: item.id,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        supplier: item.supplier,
        daily: round3(perDay),
        start_stock: round3(start),
        consumption: round3(consumption),
        auto_consumption: round3(autoConsumption),
        adjusted: Math.abs(consumption - autoConsumption) > 0.0005,
        buy,
        cost: item.cost,
        total: round2(buy * item.cost),
        order_by: k === 0 || orderMs <= t.ms ? null : dayStr(orderMs),
      });
    }
    offset += days;

    const month = {
      key,
      year: y,
      month: m,
      status: k === 0 ? 'aberta' : 'prevista',
      days,
      total: round2(lines.reduce((s, l) => s + l.total, 0)),
      adjusted_lines: lines.filter((l) => l.adjusted).length,
      lines,
    };
    if (k === 0) {
      month.bought_total = round2(bought.filter((b) => b.ym === key).reduce((s, b) => s + b.total, 0));
    }
    months.push(month);
  }

  return { today: dayStr(t.ms), settings, months };
}

// ---------- Estimativa de uso por período (automática + ajuste manual) ----------

// Períodos fixos: segunda a sexta e sábado a domingo. Começa no período que contém hoje.
function blocksFrom(t) {
  const w = new Date(t.ms).getUTCDay();
  let start = w === 0 ? t.ms - DAY : w === 6 ? t.ms : t.ms - (w - 1) * DAY;
  let weekend = w === 0 || w === 6;
  const blocks = [];
  for (let i = 0; i < ESTIMATE_BLOCKS; i++) {
    const len = weekend ? 2 : 5;
    blocks.push({ from: start, to: start + (len - 1) * DAY, kind: weekend ? 'fim de semana' : 'semana' });
    start += len * DAY;
    weekend = !weekend;
  }
  return blocks;
}

async function listEstimates(ctx) {
  const itemId = Number(ctx.url.searchParams.get('item'));
  const t = today();
  const [itemRes, { settings, profiles }, overrides] = await Promise.all([
    db.query('select id, sku, name, unit from gestoque.items where id = $1', [itemId]),
    settingsAndProfiles(t),
    loadOverrides(t, itemId),
  ]);
  const item = itemRes.rows[0];
  if (!item) throw new HttpError(404, 'Item não encontrado.');
  const profile = profiles.get(item.id) || EMPTY_PROFILE;

  const blocks = blocksFrom(t).map((b) => {
    let auto = 0;
    const holidays = [];
    for (let ms = b.from; ms <= b.to; ms += DAY) {
      auto += autoFor(profile, ms, settings, t);
      const name = holidayName(ms);
      if (name) holidays.push({ date: dayStr(ms), name });
    }
    const from = dayStr(b.from);
    const ov = overrides.find((o) => o.date_from === from);
    return {
      from,
      to: dayStr(b.to),
      kind: b.kind,
      current: b.from <= t.ms,
      holidays,
      auto: round3(auto),
      used: b.from < t.ms ? round3(usedBetween(profile, b.from, t.ms - DAY)) : 0,
      adjusted: ov ? ov.qty : null,
      override_id: ov ? ov.id : null,
      note: ov ? ov.note : '',
      user_name: ov ? ov.user_name : '',
    };
  });

  return {
    item,
    window_days: settings.window_days,
    profile: { mean: round3(profile.mean), wd: profile.wd.map(round3), holiday: round3(profile.holiday), holiday_learned: profile.holiday_learned },
    blocks,
  };
}

// Todas as estimativas manuais que ainda valem (período não terminado), de todos os itens,
// com o valor automático do mesmo período para comparação.
async function listManualEstimates() {
  const t = today();
  const [{ settings, profiles }, { rows }] = await Promise.all([
    settingsAndProfiles(t),
    db.query(
      `select o.id, o.item_id, o.date_from, o.date_to, o.qty::float8 as qty, o.note, coalesce(u.name, '') as user_name,
              i.sku, i.name, i.unit, i.active
         from gestoque.overrides o
         join gestoque.items i on i.id = o.item_id
         left join gestoque.users u on u.id = o.user_id
        where o.date_to >= $1
        order by i.name, o.date_from`,
      [dayStr(t.ms)]
    ),
  ]);
  const estimates = rows.map((r) => {
    const profile = profiles.get(r.item_id) || EMPTY_PROFILE;
    const fromMs = dayMs(r.date_from);
    const toMs = dayMs(r.date_to);
    let auto = 0;
    for (let ms = fromMs; ms <= toMs; ms += DAY) auto += autoFor(profile, ms, settings, t);
    const weekend = [0, 6].includes(new Date(fromMs).getUTCDay());
    return {
      ...r,
      kind: weekend ? 'fim de semana' : 'semana',
      current: fromMs <= t.ms,
      auto: round3(auto),
      used: fromMs < t.ms ? round3(usedBetween(profile, fromMs, t.ms - DAY)) : 0,
    };
  });
  return { estimates };
}

async function saveOverride(ctx) {
  const b = ctx.body;
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayStr(dayMs(s)) === s;
  if (!isDay(b.from) || !isDay(b.to) || b.to < b.from || dayMs(b.to) - dayMs(b.from) > 6 * DAY) {
    throw new HttpError(400, 'Período inválido.');
  }
  const t = today();
  if (b.to < dayStr(t.ms)) throw new HttpError(400, 'Esse período já passou.');
  const qty = Number(String(b.qty ?? '').trim().replace(/\./g, (m, i, s) => (s.includes(',') ? '' : m)).replace(',', '.'));
  if (String(b.qty ?? '').trim() === '' || !Number.isFinite(qty) || qty < 0 || qty > 1e9) {
    throw new HttpError(400, 'Informe a quantidade estimada para o período.');
  }
  const itemId = Number(b.item_id);
  const item = (await db.query('select 1 from gestoque.items where id = $1', [itemId])).rows[0];
  if (!item) throw new HttpError(404, 'Item não encontrado.');

  const clash = await db.query(
    'select 1 from gestoque.overrides where item_id = $1 and date_from <> $2 and date_from <= $3 and date_to >= $2',
    [itemId, b.from, b.to]
  );
  if (clash.rows.length) throw new HttpError(409, 'Já existe um ajuste que cobre parte desse período.');

  await db.query(
    `insert into gestoque.overrides (item_id, date_from, date_to, qty, note, user_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (item_id, date_from) do update
       set date_to = excluded.date_to, qty = excluded.qty, note = excluded.note, user_id = excluded.user_id, updated_at = now()`,
    [itemId, b.from, b.to, qty, String(b.note ?? '').trim().slice(0, 200), ctx.user.id]
  );
  return { ok: true };
}

async function deleteOverride(ctx) {
  await db.query('delete from gestoque.overrides where id = $1', [Number(ctx.params[0])]);
  return { ok: true };
}

module.exports = { DEFAULTS, loadSettings, saveSettings, today, settingsAndProfiles, build, listEstimates, listManualEstimates, saveOverride, deleteOverride };
