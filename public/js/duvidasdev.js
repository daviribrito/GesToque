// Documentação técnica (/duvidasdev): só para admin. A página é uma casca; o conteúdo vem de
// GET /api/dev/documentacao, que o servidor só entrega com sessão de admin + token de acesso.
(async () => {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICONS = {
    camadas: '<path d="M12 3 2 8l10 5 10-5z"/><path d="m2 13 10 5 10-5M2 17.5 12 22l10-4.5"/>',
    api: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
    chave: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
    escudo: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
    lista: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    banco: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    nuvem: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/>',
    paginas: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    ferramenta: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    cadeado: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  };
  const icon = (name) => `<svg class="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.lista}</svg>`;

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

  function blocked(title, text) {
    content.innerHTML = `<section class="vidro painel dev-bloqueio">
      ${icon('cadeado')}
      <div><h2>${title}</h2><p>${text}</p></div>
      <a class="botao" href="/">Ir para o sistema</a>
    </section>`;
  }

  // ---------- Acesso: precisa ser admin logado ----------

  let me = null;
  try { me = await (await fetch('/api/eu', { credentials: 'same-origin' })).json(); } catch { /* fora do ar */ }
  if (!me || !me.user) return blocked('Entre como administrador', 'Esta documentação é só para administradores. Entre no sistema com um usuário admin e abra de novo pelo menu Configurações → Ajuda.');
  if (me.user.role !== 'admin') return blocked('Só para administradores', 'O seu usuário não tem acesso a esta documentação. Para dúvidas de uso, veja a Central de dúvidas.');

  let docs;
  try {
    const res = await fetch('/api/dev/documentacao', { credentials: 'same-origin', headers: { 'X-GT': '1', Authorization: 'Bearer ' + me.token } });
    docs = await res.json();
    if (!res.ok) throw new Error(docs.error);
  } catch (err) {
    return blocked('Não foi possível carregar', esc((err && err.message) || 'Tente de novo em instantes.'));
  }

  // O texto vem do próprio servidor (server/paginas/duvidasdev.html), não de quem usa o sistema.
  content.innerHTML = docs.html + `<p class="manual-fim">Versão ${esc(docs.version)} · ambiente ${esc(docs.ambiente)} · ${docs.routes.length} rotas na API</p>`;

  // ---------- Lista de APIs, direto da tabela de rotas ----------

  const LEVEL = { aberto: 'aberto', logado: 'logado', admin: 'admin' };
  const groups = [
    ['Abertas', (r) => r.access === 'aberto'],
    ['Logado (admin ou gestor)', (r) => r.access === 'logado'],
    ['Só admin', (r) => r.access === 'admin'],
  ];
  document.getElementById('lista-apis').innerHTML = groups.map(([title, pick]) => {
    const rows = docs.routes.filter(pick);
    return `<h3>${title} <small>(${rows.length})</small></h3>
      <div class="rolagem"><table class="tabela-apis">
        <thead><tr><th>Método</th><th>Caminho</th><th>Acesso</th><th>Para quê</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><span class="metodo ${esc(r.method.toLowerCase())}">${esc(r.method)}</span></td>
          <td><code>${esc(r.path)}</code></td>
          <td><span class="nivel ${LEVEL[r.access] || ''}">${esc(r.access)}</span></td>
          <td>${esc(r.description)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }).join('');

  // ---------- Índice e busca ----------

  const topics = [...content.querySelectorAll('.topico')];
  const goTo = (el) => el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  const index = document.getElementById('indice');
  index.innerHTML = topics.map((t) => `<li><button type="button" data-ir="${t.id}">${icon(t.dataset.icone)}<span>${esc(t.dataset.titulo)}</span></button></li>`).join('');
  index.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ir]');
    if (b) goTo(document.getElementById(b.dataset.ir));
  });
  index.closest('nav').hidden = false;

  const search = document.getElementById('busca');
  const result = document.getElementById('busca-resultado');
  search.closest('label').hidden = false;
  search.addEventListener('input', () => {
    const q = norm(search.value.trim());
    let found = 0;
    for (const t of topics) {
      const hit = !q || norm(t.textContent).includes(q);
      t.hidden = !hit;
      if (hit && q) found++;
      if (q.length >= 3) t.querySelectorAll('details').forEach((d) => { if (norm(d.textContent).includes(q)) d.open = true; });
    }
    result.textContent = !q ? '' : found ? `${found} ${found === 1 ? 'assunto encontrado' : 'assuntos encontrados'}.` : 'Nada encontrado. Tente "token", "cookie" ou "rota".';
  });
})();
