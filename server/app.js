const fs = require('fs');
const path = require('path');
const config = require('./config');
const auth = require('./auth');
const stock = require('./stock');
const forecast = require('./forecast');
const logs = require('./logs');
const sql = require('./sql');
const { HttpError } = require('./security');

const PUBLIC = path.join(config.ROOT, 'public');
const MAX_BODY = 6 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Notas de versão públicas. Lidas a cada acesso: editar server/novidades.json não pede reinício.
function releaseNotes() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'novidades.json'), 'utf8'));
  return { version: config.VERSION, ambiente: config.AMBIENTE, releases: data.releases || [] };
}

// Endereços públicos da página de novidades: todos abrem o mesmo arquivo.
const PAGE_ALIASES = {
  '/novidades': '/novidades.html',
  '/versao': '/novidades.html',
  '/version': '/novidades.html',
  '/release': '/novidades.html',
  '/releases': '/novidades.html',
  '/duvidas': '/duvidas.html',
  '/duvida': '/duvidas.html',
  '/manual': '/duvidas.html',
  '/duvidasdev': '/duvidasdev.html',
  '/duvidas-dev': '/duvidasdev.html',
  '/partner': '/partner.html',
};

// [método, caminho, função, acesso, descrição]. Acesso: 'aberto', 'logado' (gestor ou admin) ou 'admin'.
// 'logado' e 'admin' exigem cookie de sessão completa + token de acesso (Authorization: Bearer).
// Abertas só as que precisam funcionar antes do login ou na página pública /version.
// A descrição aparece na documentação técnica (/duvidasdev), que lê esta tabela.
const routes = [
  ['POST', /^\/api\/entrar$/, auth.login, 'aberto', 'Usuário e senha (1ª etapa do login); cria sessão provisória de 10 min'],
  ['POST', /^\/api\/entrar\/codigo$/, auth.verifyCode, 'aberto', 'Código do autenticador (2ª etapa); só com a sessão provisória. Devolve usuário + token'],
  ['POST', /^\/api\/sair$/, auth.logout, 'aberto', 'Encerra a sessão deste navegador'],
  ['GET', /^\/api\/eu$/, auth.me, 'aberto', 'Quem está logado (ou null) e o token de acesso'],
  ['GET', /^\/api\/versao$/, () => ({ version: config.VERSION }), 'logado', 'Versão atual do sistema'],
  ['GET', /^\/api\/novidades$/, releaseNotes, 'aberto', 'Notas de versão e ambiente (página pública /version e tarja de teste)'],
  ['POST', /^\/api\/eu\/senha$/, auth.changeOwnPassword, 'logado', 'Trocar a própria senha (encerra as outras sessões)'],
  ['POST', /^\/api\/eu\/ativo$/, auth.ping, 'logado', 'Avisa uso da tela e renova a sessão'],
  ['PATCH', /^\/api\/eu\/preferencias$/, auth.setPreferences, 'logado', 'Liga ou desliga "Manter ativo"'],
  ['GET', /^\/api\/eu\/perfil$/, auth.profile, 'logado', 'Perfil de quem está logado: nome, usuário, perfil, data de cadastro e foto'],
  ['GET', /^\/api\/eu\/foto$/, auth.getPhoto, 'logado', 'A própria foto (imagem). ?v=versão; cache privado de 1 ano no navegador. Nunca entra no registro'],
  ['PUT', /^\/api\/eu\/foto$/, auth.setPhoto, 'logado', 'Insere ou troca a própria foto ({ photo: data URL JPG/PNG/WEBP, até 256 KB }); vai para o Storage privado. Registro: "inserida" ou "trocada", sem a imagem'],
  ['DELETE', /^\/api\/eu\/foto$/, auth.removePhoto, 'logado', 'Remove a própria foto (apaga do Storage). Registro: "removida"'],
  ['PATCH', /^\/api\/eu\/nome$/, auth.setOwnName, 'logado', 'Troca o próprio nome ({ name }); login, perfil e situação só o admin muda'],

  ['GET', /^\/api\/itens$/, stock.listItems, 'logado', 'Lista de itens do estoque com saldo e uso por dia'],
  ['POST', /^\/api\/itens$/, stock.createItem, 'logado', 'Cadastrar item'],
  ['PATCH', /^\/api\/itens\/(\d+)$/, stock.updateItem, 'logado', 'Editar item (inclui ativar/desativar)'],
  ['DELETE', /^\/api\/itens\/(\d+)$/, stock.deleteItem, 'admin', 'Excluir item: arquiva em removed_items* e apaga, numa transação'],
  ['GET', /^\/api\/itens\/removidos$/, stock.listRemoved, 'admin', 'Lista de itens removidos'],
  ['GET', /^\/api\/itens\/removidos\/(\d+)$/, stock.removedDetail, 'admin', 'Detalhe de um item removido: dados, compras e histórico'],
  ['GET', /^\/api\/itens\/exportar$/, stock.exportItems, 'logado', 'Exportar estoque (?formato=xlsx|csv)'],
  ['POST', /^\/api\/itens\/importar$/, stock.importItems, 'logado', 'Importar planilha de estoque (?conferir=1 só confere, sem gravar)'],

  ['GET', /^\/api\/movimentacoes$/, stock.listMovements, 'logado', 'Lista de movimentações (?item=, ?tipo=)'],
  ['POST', /^\/api\/movimentacoes$/, stock.createMovement, 'logado', 'Lançar entrada, saída ou contagem'],
  ['GET', /^\/api\/movimentacoes\/exportar$/, stock.exportMovements, 'logado', 'Exportar movimentações (?formato=, ?item=, ?tipo=)'],
  ['POST', /^\/api\/movimentacoes\/importar$/, stock.importMovements, 'logado', 'Importar planilha de movimentações (?conferir=1, ?saldo=)'],

  ['GET', /^\/api\/compras$/, stock.listPurchases, 'logado', 'Histórico de compras (?item=)'],
  ['GET', /^\/api\/previsao$/, () => forecast.build(), 'logado', 'Previsão de compra em faturas mensais'],
  ['PUT', /^\/api\/metricas$/, forecast.saveSettings, 'admin', 'Salvar métricas da previsão'],
  ['GET', /^\/api\/estimativas$/, forecast.listEstimates, 'logado', 'Estimativa de uso de um item por período (?item=)'],
  ['GET', /^\/api\/estimativas\/manuais$/, forecast.listManualEstimates, 'logado', 'Todas as estimativas digitadas à mão'],
  ['PUT', /^\/api\/estimativas$/, forecast.saveOverride, 'logado', 'Salvar estimativa manual (substitui o automático)'],
  ['DELETE', /^\/api\/estimativas\/(\d+)$/, forecast.deleteOverride, 'logado', 'Apagar estimativa manual (volta ao automático)'],

  ['GET', /^\/api\/usuarios$/, auth.listUsers, 'admin', 'Lista de usuários'],
  ['POST', /^\/api\/usuarios$/, auth.createUser, 'admin', 'Criar usuário'],
  ['PATCH', /^\/api\/usuarios\/(\d+)$/, auth.updateUser, 'admin', 'Editar, desativar, trocar senha, liberar bloqueio, refazer autenticador'],

  ['GET', /^\/api\/solicitacoes$/, auth.listRequests, 'logado', 'Solicitações de usuário (gestor vê só as dele)'],
  ['POST', /^\/api\/solicitacoes$/, auth.createRequest, 'logado', 'Pedir um usuário novo'],
  ['GET', /^\/api\/solicitacoes\/pendentes$/, auth.pendingRequests, 'admin', 'Quantas solicitações aguardam (sino)'],
  ['POST', /^\/api\/solicitacoes\/(\d+)\/aprovar$/, auth.approveRequest, 'admin', 'Aprovar solicitação (cria o usuário)'],
  ['POST', /^\/api\/solicitacoes\/(\d+)\/recusar$/, auth.rejectRequest, 'admin', 'Recusar solicitação'],

  ['GET', /^\/api\/dev\/documentacao$/, devDocs, 'admin', 'Conteúdo da documentação técnica (/duvidasdev)'],

  ['GET', /^\/api\/logs$/, logs.list, 'admin', 'Registro da API (/partner): lista sem o JSON (?antes=, ?resultado=, ?metodo=, ?busca=, ?de=, ?ate=)'],
  ['GET', /^\/api\/logs\/(\d+)$/, logs.detail, 'admin', 'Registro da API: pedido e resposta completos de uma chamada'],

  ['GET', /^\/api\/sql\/tabelas$/, sql.tables, 'admin', 'Consulta SQL: tabelas e colunas que o papel de leitura enxerga'],
  ['POST', /^\/api\/sql$/, sql.run, 'admin', 'Consulta SQL só de leitura ({ sql }), com papel gestoque_leitura, até 1000 linhas e 8 s'],
];

// Documentação técnica (/duvidasdev): o texto fica em server/paginas (fora de public/, que a Vercel
// serve direto) e só sai por esta rota de admin. A lista de APIs vem da própria tabela de rotas.
function devDocs() {
  const routePath = (re) => re.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\(\\d\+\)/g, ':id');
  return {
    version: config.VERSION,
    ambiente: config.AMBIENTE,
    html: fs.readFileSync(path.join(__dirname, 'paginas', 'duvidasdev.html'), 'utf8'),
    routes: routes.map(([method, re, , access, description]) => ({ method, path: routePath(re), access, description })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Arquivo grande demais. O limite é 6 MB.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
}

// log: registro desta chamada (server/logs.js), preenchido aos poucos e gravado antes da resposta sair.
async function handleApi(req, res, url, log) {
  const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
  if (!route) throw new HttpError(404, 'Recurso não encontrado.');
  const [, re, handler, access] = route;

  if (req.method !== 'GET') {
    // Cabeçalho próprio + conferência de origem: um site de terceiros não consegue disparar ações.
    const origin = req.headers.origin;
    if (req.headers['x-gt'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) {
      throw new HttpError(403, 'Requisição recusada.');
    }
  }

  const ctx = { req, res, url, params: url.pathname.match(re).slice(1), body: {}, raw: null, user: null };

  // O corpo é lido antes da conferência de acesso para o registro guardar até o que foi negado.
  if (req.method !== 'GET') {
    ctx.raw = await readBody(req);
    const json = (req.headers['content-type'] || '').includes('application/json');
    log.request = json ? null : ctx.raw.length ? { _arquivo: 'enviado', bytes: ctx.raw.length } : null;
    if (json && ctx.raw.length) {
      try {
        ctx.body = JSON.parse(ctx.raw.toString('utf8')) || {};
      } catch {
        throw new HttpError(400, 'Dados inválidos.');
      }
      log.request = ctx.body;
    }
    if (typeof ctx.body.username === 'string') log.userHint = `(login tentado: ${ctx.body.username.slice(0, 40)})`;
  }

  if (url.pathname === '/api/sair') {
    // Só para o registro saber quem saiu; a rota é aberta e não depende disso.
    const session = await auth.loadSession(req);
    if (session && session.mfa_ok) log.user = session;
  }
  if (access !== 'aberto') {
    const session = await auth.loadSession(req);
    if (session && session.mfa_ok) {
      if (auth.checkApiToken(req)) log.user = session;
      else log.userHint = `${session.name} (${session.username}) · sem token válido`;
    }
    // Precisa da sessão completa (cookie) e do token de acesso no cabeçalho, em qualquer método.
    if (!session || !session.mfa_ok || !auth.checkApiToken(req)) throw new HttpError(401, 'Entre para continuar.');
    if (access === 'admin' && session.role !== 'admin') throw new HttpError(403, 'Apenas admin pode fazer isso.');
    // Renovar o fim da sessão não precisa segurar a resposta: corre junto com o pedido.
    log.side.push(auth.touchSession(session).catch((err) => console.error('Sessão:', err.message)));
    ctx.user = session;
  }

  const out = await handler(ctx);
  if (!log.user && out && out.user) log.user = out.user; // login concluído: quem entrou
  if (out && out.file) {
    log.side.push(logs.write(log, 200, { _arquivo: out.name, bytes: out.file.length }));
    await logs.afterReply(log.side);
    // inline: para mostrar na tela (ex.: foto), com o cache que a rota pedir; senão, download sem cache.
    res.writeHead(200, {
      'Content-Type': out.type,
      'Content-Disposition': out.inline ? 'inline' : `attachment; filename="${out.name}"`,
      'Cache-Control': out.cache || 'no-store',
      'Content-Length': out.file.length,
    });
    return res.end(out.file);
  }
  // ctx.logResponse: a rota pede para registrar um resumo no lugar da resposta (ex.: Consulta SQL, cujo resultado não é guardado).
  log.side.push(logs.write(log, 200, ctx.logResponse || out || { ok: true }));
  await logs.afterReply(log.side);
  sendJson(res, 200, out || { ok: true });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  const clean = url.pathname.replace(/\/+$/, '') || '/';
  const rel = clean === '/' ? '/index.html' : PAGE_ALIASES[clean.toLowerCase()] || decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, 'Página não encontrada.');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  securityHeaders(res);
  let isApi = false;
  let log = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    isApi = url.pathname.startsWith('/api/');
    if (isApi) {
      log = {
        started: Date.now(),
        method: req.method,
        path: url.pathname,
        fullPath: url.pathname + url.search,
        ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60),
        request: null,
        user: null,
        side: [], // trabalho que roda junto e termina depois da resposta (ver logs.afterReply)
      };
      await handleApi(req, res, url, log);
    } else serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    const message = status === 500 ? 'Algo deu errado no servidor. Tente de novo.' : err.message;
    if (log) {
      log.side.push(logs.write(log, status, { error: message, ...(err.extra || {}) }));
      await logs.afterReply(log.side);
    }
    if (isApi) sendJson(res, status, { error: message, ...(err.extra || {}) });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
  }
}

module.exports = { handle };
