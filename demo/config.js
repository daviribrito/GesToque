// Configuração da demonstração no navegador (no lugar de server/config.js, que lê o .env).
// GT_VERSAO é preenchido pelo scripts/build-demo.js com a versão do package.json.
module.exports = {
  STORAGE_URL: '',
  STORAGE_KEY: '',
  STORAGE_BUCKET: 'fotos-perfil',
  ROOT: '',
  VERSION: GT_VERSAO, // eslint-disable-line no-undef
  PORT: 0,
  DATABASE_URL: '',
  DATABASE_CA_FILE: '',
  PRODUCTION: false,
  AMBIENTE: 'demo',
  TIMEZONE: 'America/Sao_Paulo',
  STORE_NAME: 'GesToque',
};
