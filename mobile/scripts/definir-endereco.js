// Troca o endereço do sistema que o app abre (server.url do capacitor.config.json).
// Uso: npm run endereco -- https://seu-projeto.vercel.app
// No GitHub Actions o endereço vem da variável APP_URL do repositório.
const fs = require('fs');
const path = require('path');

const url = (process.argv[2] || process.env.APP_URL || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
  console.error('Informe o endereço com https, por exemplo: https://gestoque.vercel.app');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'capacitor.config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.server.url = url;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`O app vai abrir ${url}`);
