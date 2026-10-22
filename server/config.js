const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Lê o .env sem dependência externa. Variáveis já definidas no ambiente têm prioridade.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// No deploy de Preview da Vercel (branch Dev) o banco é o de dev: DATABASE_URL_Dev (ou DATABASE_URL_DEV).
// Ali o DATABASE_URL de produção é ignorado de propósito, para um teste nunca gravar nos dados da loja.
const PREVIEW = process.env.VERCEL_ENV === 'preview';
let databaseUrl = PREVIEW
  ? process.env.DATABASE_URL_Dev || process.env.DATABASE_URL_DEV || ''
  : process.env.DATABASE_URL || '';
if (databaseUrl.includes('[YOUR-PASSWORD]')) {
  console.warn('DATABASE_URL ainda está com [YOUR-PASSWORD]. Usando o banco local em data/ até a senha ser preenchida no .env.');
  databaseUrl = '';
}

// Supabase Storage (fotos de perfil). O endereço sai do próprio DATABASE_URL: conexão direta
// (db.<projeto>.supabase.co) ou pooler (usuário postgres.<projeto>). SUPABASE_URL força outro.
// A chave de serviço é secreta: SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SECRET_KEY); no Preview, as versões _Dev.
function supabaseRef(url) {
  try {
    const u = new URL(url);
    return (/^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname) || [])[1] || (/^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(u.username)) || [])[1] || '';
  } catch {
    return '';
  }
}
const pick = (...names) => names.map((n) => process.env[n]).find(Boolean) || '';
const ref = supabaseRef(databaseUrl);
const storageUrl = PREVIEW ? pick('SUPABASE_URL_Dev', 'SUPABASE_URL_DEV') : pick('SUPABASE_URL');
const storageKey = PREVIEW
  ? pick('SUPABASE_SERVICE_ROLE_KEY_Dev', 'SUPABASE_SERVICE_ROLE_KEY_DEV', 'SUPABASE_SECRET_KEY_Dev', 'SUPABASE_SECRET_KEY_DEV')
  : pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');

module.exports = {
  STORAGE_URL: (storageUrl || (ref ? `https://${ref}.supabase.co` : '')).replace(/\/+$/, ''),
  STORAGE_KEY: storageKey,
  STORAGE_BUCKET: 'fotos-perfil',
  ROOT,
  // require com caminho fixo: a Vercel só empacota na função os arquivos que consegue ver assim.
  VERSION: require('../package.json').version,
  PORT: Number(process.env.PORT) || 3500,
  DATABASE_URL: databaseUrl,
  DATABASE_CA_FILE: process.env.DATABASE_CA_FILE || '',
  PRODUCTION: process.env.NODE_ENV === 'production',
  // 'producao' só no deploy de produção da Vercel (branch main). Previews (Dev) e o computador são 'teste',
  // e a tela mostra um selo. GT_AMBIENTE no .env ou na Vercel força o valor.
  AMBIENTE: process.env.GT_AMBIENTE || (process.env.VERCEL_ENV === 'production' ? 'producao' : 'teste'),
  TIMEZONE: 'America/Sao_Paulo',
  STORE_NAME: 'GesToque',
};
