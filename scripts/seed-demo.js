// Carrega itens e 90 dias de movimentações de exemplo no banco local, para conhecer o sistema.
// Recusa rodar no Supabase: os números são inventados.
const db = require('../server/db');

const ITEMS = [
  // sku, nome, categoria, unidade, custo, lote, prazo, mínimo, uso médio por dia
  ['SRV-BAU', 'Base de sorvete baunilha 10 L', 'Bases', 'balde', 89.9, 1, 5, 4, 2.4],
  ['SRV-CHO', 'Base de sorvete chocolate 10 L', 'Bases', 'balde', 94.5, 1, 5, 3, 1.3],
  ['LEI-INT', 'Leite integral 1 L', 'Laticínios', 'cx 12', 62.0, 1, 3, 5, 3.1],
  ['CAL-MOR', 'Calda de morango 1,3 kg', 'Caldas', 'un', 27.8, 6, 7, 6, 0.9],
  ['CAL-CHO', 'Calda de chocolate 1,3 kg', 'Caldas', 'un', 29.4, 6, 7, 6, 1.4],
  ['CAL-CAR', 'Calda de caramelo 1,3 kg', 'Caldas', 'un', 28.9, 6, 7, 4, 0.6],
  ['CHA-SPR', 'Chantilly spray 250 g', 'Coberturas', 'un', 17.5, 12, 7, 12, 2.2],
  ['PAC-MAL', 'Paçoca moída 1 kg', 'Complementos', 'kg', 24.0, 5, 10, 3, 0.5],
  ['BIS-ORE', 'Biscoito recheado triturado 1 kg', 'Complementos', 'kg', 38.6, 5, 10, 4, 0.8],
  ['CAF-EXP', 'Café solúvel 500 g', 'Complementos', 'un', 41.2, 4, 10, 2, 0.2],
  ['COP-400', 'Copo descartável 400 ml', 'Embalagens', 'cx 500', 185.0, 1, 14, 2, 0.31],
  ['COP-500', 'Copo descartável 500 ml', 'Embalagens', 'cx 500', 212.0, 1, 14, 2, 0.22],
  ['TAM-BOL', 'Tampa bolha', 'Embalagens', 'cx 1000', 148.0, 1, 14, 1, 0.26],
  ['CAN-LIS', 'Canudo listrado', 'Embalagens', 'cx 2000', 96.0, 1, 14, 1, 0.13],
  ['SAC-DEL', 'Sacola para delivery', 'Embalagens', 'pct 250', 58.0, 2, 14, 2, 0.18],
  ['GUA-PAP', 'Guardanapo', 'Descartáveis', 'pct 1000', 21.5, 4, 7, 4, 0.35],
];

async function main() {
  await db.init();
  if (db.kind() !== 'local') throw new Error('Os dados de exemplo só entram no banco local. Tire o DATABASE_URL do .env para testar.');
  const has = (await db.query('select count(*)::int as n from gestoque.items')).rows[0].n;
  if (has) throw new Error('O estoque já tem itens. Os dados de exemplo só entram em um banco vazio.');

  const DAY = 86400000;
  const now = Date.now();
  // Gerador previsível: o exemplo é sempre o mesmo.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  await db.tx(async (q) => {
    for (const [sku, name, category, unit, cost, pack, lead, min, daily] of ITEMS) {
      const { rows } = await q.query(
        `insert into gestoque.items (sku, name, category, unit, cost, pack_size, lead_days, min_qty)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [sku, name, category, unit, cost, pack, lead, min]
      );
      const id = rows[0].id;
      let balance = 0;
      const move = async (type, delta, at, note, unitCost) => {
        balance = Math.round((balance + delta) * 1000) / 1000;
        await q.query(
          `insert into gestoque.movements (item_id, type, delta, balance_after, unit_cost, note, occurred_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, type, delta, balance, unitCost ?? null, note, new Date(at)]
        );
      };

      await move('ajuste', Math.ceil((daily * 20) / pack) * pack, now - 92 * DAY, 'Saldo inicial');
      for (let d = 91; d >= 1; d--) {
        const at = now - d * DAY;
        const weekend = [0, 6].includes(new Date(at).getDay()) ? 1.5 : 0.85;
        const use = Math.min(balance, Math.round(daily * weekend * (0.6 + rand() * 0.8) * 100) / 100);
        if (use > 0) await move('saida', -use, at, 'Consumo do dia');
        if (balance < daily * 8) {
          await move('entrada', Math.ceil((daily * 18) / pack) * pack, at + 3600000, 'Compra', cost);
        }
      }
      await q.query('update gestoque.items set qty = $2 where id = $1', [id, balance]);
    }
  });
  console.log(`${ITEMS.length} itens de exemplo carregados com 90 dias de movimentações.`);
  await db.close();
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
