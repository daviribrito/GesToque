const http = require('http');
const config = require('./config');
const db = require('./db');
const app = require('./app');

async function main() {
  await db.init();
  const users = (await db.query('select count(*)::int as n from gestoque.users')).rows[0].n;
  const server = http.createServer(app.handle);
  server.listen(config.PORT, () => {
    console.log(`\n  ${config.STORE_NAME} - gestão de estoque`);
    console.log(`  Banco: ${db.kind() === 'supabase' ? 'Supabase' : 'local em data/ (preencha DATABASE_URL no .env para usar o Supabase)'}`);
    console.log(`  Abra http://localhost:${config.PORT}\n`);
    if (!users) console.log('  Ainda não há usuários. Rode configurar-admin.cmd para criar o primeiro admin.\n');
  });

  const stop = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Não foi possível iniciar:', err.message);
  process.exit(1);
});
