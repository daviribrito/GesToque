// Página pública de novidades (/novidades, /versao, /release). Não precisa de login.
(() => {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (iso) => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  const anchor = (v) => 'v' + v.replace(/\./g, '-');

  // Mesma troca de modo do sistema: logo da GesToque (claro) e lua (fosco escuro).
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

  function renderRelease(r, latest) {
    return `<article class="vidro painel versao-bloco" id="${anchor(r.version)}">
      <header class="versao-cabeca">
        <div>
          <h2>Versão ${esc(r.version)}${latest ? ' <span class="selo destaque">Atual</span>' : ''}</h2>
          <p class="item-sub">${esc(fmtDate(r.date))}</p>
        </div>
      </header>
      <h3 class="versao-titulo">${esc(r.title)}</h3>
      <p class="versao-resumo">${esc(r.summary)}</p>
      <div class="versao-secoes">
        ${(r.sections || []).map((s) => `<section>
          <h3>${esc(s.title)}</h3>
          <ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        </section>`).join('')}
      </div>
      ${(r.guides || []).map((g) => `<section class="explica versao-guia">
        <strong>${esc(g.title)}</strong>
        <ol>${g.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      </section>`).join('')}
    </article>`;
  }

  (async () => {
    const box = document.getElementById('versoes');
    try {
      const res = await fetch('/api/novidades');
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.version) document.getElementById('versao-atual').textContent = 'v' + data.version;
      document.getElementById('indice').innerHTML = data.releases
        .map((r) => `<li><a href="#${anchor(r.version)}"><strong>v${esc(r.version)}</strong><span>${esc(fmtDate(r.date))}</span></a></li>`)
        .join('');
      box.innerHTML = data.releases.length
        ? data.releases.map((r, i) => renderRelease(r, i === 0)).join('')
        : '<section class="vidro painel"><div class="vazio"><strong>Nenhuma versão publicada ainda</strong></div></section>';
    } catch {
      box.innerHTML = '<section class="vidro painel"><div class="vazio"><strong>Não foi possível carregar as novidades</strong><p>Confira se o sistema está no ar e recarregue a página.</p></div></section>';
    }
  })();
})();
