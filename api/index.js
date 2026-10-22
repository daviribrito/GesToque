'use strict';
// Entrada do sistema na Vercel: toda rota que não é arquivo de public/ cai aqui (ver vercel.json).
// Fora da Vercel o sistema roda por server/index.js (iniciar.cmd).
const db = require('../server/db');
const app = require('../server/app');

// Rotas que não usam o banco: respondem mesmo se o banco estiver fora.
const SEM_BANCO = /^\/api\/novidades(\?|$)/;

module.exports = async (req, res) => {
  if (SEM_BANCO.test(req.url)) return app.handle(req, res);
  try {
    await db.init();
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'O sistema está fora do ar por um instante. Tente de novo.' }));
  }
  return app.handle(req, res);
};
