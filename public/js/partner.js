// Registro da API (/partner): só para admin. Lista as chamadas gravadas em gestoque.api_logs e, ao
// abrir uma linha, mostra o JSON exato da solicitação e da resposta (senhas e códigos chegam como ***).
(async () => {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtWhen = (iso) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
  const icon = (d) => `<svg class="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const LOCK = '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>';

  // ---------- Modo de cor (mesmos botões do sistema) ----------

  function themeToggle() {
    const t = document.documentElement.getAttribute('data-tema') === 'escuro' ? 'escuro' : 'claro';
    document.getElementById('tema').innerHTML = `<div class="tema" role="group" aria-label="Aparência">
      <button type="button" data-tema-escolha="claro" aria-pressed="${t === 'claro'}" title="Modo claro"><img src="/img/logo-gestoque.svg" alt=""><span class="so-leitor">Modo claro</span></button>
      <button type="button" data-tema-escolha="escuro" aria-pressed="${t === 'escuro'}" title="Modo fosco escuro">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.4 14.9A8.6 8.6 0 0 1 9.1 3.6a.6.6 0 0 0-.8-.7 9.4 9.4 0 1 0 12.8 12.8.6.6 0 0 0-.7-.8z"/></svg>
        <span class="so-leitor">Modo fosco escuro</span></button>
    </div>`;
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tema-escolha]');
    if (!btn) return;
    document.documentElement.setAttribute('data-tema', btn.dataset.temaEscolha);
    try { localStorage.setItem('gt_tema', btn.dataset.temaEscolha); } catch { /* vale só nesta visita */ }
    themeToggle();
  });
  themeToggle();

  const content = document.getElementById('conteudo');
  const blocked = (title, text) => {
    content.innerHTML = `<section class="vidro painel dev-bloqueio">${icon(LOCK)}
      <div><h2>${title}</h2><p>${text}</p></div><a class="botao" href="/">Ir para o sistema</a></section>`;
  };

  // ---------- Acesso: precisa ser admin logado ----------

  let me = null;
  try { me = await (await fetch('/api/eu', { credentials: 'same-origin' })).json(); } catch { /* fora do ar */ }
  if (!me || !me.user) return blocked('Entre como administrador', 'O registro da API é só para administradores. Entre no sistema com um usuário admin e abra de novo pelo menu Configurações → Ajuda.');
  if (me.user.role !== 'admin') return blocked('Só para administradores', 'O seu usuário não tem acesso ao registro da API.');

  async function api(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'X-GT': '1', Authorization: 'Bearer ' + me.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível carregar.');
    return data;
  }

  // ---------- O que a resposta quer dizer ----------

  function outcome(method, path, status) {
    if (status >= 500) return ['erro', 'Erro no servidor'];
    const denied = { 401: 'Não autenticado', 403: 'Sem permissão', 423: 'Bloqueado', 429: 'Espera por tentativas' };
    if (denied[status]) return ['negado', denied[status]];
    const errors = { 400: 'Dado inválido', 404: 'Não encontrado', 409: 'Conflito', 413: 'Grande demais' };
    if (status >= 400) return ['erro', errors[status] || 'Erro'];
    const p = path.split('?')[0];
    if (/\/exportar$/.test(p)) return ['ok', 'Exportado'];
    if (/\/importar$/.test(p)) return ['ok', /conferir=1/.test(path) ? 'Conferido' : 'Importado'];
    if (p === '/api/entrar') return ['ok', 'Senha conferida'];
    if (p === '/api/entrar/codigo') return ['ok', 'Login concluído'];
    if (p === '/api/sair') return ['ok', 'Saiu'];
    if (p === '/api/eu/senha') return ['ok', 'Senha trocada'];
    if (p === '/api/eu/foto') return ['ok', method === 'DELETE' ? 'Foto removida' : 'Foto inserida/trocada'];
    if (p === '/api/eu/nome') return ['ok', 'Nome alterado'];
    if (/\/aprovar$/.test(p)) return ['ok', 'Aprovado'];
    if (/\/recusar$/.test(p)) return ['ok', 'Recusado'];
    return ['ok', { POST: 'Criado', PUT: 'Gravado', PATCH: 'Atualizado', DELETE: 'Excluído', GET: 'Consultado' }[method] || 'OK'];
  }

  // JSON bonito e colorido; tudo escapado antes de virar HTML.
  function prettyJson(value) {
    if (value === null || value === undefined) return '<span class="json-vazio">(sem conteúdo)</span>';
    const text = JSON.stringify(value, null, 2);
    return esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi, (m, str, colon, lit, n) => {
      if (str) return colon ? `<span class="json-chave">${str}</span>${colon}` : `<span class="json-texto">${str}</span>`;
      if (lit) return `<span class="json-lit">${lit}</span>`;
      return `<span class="json-num">${n}</span>`;
    });
  }

  // ---------- Tela ----------

  content.innerHTML = `
    <section class="vidro painel filtros-log">
      <form id="filtros">
        <label class="campo"><span>Buscar</span><input name="busca" type="search" placeholder="Caminho ou usuário: itens, maria..." autocomplete="off"></label>
        <label class="campo"><span>Resultado</span><select name="resultado">
          <option value="">Todos</option><option value="sucesso">Deu certo</option><option value="erro">Com erro</option><option value="negado">Acesso negado</option>
        </select></label>
        <label class="campo"><span>Método</span><select name="metodo">
          <option value="">Todos</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>GET</option>
        </select></label>
        <label class="campo"><span>De</span><input name="de" type="date"></label>
        <label class="campo"><span>Até</span><input name="ate" type="date"></label>
        <button class="botao claro" type="button" data-atualizar>Atualizar</button>
      </form>
      <p class="item-sub" id="aviso-retencao"></p>
    </section>
    <section class="vidro painel">
      <div class="rolagem"><table class="tabela-log">
        <thead><tr><th></th><th>Data e hora</th><th>Usuário</th><th>Solicitação</th><th>Resposta</th><th>Tempo</th></tr></thead>
        <tbody id="linhas"></tbody>
      </table></div>
      <div class="vazio" id="vazio" hidden><strong>Nenhum registro</strong><p>Nada encontrado com esses filtros.</p></div>
      <div class="mais-log"><button class="botao claro" type="button" id="mais" hidden>Carregar mais</button></div>
    </section>`;

  const form = document.getElementById('filtros');
  const tbody = document.getElementById('linhas');
  const more = document.getElementById('mais');
  let lastId = 0;

  function filterQuery() {
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) q.set(k, v);
    return q;
  }

  function rowHtml(l) {
    const [kind, label] = outcome(l.method, l.path, l.status);
    return `<tr class="log-linha" data-id="${l.id}" tabindex="0" aria-expanded="false">
      <td><span class="seta-log" aria-hidden="true"></span></td>
      <td class="quando">${esc(fmtWhen(l.created_at))}</td>
      <td>${l.user_name ? esc(l.user_name) : '<span class="item-sub">sem login</span>'}</td>
      <td><span class="metodo ${esc(l.method.toLowerCase())}">${esc(l.method)}</span> <code>${esc(l.path)}</code></td>
      <td><span class="resultado ${kind}">${l.status} · ${esc(label)}</span></td>
      <td class="item-sub">${l.duration_ms} ms</td>
    </tr>`;
  }

  async function load(reset) {
    const q = filterQuery();
    if (!reset && lastId) q.set('antes', lastId);
    more.disabled = true;
    try {
      const { logs, more: hasMore, keep_days } = await api('/api/logs?' + q);
      if (reset) tbody.innerHTML = '';
      tbody.insertAdjacentHTML('beforeend', logs.map(rowHtml).join(''));
      if (logs.length) lastId = logs[logs.length - 1].id;
      more.hidden = !hasMore;
      document.getElementById('vazio').hidden = tbody.children.length > 0;
      document.getElementById('aviso-retencao').textContent = `Ficam guardados os últimos ${keep_days} dias. Entram as ações (criar, editar, excluir, importar, entrar e sair), as exportações e qualquer pedido que deu erro. Senhas, códigos e tokens aparecem como ***.`;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`;
    } finally {
      more.disabled = false;
    }
  }

  async function toggle(row) {
    const open = row.getAttribute('aria-expanded') === 'true';
    const next = row.nextElementSibling;
    if (next && next.classList.contains('log-detalhe')) next.remove();
    row.setAttribute('aria-expanded', String(!open));
    if (open) return;
    const detail = document.createElement('tr');
    detail.className = 'log-detalhe';
    detail.innerHTML = '<td colspan="6"><p class="item-sub">Carregando...</p></td>';
    row.after(detail);
    try {
      const { log } = await api('/api/logs/' + row.dataset.id);
      const [kind, label] = outcome(log.method, log.path, log.status);
      detail.innerHTML = `<td colspan="6"><div class="log-json">
        <div class="log-caixa">
          <div class="log-caixa-topo"><strong>Solicitação</strong><span class="item-sub">${esc(log.method)} ${esc(log.path)}${log.ip ? ' · IP ' + esc(log.ip) : ''}</span>
            <button class="botao pequeno claro" type="button" data-copiar="request">Copiar</button></div>
          <pre>${prettyJson(log.request)}</pre>
        </div>
        <div class="log-caixa">
          <div class="log-caixa-topo"><strong>Resposta</strong><span class="resultado ${kind}">${log.status} · ${esc(label)}</span>
            <button class="botao pequeno claro" type="button" data-copiar="response">Copiar</button></div>
          <pre>${prettyJson(log.response)}</pre>
        </div>
      </div></td>`;
      detail.querySelectorAll('[data-copiar]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(log[b.dataset.copiar], null, 2));
          b.textContent = 'Copiado';
        } catch { b.textContent = 'Não copiou'; }
        setTimeout(() => { b.textContent = 'Copiar'; }, 1500);
      }));
    } catch (err) {
      detail.innerHTML = `<td colspan="6">${esc(err.message)}</td>`;
    }
  }

  tbody.addEventListener('click', (e) => {
    const row = e.target.closest('.log-linha');
    if (row) toggle(row);
  });
  tbody.addEventListener('keydown', (e) => {
    const row = e.target.closest('.log-linha');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(row); }
  });
  let timer = null;
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(true); });
  form.querySelector('[data-atualizar]').addEventListener('click', () => load(true));
  more.addEventListener('click', () => load(false));
  load(true);
})();
