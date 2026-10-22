// Fotos de perfil: arquivos no Supabase Storage (bucket privado fotos-perfil) ou, com banco local, em data/fotos.
// Nada é público: o servidor lê e grava com a chave de serviço e entrega a foto só pela API, para quem está
// logado. O navegador guarda em cache pela versão (endereço /api/eu/foto?v=N), então só baixa de novo quando
// a foto muda.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { HttpError } = require('./security');

const LOCAL_DIR = path.join(config.ROOT, 'data', 'fotos');
const MAX_BYTES = 256 * 1024; // igual ao limite do bucket; a tela manda ~5–40 KB

// 'supabase' com a chave configurada; 'local' com banco local (sem DATABASE_URL); senão, sem lugar para fotos.
function provider() {
  if (config.STORAGE_KEY && config.STORAGE_URL) return 'supabase';
  if (!config.DATABASE_URL) return 'local';
  return null;
}

const objectUrl = (key, read) =>
  `${config.STORAGE_URL}/storage/v1/object/${read ? 'authenticated/' : ''}${config.STORAGE_BUCKET}/${key}`;
const authHeaders = () => ({ apikey: config.STORAGE_KEY, Authorization: `Bearer ${config.STORAGE_KEY}` });
const localFile = (key) => path.join(LOCAL_DIR, key.replace(/[^a-z0-9]+/gi, '_'));

// Data URL vindo da tela -> bytes, conferindo pelo começo do arquivo que é mesmo a imagem que diz ser.
function decode(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Envie uma imagem JPG, PNG ou WEBP.');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_BYTES) throw new HttpError(413, 'Foto grande demais. Use uma imagem menor.');
  const type = m[1];
  const ok =
    (type === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (type === 'image/png' && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (type === 'image/webp' && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP');
  if (!ok) throw new HttpError(400, 'O arquivo não é uma imagem válida.');
  return { buffer, type };
}

async function put(key, buffer, type) {
  const p = provider();
  if (p === 'supabase') {
    const res = await fetch(objectUrl(key), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': type, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
      body: buffer,
    });
    if (!res.ok) throw new Error(`Storage recusou a foto (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (p === 'local') {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(localFile(key), buffer);
    return;
  }
  throw new HttpError(503, 'Fotos indisponíveis: o Storage não está configurado neste ambiente.');
}

// Bytes da foto, ou null se não existir.
async function get(key) {
  const p = provider();
  if (p === 'supabase') {
    const res = await fetch(objectUrl(key, true), { headers: authHeaders() });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`Storage não entregou a foto (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (p === 'local') {
    try { return fs.readFileSync(localFile(key)); } catch { return null; }
  }
  return null;
}

async function remove(key) {
  const p = provider();
  if (p === 'supabase') {
    const res = await fetch(objectUrl(key), { method: 'DELETE', headers: authHeaders() });
    if (!res.ok && res.status !== 404 && res.status !== 400) throw new Error(`Storage não apagou a foto (${res.status}).`);
  } else if (p === 'local') {
    try { fs.unlinkSync(localFile(key)); } catch { /* já não existia */ }
  }
}

module.exports = { provider, decode, put, get, remove };
