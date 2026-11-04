// Carrega itens e 90 dias de movimentações de exemplo no banco local, para conhecer o sistema.
// Recusa rodar no Supabase: os números são inventados. Os dados ficam em scripts/exemplo-dados.js.
const db = require('../server/db');
const exemplo = require('./exemplo-dados');

async function main() {
  await db.init();
  if (db.kind() !== 'local') throw new Error('Os dados de exemplo só entram no banco local. Tire o DATABASE_URL do .env para testar.');
  const has = (await db.query('select count(*)::int as n from gestoque.items')).rows[0].n;
  if (has) throw new Error('O estoque já tem itens. Os dados de exemplo só entram em um banco vazio.');
  await exemplo.seed(db);
  console.log(`${exemplo.ITEMS.length} itens de exemplo carregados com 90 dias de movimentações.`);
  await db.close();
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
