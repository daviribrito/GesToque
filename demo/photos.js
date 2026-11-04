// Fotos de perfil da demonstração: guardadas no próprio banco do navegador (tabela gestoque.demo_fotos),
// no lugar do Supabase Storage. Mesma interface de server/photos.js.
const db = require('./db');
const { HttpError } = require('./security');

const MAX_BYTES = 256 * 1024;

const provider = () => 'demo';

function decode(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Envie uma imagem JPG, PNG ou WEBP.');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_BYTES) throw new HttpError(413, 'Foto grande demais. Use uma imagem menor.');
  return { buffer, type: m[1] };
}

async function put(key, buffer, type) {
  await db.query(
    'insert into gestoque.demo_fotos (key, type, data) values ($1, $2, $3) on conflict (key) do update set type = $2, data = $3',
    [key, type, new Uint8Array(buffer)]
  );
}

async function get(key) {
  const row = (await db.query('select data from gestoque.demo_fotos where key = $1', [key])).rows[0];
  return row ? Buffer.from(row.data) : null;
}

async function remove(key) {
  await db.query('delete from gestoque.demo_fotos where key = $1', [key]);
}

module.exports = { provider, decode, put, get, remove };
