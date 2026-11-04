// Itens genéricos (embalagens, descartáveis, mercearia, limpeza, EPI) e 90 dias de movimentações de exemplo. Usado pelo carregar-exemplo (banco local, scripts/seed-demo.js)
// e pela demonstração no navegador (demo/navegador.js). Os números são inventados.

const ITEMS = [
  // sku, nome, categoria, unidade, custo, lote, prazo, mínimo, uso médio por dia
  // Genérico: embalagens, descartáveis, mercearia de restaurante, limpeza e EPI.
  ['CX-4030', 'Caixa de papelão 40×30×20', 'Embalagens', 'un', 3.9, 25, 7, 60, 6.5],
  ['CX-6040', 'Caixa de papelão 60×40×40', 'Embalagens', 'un', 7.4, 25, 7, 30, 2.8],
  ['FIT-ADE', 'Fita adesiva transparente 45 mm', 'Embalagens', 'rolo', 6.2, 12, 5, 24, 2.1],
  ['SAC-KRA', 'Sacola kraft média', 'Embalagens', 'pct 100', 38.0, 5, 10, 4, 0.45],
  ['COP-300', 'Copo descartável 300 ml', 'Descartáveis', 'cx 1000', 89.0, 1, 10, 3, 0.32],
  ['GUA-PAP', 'Guardanapo de papel', 'Descartáveis', 'pct 1000', 21.5, 4, 7, 4, 0.35],
  ['TAL-DES', 'Talher descartável (kit)', 'Descartáveis', 'cx 500', 64.0, 1, 10, 2, 0.14],
  ['MAR-ALU', 'Marmita de alumínio 750 ml', 'Descartáveis', 'cx 100', 72.0, 2, 10, 3, 0.4],
  ['OLE-SOJ', 'Óleo de soja 900 ml', 'Mercearia', 'cx 20', 158.0, 1, 4, 2, 0.55],
  ['ARR-T1', 'Arroz tipo 1 5 kg', 'Mercearia', 'fardo 6', 149.0, 1, 5, 2, 0.4],
  ['FEI-CAR', 'Feijão carioca 1 kg', 'Mercearia', 'fardo 10', 79.0, 1, 5, 2, 0.35],
  ['FAR-TRI', 'Farinha de trigo 5 kg', 'Mercearia', 'saco', 27.5, 4, 5, 6, 0.9],
  ['ACU-REF', 'Açúcar refinado 1 kg', 'Mercearia', 'fardo 10', 46.0, 1, 5, 2, 0.3],
  ['LEI-INT', 'Leite integral 1 L', 'Laticínios', 'cx 12', 62.0, 1, 3, 5, 1.6],
  ['DET-5L', 'Detergente neutro 5 L', 'Limpeza', 'galão', 24.9, 4, 7, 4, 0.5],
  ['ALC-70', 'Álcool 70% 1 L', 'Limpeza', 'un', 9.8, 12, 7, 12, 1.4],
  ['PAN-MUL', 'Pano multiuso (rolo)', 'Limpeza', 'rolo', 32.0, 2, 7, 3, 0.25],
  ['LUV-NIT', 'Luva nitrílica M', 'EPI', 'cx 100', 42.0, 5, 10, 5, 0.6],
  ['TOU-DES', 'Touca descartável', 'EPI', 'pct 100', 18.5, 5, 10, 3, 0.2],
];

// Grava os itens e as movimentações numa transação. db: o módulo de banco (server/db.js ou demo/db.js).
async function seed(db) {
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
        // Item que sai 1 ou mais por dia (caixa, rolo, frasco) sai em número inteiro; os de pouca saída, em fração da embalagem.
        const raw = daily * weekend * (0.6 + rand() * 0.8);
        const use = Math.min(balance, daily >= 1 ? Math.round(raw) : Math.round(raw * 100) / 100);
        if (use > 0) await move('saida', -use, at, 'Consumo do dia');
        if (balance < daily * 8) {
          await move('entrada', Math.ceil((daily * 18) / pack) * pack, at + 3600000, 'Compra', cost);
        }
      }
      await q.query('update gestoque.items set qty = $2 where id = $1', [id, balance]);
    }
  });
}

// Sobe quando a lista de itens muda: a demonstração no navegador recomeça sozinha uma vez com o exemplo novo.
const VERSION = 2;

module.exports = { ITEMS, VERSION, seed };
