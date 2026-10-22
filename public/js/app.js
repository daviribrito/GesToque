// GesToque — aplicação de página única.
// A navegação troca de tela só por JavaScript: o endereço do navegador nunca muda.
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const $dialog = document.getElementById('dialogo');
  const $toasts = document.getElementById('avisos');

  const state = { user: null, view: 'estoque', items: [], windowDays: 90, forecast: null, month: null, filter: { text: '', category: '', moveType: '' } };

  // ---------- Utilidades ----------

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtQty = (n) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(n ?? 0);
  const fmtMoney = (n) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0);
  const fmtDate = (iso) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  const fmtWhen = (iso) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
  const monthName = (m, style = 'long') => new Intl.DateTimeFormat('pt-BR', { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, m - 1, 1))).replace('.', '');
  const isAdmin = () => state.user && state.user.role === 'admin';

  // Barra fina de carregamento no topo: aparece se alguma chamada passar de 120 ms, para o clique
  // nunca parecer ignorado. O aviso de uso em segundo plano (/api/eu/ativo) também conta, mas é rápido.
  const $busy = document.createElement('div');
  $busy.className = 'carregando-barra';
  $busy.setAttribute('aria-hidden', 'true');
  document.body.append($busy);
  let busyCount = 0;
  let busyTimer = null;
  function busy(delta) {
    busyCount = Math.max(0, busyCount + delta);
    if (busyCount && !busyTimer && !$busy.classList.contains('ativa')) {
      busyTimer = setTimeout(() => { busyTimer = null; if (busyCount) $busy.classList.add('ativa'); }, 120);
    }
    if (!busyCount) {
      clearTimeout(busyTimer);
      busyTimer = null;
      $busy.classList.remove('ativa');
    }
  }

  // Token de acesso da API: vem do servidor no login (/api/entrar/codigo) e em /api/eu, fica só na
  // memória desta página e vai em toda chamada. Sem ele, as rotas que pedem login respondem 401.
  async function api(method, path, body, extraHeaders) {
    const opt = { method, headers: { 'X-GT': '1', ...extraHeaders }, credentials: 'same-origin' };
    if (state.token) opt.headers.Authorization = 'Bearer ' + state.token;
    if (body instanceof Blob) {
      opt.body = body;
      opt.headers['Content-Type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      opt.body = JSON.stringify(body);
      opt.headers['Content-Type'] = 'application/json';
    }
    let res;
    busy(+1);
    try {
      res = await fetch(path, opt);
    } catch {
      throw new Error('Sem conexão com o servidor. Confira se o sistema está aberto e tente de novo.');
    } finally {
      busy(-1);
    }
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : await res.blob();
    if (!res.ok) {
      if (res.status === 401 && state.user) sessionEnded();
      const err = new Error((isJson && data.error) || 'Não foi possível concluir. Tente de novo.');
      err.data = data;
      throw err;
    }
    if (isJson && (path === '/api/eu' || path === '/api/entrar/codigo')) state.token = data.token || null;
    if (!isJson) {
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
      return { blob: data, name: name ? name[1] : 'arquivo' };
    }
    return data;
  }

  function toast(message, isError) {
    const el = document.createElement('div');
    el.className = 'aviso' + (isError ? ' erro' : '');
    el.textContent = message;
    $toasts.append(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3500);
  }

  function saveFile({ blob, name }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Envia um formulário mostrando o erro no próprio formulário e travando o botão enquanto salva.
  // Erro com espera (código ou senha errados): a mensagem conta o tempo ao vivo e o botão só volta no fim.
  async function submitWith(form, fn) {
    const btn = form.querySelector('[type=submit]');
    const errEl = form.querySelector('.erro-form');
    if (errEl) {
      clearInterval(errEl.contagem);
      errEl.textContent = '';
    }
    btn.disabled = true;
    let waiting = false;
    try {
      await fn(Object.fromEntries(new FormData(form)));
    } catch (err) {
      const d = err.data || {};
      if (errEl && d.retry_in > 0 && d.message_template) waiting = countdown(errEl, btn, d.message_template, d.retry_in);
      else if (errEl) errEl.textContent = err.message;
      else toast(err.message, true);
    } finally {
      if (!waiting) btn.disabled = false;
    }
  }

  // "16 min 40 s", "45 segundos", "1 segundo".
  function waitLabel(s) {
    if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    return s === 1 ? '1 segundo' : `${s} segundos`;
  }

  // O leitor de tela ouve a frase uma vez (parte .so-leitor); o número que muda a cada segundo fica
  // só na parte visual (aria-hidden), para não ser repetido sem parar.
  function countdown(errEl, btn, template, seconds) {
    const end = Date.now() + seconds * 1000;
    const label = btn.textContent;
    errEl.innerHTML = `<span class="so-leitor">${esc(template.replace('{tempo}', waitLabel(seconds)))}</span><span aria-hidden="true" data-vivo></span>`;
    const live = errEl.querySelector('[data-vivo]');
    const tick = () => {
      if (!errEl.isConnected) return clearInterval(errEl.contagem); // a tela mudou
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      if (!left) {
        clearInterval(errEl.contagem);
        errEl.textContent = 'Pronto, pode tentar de novo.';
        btn.textContent = label;
        btn.disabled = false;
        return;
      }
      live.textContent = template.replace('{tempo}', waitLabel(left));
      btn.textContent = `Aguarde ${waitLabel(left)}`;
    };
    tick();
    errEl.contagem = setInterval(tick, 1000);
    return true;
  }

  function openDialog(html, onReady, extraClass = '') {
    $dialog.className = `vidro ${extraClass}`.trim();
    $dialog.innerHTML = `<button class="fechar-x" type="button" data-fechar aria-label="Fechar">×</button>${html}`;
    $dialog.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', closeDialog));
    document.documentElement.classList.add('travado');
    if (!$dialog.open) $dialog.showModal();
    if (onReady) onReady($dialog);
  }
  function closeDialog() {
    if ($dialog.open) $dialog.close();
    $dialog.innerHTML = '';
  }
  $dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('travado');
    // Alerta de estoque que ficou esperando a janela anterior fechar.
    if (state.alertPending) {
      state.alertPending = false;
      setTimeout(() => maybeLowStockAlert(), 400);
    }
  });

  // Fecha ao clicar fora da caixa. Só conta se o clique começou e terminou fora:
  // arrastar a seleção de um campo para fora não fecha o diálogo.
  const outside = (e) => {
    const r = $dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  $dialog.addEventListener('pointerdown', (e) => { pressedOutside = e.target === $dialog && outside(e); });
  $dialog.addEventListener('click', (e) => {
    if (pressedOutside && e.target === $dialog && outside(e)) closeDialog();
    pressedOutside = false;
  });

  // ---------- Modo de cor: claro ou fosco escuro ----------
  // A escolha fica no navegador; o tema.js aplica antes da página aparecer.

  const currentTheme = () => (document.documentElement.getAttribute('data-tema') === 'escuro' ? 'escuro' : 'claro');

  function themeToggle(extraClass = '') {
    const t = currentTheme();
    return `<div class="tema ${extraClass}" role="group" aria-label="Aparência">
      <button type="button" data-tema-escolha="claro" aria-pressed="${t === 'claro'}" title="Modo claro">
        <img src="/img/logo-gestoque.svg" alt=""><span class="so-leitor">Modo claro</span>
      </button>
      <button type="button" data-tema-escolha="escuro" aria-pressed="${t === 'escuro'}" title="Modo fosco escuro">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.4 14.9A8.6 8.6 0 0 1 9.1 3.6a.6.6 0 0 0-.8-.7 9.4 9.4 0 1 0 12.8 12.8.6.6 0 0 0-.7-.8z"/></svg>
        <span class="so-leitor">Modo fosco escuro</span>
      </button>
    </div>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tema-escolha]');
    if (!btn) return;
    const tema = btn.dataset.temaEscolha;
    document.documentElement.setAttribute('data-tema', tema);
    try { localStorage.setItem('gt_tema', tema); } catch { /* sem armazenamento: vale só nesta visita */ }
    document.querySelectorAll('[data-tema-escolha]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.temaEscolha === tema)));
  });

  // ---------- Sessão: uso, inatividade e fim ----------
  // O servidor decide quando a sessão termina (45 min sem uso, ou nunca com "Manter ativo").
  // A tela avisa o servidor quando a pessoa mexe e confere a cada minuto se a sessão ainda vale.

  const activity = { last: Date.now(), ping: Date.now() };

  function noteActivity() {
    activity.last = Date.now();
    if (state.user && Date.now() - activity.ping > 60000) {
      activity.ping = Date.now();
      api('POST', '/api/eu/ativo').catch(() => {});
    }
  }
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, noteActivity, { passive: true }));

  function sessionEnded() {
    if (!state.user) return;
    const idle = !state.user.keep_alive && Date.now() - activity.last >= (state.user.idle_minutes - 1) * 60000;
    state.user = null;
    state.token = null;
    closeDialog();
    renderLogin(idle
      ? 'Sua sessão foi encerrada depois de um tempo sem uso. Entre de novo.'
      : 'Sua sessão foi encerrada. Pode ter havido um novo login com este usuário. Entre de novo.');
  }

  setInterval(async () => {
    if (!state.user) return;
    try {
      const me = await api('GET', '/api/eu');
      if (!me.user) return sessionEnded();
      maybeLowStockAlert();
      if (isAdmin()) updateBell();
    } catch { /* sem conexão: tenta no próximo minuto */ }
  }, 60000);

  // ---------- Aviso de versão nova ----------
  // Ao entrar (ou recarregar já logado), se a versão mudou desde a última que esta pessoa viu neste
  // navegador, mostra o que foi implementado, melhorado e ajustado (notas em server/novidades.json, com
  // "type" em cada seção). Abre antes do alerta de estoque, que espera a janela fechar.

  const SEEN_KEY = () => `gt_versao_vista_${state.user.id}`;
  const TYPE_INFO = {
    novo: { label: 'Novo', icon: '<path d="M12 3l2.3 5.3L20 9l-4.3 3.8L17 18.5 12 15.6 7 18.5l1.3-5.7L4 9l5.7-.7z"/>' },
    melhoria: { label: 'Melhoria', icon: '<path d="M4 17l6-6 4 4 6-7"/><path d="M15 8h5v5"/>' },
    ajuste: { label: 'Ajuste', icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>' },
  };

  async function maybeWhatsNew() {
    if (!state.user) return;
    let release;
    try {
      const notes = await (await fetch('/api/novidades')).json();
      release = (notes.releases || [])[0];
      if (!release || release.version !== notes.version) return;
    } catch { return; }
    let seen = null;
    try { seen = localStorage.getItem(SEEN_KEY()); } catch { seen = state.seenVersionMem; }
    if (seen === release.version || !state.user || $dialog.open) return;
    whatsNewDialog(release);
    state.seenVersionMem = release.version;
    try { localStorage.setItem(SEEN_KEY(), release.version); } catch { /* vale só nesta visita */ }
  }

  function whatsNewDialog(r) {
    let n = 0; // ordem de entrada de cada item na animação
    const when = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(r.date + 'T00:00:00Z'));
    openDialog(`
      <div class="novidade">
        <div class="novidade-topo">
          <img class="novidade-mascote" src="/img/caixa.svg" alt="">
          <div>
            <span class="novidade-selo">Versão nova</span>
            <h2>Chegou a versão ${esc(r.version)}</h2>
            <p class="item-sub">${esc(when)}</p>
            <p class="novidade-titulo">${esc(r.title)}</p>
          </div>
        </div>
        <div class="novidade-grupos">
          ${(r.sections || []).map((s) => {
            const t = TYPE_INFO[s.type] || TYPE_INFO.melhoria;
            return `<section class="novidade-grupo tipo-${esc(s.type || 'melhoria')}" style="--i:${n++}">
              <h3><span class="novidade-tipo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.icon}</svg>${t.label}</span>${esc(s.title)}</h3>
              <ul>${s.items.map((it) => `<li style="--i:${n++}">${esc(it)}</li>`).join('')}</ul>
            </section>`;
          }).join('')}
        </div>
        <div class="rodape">
          <a class="botao claro" href="/version" data-novidades>Ver todas as novidades</a>
          <button class="botao" type="button" data-fechar>Entendi</button>
        </div>
      </div>`, (dlg) => {
      // Ao voltar do /version, o "Voltar ao sistema" traz para a tela em que a pessoa estava.
      dlg.querySelector('[data-novidades]').addEventListener('click', () => {
        try { sessionStorage.setItem('gt_voltar', state.view); } catch { /* sem botão de voltar */ }
      });
      // Foco no "Entendi" para quem usa teclado, sem rolar: no celular a janela é alta e o topo sumiria.
      dlg.querySelector('.rodape .botao:not(.claro)').focus({ preventScroll: true });
      dlg.scrollTop = 0;
    }, 'novidade-dialogo');
  }

  // ---------- Alerta de itens abaixo do mínimo ----------
  // Aparece ao entrar e depois a cada 3 horas, mesmo sem sair do sistema.
  // A hora do último alerta fica guardada no navegador, por usuário, para recarregar a página não repetir.

  const ALERT_EVERY_MS = 3 * 60 * 60 * 1000;
  const alertKey = () => `gt_alerta_${state.user.id}`;
  function lastAlert() {
    try { return Number(localStorage.getItem(alertKey())) || 0; } catch { return state.lastAlertMem || 0; }
  }
  function markAlert() {
    state.lastAlertMem = Date.now();
    try { localStorage.setItem(alertKey(), String(state.lastAlertMem)); } catch { /* fica só em memória */ }
  }

  async function maybeLowStockAlert(force = false) {
    if (!state.user || state.alertBusy) return;
    if (!force && Date.now() - lastAlert() < ALERT_EVERY_MS) return;
    // Não interrompe quem está no meio de uma edição: espera a janela fechar.
    if ($dialog.open) { state.alertPending = true; return; }
    state.alertBusy = true;
    try {
      await loadItems();
      markAlert();
      const low = state.items
        .filter((i) => i.active && (i.qty <= 0 || i.qty <= i.min_qty))
        // Sem estoque primeiro; depois quem está mais longe do mínimo.
        .sort((a, b) => (b.qty <= 0) - (a.qty <= 0) || a.qty / (a.min_qty || 1) - b.qty / (b.min_qty || 1));
      if (low.length && state.user && !$dialog.open) lowStockDialog(low);
    } catch { /* tenta de novo no próximo ciclo */ } finally {
      state.alertBusy = false;
    }
  }

  function lowStockDialog(low) {
    const many = low.length > 1;
    openDialog(`
      <div class="alerta-estoque">
        <img class="mascote-susto" src="/img/caixa-assustada.svg" alt="">
        <div>
          <h2>Atenção! Tem item acabando</h2>
          <p>${many ? `${low.length} itens estão` : '1 item está'} no estoque mínimo ou abaixo dele. É necessário comprar ${many ? 'esses itens' : 'esse item'}.</p>
          <p class="item-sub">Se algum número parecer errado, confira a prateleira e registre uma contagem para corrigir antes de comprar.</p>
        </div>
      </div>
      <div class="lista-alerta">
        ${low.map((i) => {
          const zero = i.qty <= 0;
          return `<details>
            <summary>
              <span class="seta" aria-hidden="true"></span>
              <span class="item-nome">${esc(i.name)}</span>
              <span class="selo ${zero ? 'zerado' : 'baixo'}">${zero ? 'Sem estoque' : `${fmtQty(i.qty)} de ${fmtQty(i.min_qty)} ${esc(i.unit)}`}</span>
            </summary>
            <div class="detalhe">
              <dl>
                <div><dt>Em estoque</dt><dd>${fmtQty(i.qty)} ${esc(i.unit)}</dd></div>
                <div><dt>Mínimo</dt><dd>${fmtQty(i.min_qty)} ${esc(i.unit)}</dd></div>
                <div><dt>Dura</dt><dd>${i.cover_days === null ? '-' : i.cover_days + ' dias'}</dd></div>
                <div><dt>Uso por dia</dt><dd>${i.daily ? fmtQty(i.daily) : '-'}</dd></div>
                <div><dt>Custo atual</dt><dd>${fmtMoney(i.cost)}</dd></div>
                <div><dt>Fornecedor</dt><dd>${esc(i.supplier) || '-'}</dd></div>
              </dl>
              <div class="linha-acoes">
                <button class="botao pequeno claro" type="button" data-contar="${i.id}">Conferir estoque</button>
                <button class="botao pequeno destaque" type="button" data-comprar="${i.id}">Registrar compra</button>
              </div>
            </div>
          </details>`;
        }).join('')}
      </div>
      <div class="rodape">
        <button class="botao claro" type="button" data-previsao>Ver previsão de compra</button>
        <button class="botao" type="button" data-fechar>Entendi</button>
      </div>`, (dlg) => {
      dlg.querySelector('.lista-alerta').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-contar], [data-comprar]');
        if (!btn) return;
        const item = state.items.find((i) => i.id === Number(btn.dataset.contar || btn.dataset.comprar));
        if (btn.dataset.contar) movementDialog({ item, type: 'ajuste' });
        else movementDialog({ item, type: 'entrada', cost: String(item.cost).replace('.', ',') });
      });
      dlg.querySelector('[data-previsao]').addEventListener('click', () => { closeDialog(); go('previsao'); });
      if (low.length <= 3) dlg.querySelectorAll('details').forEach((d) => { d.open = true; });
    }, 'alerta');
  }

  // ---------- Entrada (usuário e senha + código do autenticador) ----------

  function renderLogin(message) {
    $app.innerHTML = `
      ${themeToggle('tema-solto')}
      <main class="entrada">
        <div class="entrada-cartao vidro">
          <div class="palco">
            <div class="mascote" aria-hidden="true">
              <img class="mascote-chega" src="/img/caixa-chegando.svg" alt="">
              <img class="mascote-parada" src="/img/caixa.svg" alt="">
            </div>
            <div class="balao" aria-hidden="true">olá!</div>
            <div class="segredo" role="dialog" aria-label="Detalhes da versão" hidden>
              <p>Psiu! Você achou o atalho secreto.</p>
              <a class="botao pequeno" href="/version" target="_blank" rel="noopener">Ver detalhes da versão <span data-segredo-versao></span></a>
            </div>
          </div>
          <div class="entrada-form" id="passo"></div>
        </div>
      </main>`;
    bindSecret();
    stepCredentials(message);
  }

  // Comando escondido: dois cliques na caixa mostram o atalho para /version.
  function bindSecret() {
    const stage = $app.querySelector('.palco');
    const secret = stage.querySelector('.segredo');
    const hide = () => { secret.hidden = true; };
    stage.querySelector('.mascote').addEventListener('dblclick', async (e) => {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      secret.hidden = !secret.hidden;
      if (secret.hidden) return;
      secret.querySelector('a').focus();
      const label = secret.querySelector('[data-segredo-versao]');
      if (!label.textContent) {
        try {
          const res = await fetch('/api/novidades');
          const data = res.ok ? await res.json() : {};
          if (data.version) label.textContent = 'v' + data.version;
        } catch { /* sem número, o link funciona igual */ }
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (secret.isConnected && !secret.hidden && !secret.contains(e.target) && !e.target.closest('.mascote')) hide();
    });
    secret.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    secret.querySelector('a').addEventListener('click', hide);
  }

  function stepCredentials(message) {
    const el = document.getElementById('passo');
    el.innerHTML = `
      <h1>GesToque</h1>
      <p class="sub">Estoque e previsão de compras da loja.</p>
      ${message ? `<p class="nota" role="status">${esc(message)}</p>` : ''}
      <form novalidate>
        <label class="campo"><span>Usuário</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
        <label class="campo"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="erro-form" role="alert"></p>
        <button class="botao" type="submit">Entrar</button>
      </form>`;
    const form = el.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitWith(form, async (data) => {
        const out = await api('POST', '/api/entrar', data);
        stepCode(out);
      });
    });
  }

  function stepCode(info) {
    const el = document.getElementById('passo');
    const enrolling = info.step === 'ativar';
    el.innerHTML = `
      <h2>${enrolling ? 'Ative a verificação em duas etapas' : 'Código do autenticador'}</h2>
      ${enrolling
        ? `<p>Abra o Google Authenticator, Microsoft Authenticator ou Authy no celular e leia o QR code. Depois digite o código de 6 dígitos que o app mostrar.</p>
           <div class="qr">
             <img src="${esc(info.qr)}" alt="QR code para o app autenticador">
             <div><small>Sem câmera? Digite esta chave no app:</small><br><span class="chave">${esc(info.secret.replace(/(.{4})/g, '$1 ').trim())}</span></div>
           </div>`
        : '<p class="sub">Digite o código de 6 dígitos do seu app autenticador.</p>'}
      <form novalidate>
        <label class="campo"><span>Código</span><input class="codigo" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus></label>
        <p class="erro-form" role="alert"></p>
        <button class="botao" type="submit">${enrolling ? 'Ativar e entrar' : 'Confirmar código'}</button>
        <button class="botao-texto" type="button" data-voltar>Voltar para usuário e senha</button>
      </form>`;
    const form = el.querySelector('form');
    form.querySelector('[data-voltar]').addEventListener('click', () => {
      api('POST', '/api/sair').catch(() => {});
      stepCredentials();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitWith(form, async (data) => {
        const out = await api('POST', '/api/entrar/codigo', data);
        state.user = out.user;
        activity.last = activity.ping = Date.now();
        renderShell();
        // Aviso de versão nova primeiro; o alerta de estoque espera ele fechar.
        maybeWhatsNew().finally(() => maybeLowStockAlert(true));
      });
    });
    form.code.focus();
  }

  // ---------- Estrutura ----------

  const VIEWS = [
    { id: 'estoque', label: 'Estoque' },
    { id: 'movimentacoes', label: 'Movimentações' },
    { id: 'estimativas', label: 'Estimativa de uso' },
    { id: 'previsao', label: 'Previsão de compra' },
    { id: 'compras', label: 'Histórico de compras' },
    { id: 'perfil', label: 'Perfil', gestor: true },
    { id: 'solicitacoes', label: 'Solicitar usuário', gestor: true },
    { id: 'metricas', label: 'Métricas', admin: true },
    { id: 'usuarios', label: 'Usuários', admin: true },
    { id: 'removidos', label: 'Itens removidos', admin: true },
    { id: 'sql', label: 'Consulta SQL', admin: true },
    { id: 'configuracoes', label: 'Configurações', divider: true },
  ];

  // Ícones de traço da lateral (24x24). Aparecem sempre e ficam sozinhos com o menu recolhido.
  const ICONS = {
    estoque: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    movimentacoes: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
    estimativas: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 14h3M13.5 14h3M7.5 17.5h3"/>',
    previsao: '<path d="M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    compras: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    metricas: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
    configuracoes: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    sair: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
    recolher: '<path d="M15 6l-6 6 6 6"/>',
    solicitacoes: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.2 1.4M18 13v7M14.5 16.5h7"/>',
    removidos: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
    ajuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2.2-2.4 3.9M12 17h.01"/>',
    novidades: '<path d="M12 3l2.3 5.3L20 9l-4.3 3.8L17 18.5 12 15.6 7 18.5l1.3-5.7L4 9l5.7-.7z"/>',
    codigo: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
    sql: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>',
    perfil: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1-4 4-6 7.5-6s6.5 2 7.5 6"/>',
    registro: '<path d="M8 4h11v16H8zM4.5 8h3.5M4.5 12h3.5M4.5 16h3.5M11 9h5M11 13h5M11 17h3"/>',
    mais: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  };
  const icon = (name) => `<svg class="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // Menu lateral recolhido ou aberto: preferência deste navegador.
  function sidebarCollapsed() {
    try { return localStorage.getItem('gt_menu_recolhido') === '1'; } catch { return false; }
  }
  function setSidebarCollapsed(collapsed) {
    const shell = $app.querySelector('.casca');
    // No menu em cabeçalho não há o que recolher; a preferência fica guardada para a lateral.
    shell.classList.toggle('recolhida', collapsed && menuPosition() === 'lateral');
    const btn = shell.querySelector('[data-recolher]');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Abrir o menu' : 'Recolher o menu');
    btn.title = collapsed ? 'Abrir o menu' : 'Recolher o menu';
    try { localStorage.setItem('gt_menu_recolhido', collapsed ? '1' : '0'); } catch { /* vale só nesta visita */ }
  }

  // Menu na lateral ou em cabeçalho no topo (só no computador; o celular usa sempre a barra de abas).
  // Preferência deste navegador, escolhida em Configurações.
  function menuPosition() {
    try { return localStorage.getItem('gt_menu_posicao') === 'topo' ? 'topo' : 'lateral'; } catch { return state.menuMem || 'lateral'; }
  }
  function setMenuPosition(pos) {
    state.menuMem = pos;
    try { localStorage.setItem('gt_menu_posicao', pos); } catch { /* vale só nesta visita */ }
    $app.querySelector('.casca').classList.toggle('menu-topo', pos === 'topo');
    setSidebarCollapsed(sidebarCollapsed());
    fitTopMenu();
  }
  // No topo, se os nomes das seções não cabem na largura da tela, fica só com os ícones.
  function fitTopMenu() {
    const shell = $app.querySelector('.casca');
    if (!shell) return;
    shell.classList.remove('compacto');
    if (!shell.classList.contains('menu-topo')) return;
    const bar = shell.querySelector('.lateral');
    if (bar.scrollWidth > bar.clientWidth + 1) shell.classList.add('compacto');
  }
  window.addEventListener('resize', () => fitTopMenu());

  function renderShell() {
    const views = VIEWS.filter((v) => (!v.admin || isAdmin()) && (!v.gestor || !isAdmin()));
    $app.innerHTML = `
      <div class="casca${menuPosition() === 'topo' ? ' menu-topo' : ''}">
        <aside class="lateral vidro">
          <div class="marca">
            <img class="marca-logo" src="/img/logo-gestoque.svg" alt="">
            <div class="marca-texto">GesToque<small>Gestão de estoque</small></div>
            ${isAdmin() ? `<button class="sino" type="button" data-sino title="Solicitações de usuário" aria-label="Solicitações de usuário">${icon('sino')}<span class="contador" hidden></span></button>` : ''}
            <button class="recolher" type="button" data-recolher aria-controls="menu-lateral">${icon('recolher')}</button>
          </div>
          <nav class="nav" id="menu-lateral" aria-label="Seções">
            ${views.map((v, i) => `${(v.admin && !views[i - 1].admin) || (v.divider && !views[i - 1].admin) ? '<div class="divisor"></div>' : ''}<button type="button" data-view="${v.id}" title="${v.label}">${icon(v.id)}<span class="rotulo">${v.label}</span></button>`).join('')}
          </nav>
          <div class="quem">
            <div class="quem-nome"><strong>${esc(state.user.name)}</strong><span>${state.user.role === 'admin' ? 'Admin' : 'Gestor'}</span></div>
            <div class="acoes">
              <button class="sair" type="button" data-sair title="Sair">${icon('sair')}<span class="rotulo">Sair</span></button>
              ${themeToggle()}
            </div>
          </div>
        </aside>
        <header class="topo-app vidro">
          <img class="marca-logo" src="/img/logo-gestoque.svg" alt="">
          <div class="marca-texto">GesToque<small>Gestão de estoque</small></div>
          ${isAdmin() ? `<button class="sino" type="button" data-sino aria-label="Solicitações de usuário">${icon('sino')}<span class="contador" hidden></span></button>` : ''}
        </header>
        <main class="conteudo" id="tela" tabindex="-1"></main>
        <nav class="barra-app vidro" aria-label="Seções">
          ${MOBILE_TABS.map((id) => `<button type="button" data-view="${id}">${icon(id)}<span>${MOBILE_LABEL[id]}</span></button>`).join('')}
          <button type="button" data-mais aria-haspopup="dialog">${icon('mais')}<span>Mais</span></button>
        </nav>
      </div>`;
    setSidebarCollapsed(sidebarCollapsed());
    document.fonts.ready.then(fitTopMenu);
    $app.querySelectorAll('[data-sino]').forEach((bell) => bell.addEventListener('click', requestsDialog));
    if (isAdmin()) updateBell();
    $app.querySelector('[data-mais]').addEventListener('click', () => moreSheet(views));
    $app.querySelector('[data-recolher]').addEventListener('click', () => {
      setSidebarCollapsed(!$app.querySelector('.casca').classList.contains('recolhida'));
    });
    $app.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
    $app.querySelector('[data-sair]').addEventListener('click', signOut);
    go(views.some((v) => v.id === state.view) ? state.view : 'estoque');
  }

  const RENDER = { estoque: viewStock, movimentacoes: viewMovements, estimativas: viewEstimates, previsao: viewForecast, compras: viewPurchases, metricas: viewMetrics, usuarios: viewUsers, configuracoes: viewSettings, solicitacoes: viewRequestUser, removidos: viewRemoved, sql: viewSql, perfil: viewProfile };

  async function signOut() {
    closeDialog();
    await api('POST', '/api/sair').catch(() => {});
    state.user = null;
    state.token = null;
    renderLogin();
  }

  // ---------- Celular: barra de abas embaixo + gaveta "Mais" ----------
  // Abaixo de 900 px a lateral some; as 4 telas mais usadas ficam na barra e o resto na gaveta.

  const MOBILE_TABS = ['estoque', 'movimentacoes', 'estimativas', 'previsao'];
  const MOBILE_LABEL = { estoque: 'Estoque', movimentacoes: 'Movimentar', estimativas: 'Estimativa', previsao: 'Previsão' };

  function moreSheet(views) {
    const rest = views.filter((v) => !MOBILE_TABS.includes(v.id));
    openDialog(`
      <div class="folha-quem">
        <strong>${esc(state.user.name)}</strong>
        <span>${state.user.role === 'admin' ? 'Admin' : 'Gestor'}</span>
      </div>
      <nav class="folha-lista" aria-label="Mais seções">
        ${rest.map((v) => `<button type="button" data-ir="${v.id}" ${v.id === state.view ? 'aria-current="page"' : ''}>${icon(v.id)}<span>${v.label}</span></button>`).join('')}
      </nav>
      <div class="folha-rodape">
        ${themeToggle()}
        <button class="sair" type="button" data-sair-folha>${icon('sair')}<span class="rotulo">Sair</span></button>
      </div>`, (dlg) => {
      dlg.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => { closeDialog(); go(b.dataset.ir); }));
      dlg.querySelector('[data-sair-folha]').addEventListener('click', signOut);
    }, 'folha');
  }

  async function go(view) {
    state.view = view;
    $app.querySelectorAll('[data-view]').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    fitTopMenu(); // a tela aberta mostra o nome, o que muda a largura do menu no topo
    // Na barra do celular, telas que moram na gaveta acendem o botão "Mais".
    const more = $app.querySelector('[data-mais]');
    if (more) {
      if (MOBILE_TABS.includes(view)) more.removeAttribute('aria-current');
      else more.setAttribute('aria-current', 'page');
    }
    const tela = document.getElementById('tela');
    const turn = ++goTurn;
    // Resposta imediata ao clique. Trocando de tela: o esqueleto dela aparece na hora (título real,
    // quadros e barras vazias). Atualizando a mesma tela (salvar, filtrar): ela só esmaece, sem piscar.
    const switching = tela.dataset.tela !== view;
    if (switching) {
      window.scrollTo(0, 0);
      tela.dataset.tela = view;
      tela.classList.remove('entrando');
      tela.innerHTML = skeleton(view);
    } else tela.classList.add('carregando');
    tela.setAttribute('aria-busy', 'true');
    // A tela real é montada fora da vista e entra de uma vez; se outro clique veio no meio, é descartada.
    const stage = document.createElement('div');
    try {
      await RENDER[view](stage);
      if (turn !== goTurn) return;
      tela.classList.remove('entrando');
      tela.replaceChildren(...stage.childNodes);
      if (switching) {
        void tela.offsetWidth; // reinicia a animação de entrada
        tela.classList.add('entrando');
      }
    } catch (err) {
      if (turn !== goTurn) return;
      if (state.user) tela.innerHTML = `<section class="painel vidro"><div class="vazio"><strong>Não foi possível carregar</strong><p>${esc(err.message)}</p><button class="botao" type="button" data-de-novo>Tentar de novo</button></div></section>`;
      const again = tela.querySelector('[data-de-novo]');
      if (again) again.addEventListener('click', () => { delete tela.dataset.tela; go(view); });
    } finally {
      if (turn === goTurn) {
        tela.classList.remove('carregando');
        tela.removeAttribute('aria-busy');
      }
    }
  }
  let goTurn = 0;

  // ---------- Esqueleto de carregamento ----------
  // Formato de cada tela enquanto os dados não chegam: título e texto reais, o resto em barras vazias.
  const SKELETON = {
    estoque: { text: 'Tudo o que a loja tem hoje. O uso por dia vem das saídas registradas.', actions: 3, resumo: 4, filtros: 2, linhas: 8 },
    movimentacoes: { text: 'Entradas, saídas e contagens, da mais recente para a mais antiga.', actions: 3, filtros: 2, linhas: 10 },
    estimativas: { text: 'Quanto a loja deve usar de cada item nas próximas semanas.', filtros: 2, linhas: 8 },
    previsao: { text: 'Uma fatura por mês, calculada pelo uso dos últimos dias. Os meses passados mostram o que foi comprado de fato.', actions: 1, resumo: 4, blocos: 2 },
    compras: { text: 'Cada entrada com o preço pago e o fornecedor daquele dia.', filtros: 1, linhas: 10 },
    metricas: { text: 'Os números que o sistema usa para calcular cada fatura de compra.', campos: 6 },
    usuarios: { text: 'Admin ajusta tudo, inclusive métricas e usuários. Gestor cuida do estoque, das movimentações e das compras.', actions: 2, linhas: 6 },
    solicitacoes: { text: 'Peça o acesso de uma pessoa nova. Um admin recebe o aviso, confere os dados e cria o usuário.', campos: 4, linhas: 3 },
    removidos: { text: 'Itens excluídos do estoque, com os dados que tinham na hora e todo o histórico.', linhas: 8 },
    sql: { text: 'Leia qualquer dado do banco em SQL. Só leitura.', campos: 2, linhas: 6 },
    perfil: { text: 'Os seus dados de acesso ao sistema.', campos: 4 },
    configuracoes: { text: 'Valem só para o seu usuário.', paineis: 4 },
  };
  const WIDTHS = ['72%', '48%', '60%', '36%', '54%', '66%', '42%', '58%'];
  const bar = (w, cls = '') => `<span class="esq-barra ${cls}" style="width:${w}"></span>`;
  const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');

  function skeleton(view) {
    const s = SKELETON[view] || { linhas: 6 };
    const label = (VIEWS.find((v) => v.id === view) || {}).label || '';
    const resumo = s.resumo ? `<div class="resumo esq-resumo">${times(s.resumo, (i) => `<div>${bar(WIDTHS[i + 2])}${bar('46%', 'grande')}</div>`)}</div>` : '';
    const filtros = s.filtros ? `<div class="filtros">${times(s.filtros, (i) => bar(i ? '200px' : '100%', 'campo'))}</div>` : '';
    const linhas = s.linhas ? `<div class="esq-linhas">${times(s.linhas, (i) => `<div class="esq-linha">${bar(WIDTHS[i % 8])}${bar(WIDTHS[(i + 3) % 8], 'curta')}${bar('14%', 'curta')}${bar('10%', 'curta')}</div>`)}</div>` : '';
    const campos = s.campos ? `<div class="esq-campos">${times(s.campos, (i) => `<div>${bar(WIDTHS[(i + 1) % 8], 'rotulo')}${bar('100%', 'campo')}</div>`)}</div>` : '';
    const blocos = s.blocos ? times(s.blocos, () => `<section class="painel vidro esq-painel">${bar('30%', 'titulo')}${bar('100%', 'grande')}<div class="esq-linhas">${times(4, (i) => `<div class="esq-linha">${bar(WIDTHS[i])}${bar('16%', 'curta')}${bar('12%', 'curta')}</div>`)}</div></section>`) : '';
    const paineis = s.paineis ? times(s.paineis, (i) => `<section class="painel vidro esq-painel">${bar('22%', 'titulo')}${bar(WIDTHS[i + 1])}${bar(WIDTHS[i + 4])}</section>`) : '';
    const corpo = resumo || filtros || linhas || campos ? `<section class="painel vidro esq-painel">${resumo}${filtros}${campos}${linhas}</section>` : '';
    return `<div class="esqueleto" aria-hidden="true">
      ${header(esc(label), esc(s.text || ''), times(s.actions || 0, () => bar('104px', 'botao-esq')))}
      ${corpo}${blocos}${paineis}
    </div><p class="so-leitor" role="status">Carregando ${esc(label)}...</p>`;
  }

  const header = (title, text, actions = '') => `
    <header class="topo vidro">
      <div><h1>${title}</h1><p>${text}</p></div>
      <div class="acoes-topo">${actions}</div>
    </header>`;

  // ---------- Estoque ----------

  // Item em pacote: o estoque é contado em pacotes; isto mostra o equivalente em unidades.
  const unitsOf = (item, qty) => (item && item.units_per_pack ? `${fmtQty(qty * item.units_per_pack)} unidades` : '');

  function stockStatus(item) {
    if (item.qty <= 0) return ['zerado', 'Sem estoque'];
    if (item.qty <= item.min_qty) return ['baixo', 'Abaixo do mínimo'];
    return ['ok', 'Em dia'];
  }

  async function loadItems() {
    const out = await api('GET', '/api/itens');
    state.items = out.items;
    state.windowDays = out.window_days;
  }

  async function viewStock(tela) {
    await loadItems();
    const active = state.items.filter((i) => i.active);
    const categories = [...new Set(state.items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const low = active.filter((i) => i.qty <= i.min_qty).length;
    const value = active.reduce((s, i) => s + i.qty * i.cost, 0);

    tela.innerHTML = `
      ${header('Estoque', 'Tudo o que a loja tem hoje. O uso por dia vem das saídas registradas.', `
        <button class="botao claro" type="button" data-importar>Importar</button>
        <button class="botao claro" type="button" data-exportar>Exportar</button>
        <button class="botao" type="button" data-novo>Adicionar item</button>`)}
      <section class="painel vidro">
        <dl class="resumo">
          <div><dt>Itens ativos</dt><dd>${active.length}</dd></div>
          <div><dt>Valor em estoque</dt><dd>${fmtMoney(value)}</dd></div>
          <div><dt>No mínimo ou abaixo</dt><dd>${low}</dd></div>
          <div><dt>Média de uso calculada em</dt><dd>${state.windowDays} dias</dd></div>
        </dl>
        <div class="filtros">
          <input type="search" placeholder="Buscar por nome, SKU ou fornecedor" aria-label="Buscar item" value="${esc(state.filter.text)}" data-busca>
          <select aria-label="Filtrar por categoria" data-categoria>
            <option value="">Todas as categorias</option>
            ${categories.map((c) => `<option ${c === state.filter.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div id="lista-itens"></div>
      </section>`;

    const list = tela.querySelector('#lista-itens');
    const draw = () => {
      const t = state.filter.text.trim().toLowerCase();
      const rows = state.items.filter((i) =>
        (!state.filter.category || i.category === state.filter.category) &&
        (!t || [i.name, i.sku, i.supplier].some((v) => v.toLowerCase().includes(t))));
      if (!state.items.length) {
        list.innerHTML = `<div class="vazio"><strong>O estoque está vazio</strong><p>Adicione o primeiro item ou importe uma planilha com todos de uma vez.</p></div>`;
        return;
      }
      if (!rows.length) {
        list.innerHTML = `<div class="vazio"><strong>Nenhum item encontrado</strong><p>Mude a busca ou a categoria.</p></div>`;
        return;
      }
      list.innerHTML = `
        <div class="rolagem"><table>
          <thead><tr><th>Item</th><th class="num">Em estoque</th><th>Situação</th><th class="num">Mínimo</th><th class="num">Uso por dia</th><th class="num">Dura</th><th class="num">Custo</th><th class="num">Valor</th><th></th></tr></thead>
          <tbody>${rows.map((i) => {
            const [cls, label] = i.active ? stockStatus(i) : ['neutro', 'Inativo'];
            return `<tr class="${i.active ? '' : 'inativo'}">
              <td><div class="item-nome">${esc(i.name)}</div><div class="item-sub">${esc(i.sku)}${i.category ? ' | ' + esc(i.category) : ''}${i.units_per_pack ? ` | <span class="selo-pacote">pacote com ${fmtQty(i.units_per_pack)} un</span>` : ''}</div></td>
              <td class="num"><strong>${fmtQty(i.qty)}</strong> ${esc(i.unit)}${i.units_per_pack ? `<div class="item-sub">${unitsOf(i, i.qty)}</div>` : ''}</td>
              <td><span class="selo ${cls}">${label}</span></td>
              <td class="num">${fmtQty(i.min_qty)}</td>
              <td class="num">${i.daily ? fmtQty(i.daily) : '-'}</td>
              <td class="num">${i.cover_days === null ? '-' : i.cover_days + ' dias'}</td>
              <td class="num">${fmtMoney(i.cost)}</td>
              <td class="num">${fmtMoney(i.qty * i.cost)}</td>
              <td><div class="linha-acoes">
                <button class="botao pequeno destaque" type="button" data-mover="${i.id}">Movimentar</button>
                <button class="botao pequeno claro" type="button" data-editar="${i.id}">Editar</button>
              </div></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;
    };
    draw();

    tela.querySelector('[data-busca]').addEventListener('input', (e) => { state.filter.text = e.target.value; draw(); });
    tela.querySelector('[data-categoria]').addEventListener('change', (e) => { state.filter.category = e.target.value; draw(); });
    tela.querySelector('[data-novo]').addEventListener('click', () => itemDialog(null));
    tela.querySelector('[data-importar]').addEventListener('click', () => importDialog('estoque'));
    tela.querySelector('[data-exportar]').addEventListener('click', () => exportDialog('estoque'));
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const item = state.items.find((i) => i.id === Number(btn.dataset.mover || btn.dataset.editar));
      if (btn.dataset.mover) movementDialog({ item });
      else if (btn.dataset.editar) itemDialog(item);
    });
  }

  function itemDialog(item) {
    const dec = (n) => String(n).replace('.', ',');
    const v = item
      ? { ...item, min_qty: dec(item.min_qty), cost: dec(item.cost), pack_size: dec(item.pack_size), units_per_pack: item.units_per_pack ? dec(item.units_per_pack) : '' }
      : { sku: '', name: '', category: '', unit: 'un', qty: '', min_qty: 0, cost: '', pack_size: 1, lead_days: 7, supplier: '', active: true, units_per_pack: '' };
    const isPack = Boolean(v.units_per_pack);
    openDialog(`
      <form novalidate>
        <h2>${item ? 'Editar item' : 'Adicionar item'}</h2>
        <div class="grade">
          <label class="campo inteira"><span>Nome</span><input name="name" value="${esc(v.name)}" required maxlength="120"></label>
          <label class="campo"><span>SKU</span><input name="sku" value="${esc(v.sku)}" required maxlength="40"><small>Código único do item.</small></label>
          <label class="campo"><span>Categoria</span><input name="category" value="${esc(v.category)}" maxlength="60" list="cats"></label>
          <label class="campo"><span>Unidade</span><input name="unit" value="${esc(v.unit)}" maxlength="12"><small data-dica-unidade>${isPack ? 'Unidade do pacote. Ex.: pct, cx, fardo.' : 'Ex.: un, kg, cx 12.'}</small></label>
          <div class="pacote inteira">
            <label class="marcar"><input type="checkbox" name="is_pack" ${isPack ? 'checked' : ''}> Este item é um pacote com várias unidades</label>
            <label class="campo" data-campo-pacote ${isPack ? '' : 'hidden'}><span>Unidades em 1 pacote</span>
              <input name="units_per_pack" inputmode="decimal" value="${esc(v.units_per_pack)}" placeholder="Ex.: 100">
              <small>O estoque, o mínimo, o custo e as movimentações ficam em pacotes; o sistema mostra o total em unidades.</small></label>
          </div>
          ${item ? '' : `<label class="campo"><span data-rotulo-qtd>Quantidade em estoque${isPack ? ' (pacotes)' : ''}</span><input name="qty" inputmode="decimal" placeholder="0"></label>`}
          <label class="campo"><span>Estoque mínimo</span><input name="min_qty" inputmode="decimal" value="${esc(v.min_qty)}"></label>
          <label class="campo"><span data-rotulo-custo>${isPack ? 'Custo do pacote (R$)' : 'Custo unitário (R$)'}</span><input name="cost" inputmode="decimal" value="${esc(v.cost)}"></label>
          <label class="campo"><span>Lote de compra</span><input name="pack_size" inputmode="decimal" value="${esc(v.pack_size)}"><small>A compra sugerida é arredondada para múltiplos deste lote.</small></label>
          <label class="campo"><span>Prazo de entrega (dias)</span><input name="lead_days" inputmode="numeric" value="${esc(v.lead_days)}"></label>
          <label class="campo ${item ? '' : 'inteira'}"><span>Fornecedor</span><input name="supplier" value="${esc(v.supplier)}" maxlength="80"></label>
          ${item ? `<label class="marcar inteira"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Item ativo (entra na previsão de compra)</label>` : ''}
        </div>
        <datalist id="cats">${[...new Set(state.items.map((i) => i.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          ${item && isAdmin() ? '<button class="botao perigo esquerda" type="button" data-excluir>Excluir item</button>' : ''}
          <button class="botao claro" type="button" data-fechar>Cancelar</button>
          <button class="botao" type="submit">${item ? 'Salvar alterações' : 'Adicionar item'}</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      // Marcar "pacote" libera o campo de unidades por pacote e ajusta os rótulos para pacotes.
      const packField = form.querySelector('[data-campo-pacote]');
      form.is_pack.addEventListener('change', () => {
        const on = form.is_pack.checked;
        packField.hidden = !on;
        form.querySelector('[data-dica-unidade]').textContent = on ? 'Unidade do pacote. Ex.: pct, cx, fardo.' : 'Ex.: un, kg, cx 12.';
        form.querySelector('[data-rotulo-custo]').textContent = on ? 'Custo do pacote (R$)' : 'Custo unitário (R$)';
        const qtyLabel = form.querySelector('[data-rotulo-qtd]');
        if (qtyLabel) qtyLabel.textContent = 'Quantidade em estoque' + (on ? ' (pacotes)' : '');
        if (on) {
          if (form.unit.value.trim() === 'un') form.unit.value = 'pct';
          form.units_per_pack.focus();
        }
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (data) => {
          data.is_pack = form.is_pack.checked;
          if (!data.is_pack) data.units_per_pack = '';
          if (item) data.active = form.active.checked;
          await api(item ? 'PATCH' : 'POST', item ? `/api/itens/${item.id}` : '/api/itens', data);
          closeDialog();
          toast(item ? 'Alterações salvas' : 'Item adicionado');
          go(state.view);
        });
      });
      const del = dlg.querySelector('[data-excluir]');
      if (del) del.addEventListener('click', async () => {
        if (del.dataset.certeza !== '1') {
          del.dataset.certeza = '1';
          del.textContent = 'Confirmar exclusão (fica guardado nos removidos)';
          return;
        }
        try {
          await api('DELETE', `/api/itens/${item.id}`);
          closeDialog();
          toast('Item excluído. Ele e o histórico ficaram guardados nos removidos.');
          go(state.view);
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  // Abre o registro de movimentação. Em "preset" vêm o item e, quando sai de uma fatura, a compra sugerida.
  function movementDialog(preset = {}) {
    const items = state.items.filter((i) => i.active || (preset.item && preset.item.id === i.id));
    const type = preset.type || 'saida';
    openDialog(`
      <form novalidate>
        <h2>Registrar movimentação</h2>
        <label class="campo"><span>Item</span>
          <select name="item_id" required>${items.map((i) => `<option value="${i.id}" ${preset.item && preset.item.id === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.sku)})</option>`).join('')}</select>
        </label>
        <div class="tipos" role="radiogroup" aria-label="Tipo">
          <label><input type="radio" name="type" value="saida" ${type === 'saida' ? 'checked' : ''}><span>Saída</span></label>
          <label><input type="radio" name="type" value="entrada" ${type === 'entrada' ? 'checked' : ''}><span>Entrada</span></label>
          <label><input type="radio" name="type" value="ajuste" ${type === 'ajuste' ? 'checked' : ''}><span>Contagem</span></label>
        </div>
        <div class="grade">
          <label class="campo"><span data-rotulo-qtd>Quantidade</span><input name="qty" inputmode="decimal" required value="${esc(preset.qty ?? '')}"><small data-saldo></small></label>
          <label class="campo" data-custo><span data-rotulo-custo>Custo unitário (R$)</span><input name="unit_cost" inputmode="decimal" value="${esc(preset.cost ?? '')}"></label>
          <label class="campo inteira" data-custo><span>Fornecedor</span><input name="supplier" maxlength="80"><small>Fica gravado nesta compra, junto com o preço pago.</small></label>
          <label class="marcar inteira" data-custo><input type="checkbox" name="update_cost" checked> Atualizar o custo do item com este valor</label>
          <label class="campo inteira"><span>Observação</span><input name="note" maxlength="200" value="${esc(preset.note ?? '')}"></label>
        </div>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-fechar>Cancelar</button>
          <button class="botao" type="submit">Registrar</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      const sync = () => {
        const t = form.type.value;
        const item = state.items.find((i) => i.id === Number(form.item_id.value));
        dlg.querySelectorAll('[data-custo]').forEach((el) => { el.hidden = t !== 'entrada'; });
        const pack = item && item.units_per_pack;
        dlg.querySelector('[data-rotulo-qtd]').textContent = (t === 'ajuste' ? 'Quantidade contada' : 'Quantidade') + (pack ? ' (pacotes)' : '');
        dlg.querySelector('[data-rotulo-custo]').textContent = pack ? 'Custo do pacote (R$)' : 'Custo unitário (R$)';
        // Item em pacote: mostra o saldo e o que está sendo digitado também em unidades.
        const raw = String(form.qty.value).trim();
        const typed = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
        const typedUnits = pack && form.qty.value && Number.isFinite(typed) ? ` Você digitou ${fmtQty(typed)} pacote(s) = ${unitsOf(item, typed)}.` : '';
        dlg.querySelector('[data-saldo]').textContent = item
          ? `Hoje: ${fmtQty(item.qty)} ${item.unit}${pack ? ` (${unitsOf(item, item.qty)}, ${fmtQty(item.units_per_pack)} por pacote)` : ''}.` +
            (t === 'ajuste' ? ' Informe o que há na prateleira; o sistema registra a diferença.' : '') + typedUnits
          : '';
        if (t === 'entrada' && item && !form.unit_cost.value) form.unit_cost.value = String(item.cost).replace('.', ',');
        if (t === 'entrada' && item && !form.supplier.dataset.editado) form.supplier.value = item.supplier;
      };
      form.supplier.addEventListener('input', () => { form.supplier.dataset.editado = '1'; });
      form.addEventListener('change', sync);
      form.qty.addEventListener('input', sync);
      sync();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (data) => {
          data.update_cost = form.update_cost.checked;
          if (data.type !== 'entrada') { delete data.unit_cost; delete data.supplier; }
          const out = await api('POST', '/api/movimentacoes', data);
          // Atualiza o saldo na hora, antes mesmo de a tela recarregar.
          const moved = state.items.find((i) => i.id === Number(data.item_id));
          if (moved) moved.qty = out.balance;
          closeDialog();
          toast(`Movimentação registrada. Saldo: ${fmtQty(out.balance)}${moved ? ' ' + moved.unit : ''}`);
          state.forecast = null;
          await go(state.view);
        });
      });
      form.qty.focus();
    });
  }

  // Exporta a carga de estoque ou as movimentações (saídas, entradas, contagens), em Excel ou CSV.
  function exportDialog(kind) {
    openDialog(`
      <form novalidate>
        <h2>Exportar</h2>
        <div class="tipos dois" role="radiogroup" aria-label="O que exportar">
          <label><input type="radio" name="kind" value="estoque" ${kind === 'estoque' ? 'checked' : ''}><span>Carga de estoque</span></label>
          <label><input type="radio" name="kind" value="movimentacoes" ${kind === 'movimentacoes' ? 'checked' : ''}><span>Movimentações</span></label>
        </div>
        <p data-texto></p>
        <div data-mov class="grade">
          <div class="inteira marcas">
            <label class="marcar"><input type="checkbox" name="saida" checked> Saídas</label>
            <label class="marcar"><input type="checkbox" name="entrada" checked> Entradas</label>
            <label class="marcar"><input type="checkbox" name="ajuste" checked> Contagens</label>
          </div>
          <label class="campo"><span>De</span><input type="date" name="de"><small>Em branco: desde o início.</small></label>
          <label class="campo"><span>Até</span><input type="date" name="ate"><small>Em branco: até hoje.</small></label>
        </div>
        <label class="campo"><span>Formato</span><select name="formato"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-fechar>Fechar</button>
          <button class="botao" type="submit">Exportar</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      const sync = () => {
        const mov = form.kind.value === 'movimentacoes';
        dlg.querySelector('[data-mov]').hidden = !mov;
        dlg.querySelector('[data-texto]').textContent = mov
          ? 'Uma linha por movimentação, com data, SKU, tipo e quantidade. O arquivo pode ser importado de volta.'
          : 'Todos os itens com o saldo atual, mínimo, custo, lote, prazo e fornecedor. O arquivo pode ser importado de volta.';
      };
      form.addEventListener('change', sync);
      sync();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (d) => {
          if (d.kind === 'estoque') return saveFile(await api('GET', '/api/itens/exportar?formato=' + d.formato));
          const types = ['saida', 'entrada', 'ajuste'].filter((t) => form[t].checked);
          if (!types.length) throw new Error('Marque pelo menos um tipo: saídas, entradas ou contagens.');
          if (d.de && d.ate && d.ate < d.de) throw new Error('A data final vem antes da inicial.');
          const q = new URLSearchParams({ formato: d.formato, tipos: types.join(',') });
          if (d.de) q.set('de', d.de);
          if (d.ate) q.set('ate', d.ate);
          saveFile(await api('GET', '/api/movimentacoes/exportar?' + q));
        });
      });
    });
  }

  function importDialog(kind) {
    openDialog(`
      <form novalidate>
        <h2>Importar planilha</h2>
        <div class="tipos dois" role="radiogroup" aria-label="O que a planilha traz">
          <label><input type="radio" name="kind" value="estoque" ${kind === 'estoque' ? 'checked' : ''}><span>Carga de estoque</span></label>
          <label><input type="radio" name="kind" value="movimentacoes" ${kind === 'movimentacoes' ? 'checked' : ''}><span>Movimentações</span></label>
        </div>
        <p data-texto></p>
        <label class="marcar" data-saldo><input type="checkbox" name="saldo" checked> Atualizar o saldo do estoque com estas movimentações</label>
        <small class="item-sub" data-saldo>Desmarque para carregar só o histórico (meses antigos, por exemplo): o sistema aprende o ritmo de uso sem mexer no saldo de hoje.</small>
        <label class="campo"><span>Arquivo (.xlsx ou .csv)</span><input type="file" name="file" accept=".xlsx,.csv" required></label>
        <div data-resultado></div>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-fechar>Cancelar</button>
          <button class="botao" type="submit">Conferir planilha</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      const result = dlg.querySelector('[data-resultado]');
      const btn = form.querySelector('[type=submit]');
      let checked = false;
      const errorList = (errors, total) => `<ul class="lista-erros">${errors.map((e) => `<li>Linha ${e.line}: ${esc(e.message)}</li>`).join('')}${total > errors.length ? `<li>e mais ${total - errors.length}.</li>` : ''}</ul>`;
      const reset = () => { checked = false; btn.textContent = 'Conferir planilha'; result.innerHTML = ''; };
      const sync = () => {
        const mov = form.kind.value === 'movimentacoes';
        dlg.querySelectorAll('[data-saldo]').forEach((el) => { el.hidden = !mov; });
        dlg.querySelector('[data-texto]').textContent = mov
          ? 'Colunas: Data, SKU, Tipo (Entrada, Saída ou Contagem), Quantidade, Custo unitário e Observação. Sem data, vale o momento da importação. Linhas que já estão no sistema são ignoradas. Para ter o modelo, exporte as movimentações.'
          : 'O SKU identifica cada linha: o que já existe é atualizado, o que é novo é criado. Diferenças na coluna Quantidade viram uma contagem. Para ter o modelo, exporte a carga de estoque.';
      };
      form.addEventListener('change', () => { reset(); sync(); });
      sync();
      const cells = (pairs) => `<dl class="resumo">${pairs.map(([l, v]) => `<div><dt>${l}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async () => {
          const file = form.file.files[0];
          if (!file) throw new Error('Escolha um arquivo .xlsx ou .csv.');
          const mov = form.kind.value === 'movimentacoes';
          const url = mov ? '/api/movimentacoes/importar' : '/api/itens/importar';
          const params = mov && !form.saldo.checked ? ['saldo=0'] : [];
          if (!checked) {
            const out = await api('POST', `${url}?${[...params, 'conferir=1'].join('&')}`, file);
            const summary = mov
              ? cells([['Saídas', out.saidas], ['Entradas', out.entradas], ['Contagens', out.contagens], ['Já no sistema', out.duplicates]])
              : cells([['Novos', out.created], ['Atualizados', out.updated], ['Sem mudança', out.unchanged], ['Ajustes de saldo', out.adjusted]]);
            if (out.total_errors) {
              result.innerHTML = summary + `<p><strong>Corrija ${out.total_errors === 1 ? 'esta linha' : 'estas linhas'} e escolha o arquivo de novo:</strong></p>` + errorList(out.errors, out.total_errors);
              return;
            }
            result.innerHTML = summary;
            const total = mov ? out.saidas + out.entradas + out.contagens : out.created + out.updated;
            if (total === 0) { result.innerHTML += '<p>Nada novo para importar nesta planilha.</p>'; return; }
            checked = true;
            btn.textContent = 'Importar agora';
            return;
          }
          await api('POST', url + (params.length ? '?' + params.join('&') : ''), file);
          closeDialog();
          toast('Planilha importada');
          state.forecast = null;
          go(mov ? 'movimentacoes' : 'estoque');
        });
      });
    });
  }

  // ---------- Movimentações ----------

  const TYPE_LABEL = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Contagem' };

  async function viewMovements(tela) {
    const q = state.filter.moveType ? '?tipo=' + state.filter.moveType : '';
    // Recarrega os itens junto: o saldo mostrado ao registrar precisa ser o atual.
    const [{ movements }] = await Promise.all([api('GET', '/api/movimentacoes' + q), loadItems()]);
    tela.innerHTML = `
      ${header('Movimentações', 'Entradas, saídas e contagens, da mais recente para a mais antiga.', `<button class="botao claro" type="button" data-importar>Importar</button>
        <button class="botao claro" type="button" data-exportar>Exportar</button>
        <button class="botao" type="button" data-nova>Registrar movimentação</button>`)}
      <section class="painel vidro">
        <div class="filtros">
          <select aria-label="Filtrar por tipo" data-tipo>
            <option value="">Todos os tipos</option>
            ${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${state.filter.moveType === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        ${movements.length ? `
        <div class="rolagem"><table>
          <thead><tr><th>Quando</th><th>Item</th><th>Tipo</th><th class="num">Quantidade</th><th class="num">Saldo depois</th><th>Observação</th><th>Quem</th></tr></thead>
          <tbody>${movements.map((m) => `<tr>
            <td>${fmtWhen(m.occurred_at)}</td>
            <td><div class="item-nome">${esc(m.item_name)}</div><div class="item-sub">${esc(m.sku)}</div></td>
            <td><span class="selo ${m.type === 'entrada' ? 'ok' : m.type === 'saida' ? 'neutro' : 'baixo'}">${TYPE_LABEL[m.type]}</span></td>
            <td class="num ${m.delta >= 0 ? 'mais' : 'menos'}">${m.delta >= 0 ? '+' : ''}${fmtQty(m.delta)} ${esc(m.unit)}</td>
            <td class="num">${fmtQty(m.balance_after)}</td>
            <td>${esc(m.note)}${m.type === 'entrada' && m.unit_cost !== null ? `<div class="item-sub">${fmtMoney(m.unit_cost)} por ${esc(m.unit)}</div>` : ''}</td>
            <td>${esc(m.user_name) || '-'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : `<div class="vazio"><strong>Nenhuma movimentação ainda</strong><p>Registre as saídas do dia para o sistema aprender o ritmo de uso da loja.</p></div>`}
      </section>`;
    tela.querySelector('[data-tipo]').addEventListener('change', (e) => { state.filter.moveType = e.target.value; go('movimentacoes'); });
    tela.querySelector('[data-importar]').addEventListener('click', () => importDialog('movimentacoes'));
    tela.querySelector('[data-exportar]').addEventListener('click', () => exportDialog('movimentacoes'));
    tela.querySelector('[data-nova]').addEventListener('click', () => {
      if (!state.items.some((i) => i.active)) return toast('Adicione um item no estoque antes de registrar movimentações.', true);
      movementDialog();
    });
  }

  // ---------- Estimativa de uso (automática por dia da semana e feriado + ajuste manual) ----------

  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const shortDay = (iso) => fmtDate(iso).slice(0, 5);

  // Chave "Só itens com estimativa manual": troca a visão por item pela lista de tudo o que foi digitado à mão.
  function manualToggle(count) {
    return `<label class="chave-liga">
      <input type="checkbox" role="switch" data-so-manuais ${state.onlyManual ? 'checked' : ''}>
      <span class="trilho" aria-hidden="true"></span>
      <span><strong>Só itens com estimativa manual</strong>
        <small>${count ? `${count} ${count === 1 ? 'estimativa gravada' : 'estimativas gravadas'} para os próximos períodos.` : 'Nenhuma estimativa manual gravada para os próximos períodos.'}</small></span>
    </label>`;
  }

  // Salvar e voltar ao automático, usados pelas duas visões. A linha traz item e período em data-*.
  function bindEstimateRows(tbody) {
    const save = async (row) => {
      const qty = row.querySelector('input').value.trim();
      if (!qty) return toast('Digite a quantidade estimada para o período.', true);
      try {
        await api('PUT', '/api/estimativas', { item_id: Number(row.dataset.item), from: row.dataset.de, to: row.dataset.ate, qty });
        state.forecast = null;
        toast('Estimativa salva');
        go('estimativas');
      } catch (err) { toast(err.message, true); }
    };
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.limpar) {
        try {
          await api('DELETE', '/api/estimativas/' + btn.dataset.limpar);
          state.forecast = null;
          toast('Voltou ao automático');
          go('estimativas');
        } catch (err) { toast(err.message, true); }
      } else if (btn.dataset.verItem) {
        state.onlyManual = false;
        state.estimateItem = Number(btn.dataset.verItem);
        go('estimativas');
      } else if (btn.hasAttribute('data-salvar')) save(btn.closest('tr'));
    });
    tbody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) save(e.target.closest('tr'));
    });
  }

  function viewManualEstimates(tela, estimates) {
    tela.innerHTML = `
      ${header('Estimativa de uso', 'Todas as estimativas digitadas à mão que ainda valem, de todos os itens. Elas substituem o cálculo automático nas faturas.')}
      <section class="painel vidro">
        <div class="filtros">${manualToggle(estimates.length)}</div>
        ${estimates.length ? `
        <div class="rolagem"><table>
          <thead><tr><th>Item</th><th>Período</th><th class="num">Automático</th><th>Sua estimativa</th><th class="num">Diferença</th><th></th></tr></thead>
          <tbody>${estimates.map((m) => {
            const diff = m.qty - m.auto;
            return `<tr data-item="${m.item_id}" data-de="${m.date_from}" data-ate="${m.date_to}">
              <td><div class="item-nome">${esc(m.name)}</div><div class="item-sub">${esc(m.sku)}${m.active ? '' : ' | inativo'}</div></td>
              <td><div>${m.kind === 'semana' ? 'Segunda a sexta' : 'Fim de semana'}${m.current ? ' <span class="selo destaque">Agora</span>' : ''}</div>
                <div class="item-sub">${shortDay(m.date_from)} a ${shortDay(m.date_to)}${m.used ? ` | já saiu ${fmtQty(m.used)} ${esc(m.unit)}` : ''}</div></td>
              <td class="num">${fmtQty(m.auto)} ${esc(m.unit)}</td>
              <td><input class="curto" inputmode="decimal" aria-label="Sua estimativa para ${esc(m.name)}, ${shortDay(m.date_from)} a ${shortDay(m.date_to)}" value="${esc(String(m.qty).replace('.', ','))}"></td>
              <td class="num"><strong class="${diff >= 0 ? 'mais' : 'menos'}">${diff >= 0 ? '+' : ''}${fmtQty(diff)}</strong>
                <div class="item-sub">${m.user_name ? 'por ' + esc(m.user_name) : ''}</div></td>
              <td><div class="linha-acoes empilhada">
                <button class="botao pequeno" type="button" data-salvar>Salvar estimativa</button>
                <button class="botao pequeno claro" type="button" data-limpar="${m.id}">Voltar ao automático</button>
                <button class="botao-texto" type="button" data-ver-item="${m.item_id}">Ver semanas do item</button>
              </div></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`
        : `<div class="vazio"><strong>Nenhuma estimativa manual</strong><p>Desligue a chave, escolha um item e digite a sua estimativa em um período para ela aparecer aqui.</p></div>`}
      </section>`;
    tela.querySelector('[data-so-manuais]').addEventListener('change', (e) => { state.onlyManual = e.target.checked; go('estimativas'); });
    const tbody = tela.querySelector('tbody');
    if (tbody) bindEstimateRows(tbody);
  }

  async function viewEstimates(tela) {
    const [{ estimates }] = await Promise.all([api('GET', '/api/estimativas/manuais'), loadItems()]);
    if (state.onlyManual) return viewManualEstimates(tela, estimates);
    const items = state.items.filter((i) => i.active);
    if (!items.length) {
      tela.innerHTML = `${header('Estimativa de uso', 'Quanto a loja deve usar de cada item nas próximas semanas.')}
        <section class="painel vidro"><div class="vazio"><strong>Nenhum item ativo</strong><p>Cadastre os itens no estoque para ver as estimativas.</p></div></section>`;
      return;
    }
    if (!items.some((i) => i.id === state.estimateItem)) state.estimateItem = items[0].id;
    const est = await api('GET', '/api/estimativas?item=' + state.estimateItem);
    const unit = esc(est.item.unit);
    const p = est.profile;
    const order = [1, 2, 3, 4, 5, 6, 0]; // segunda primeiro
    const peak = Math.max(...p.wd, p.holiday, 0.0001);

    tela.innerHTML = `
      ${header('Estimativa de uso', `O sistema aprende o ritmo de cada dia da semana e dos feriados pelas saídas dos últimos ${est.window_days} dias. Quando você souber de algo que o histórico não mostra, informe a sua estimativa para o período: ela passa a valer nas faturas.`)}
      <section class="painel vidro">
        <div class="filtros filtros-estimativa">
          <select aria-label="Item" data-item>${items.map((i) => `<option value="${i.id}" ${i.id === state.estimateItem ? 'selected' : ''}>${esc(i.name)} (${esc(i.sku)})${estimates.some((m) => m.item_id === i.id) ? ' - com estimativa manual' : ''}</option>`).join('')}</select>
          ${manualToggle(estimates.length)}
        </div>
        <h3>Uso típico por dia</h3>
        <div class="ritmo">
          ${order.map((w) => `<div><div class="barra"><span style="height:${Math.round((p.wd[w] / peak) * 100)}%"></span></div><strong>${fmtQty(p.wd[w])}</strong><small>${WEEKDAYS[w]}</small></div>`).join('')}
          <div class="feriado"><div class="barra"><span style="height:${Math.round((p.holiday / peak) * 100)}%"></span></div><strong>${fmtQty(p.holiday)}</strong><small>Feriado</small></div>
        </div>
        <p class="item-sub">${p.holiday_learned ? 'O valor de feriado vem dos feriados que caíram no histórico.' : 'Ainda não há feriado no histórico: por enquanto, feriado conta como a média de sábado e domingo.'}</p>
      </section>
      <section class="painel vidro">
        <h3>Próximas semanas</h3>
        <div class="rolagem"><table>
          <thead><tr><th>Período</th><th class="num">Automático</th><th>Sua estimativa</th><th class="num">Vale para o cálculo</th><th></th></tr></thead>
          <tbody>${est.blocks.map((b, i) => {
            const diff = b.adjusted === null ? 0 : b.adjusted - b.auto;
            return `<tr data-bloco="${i}" data-item="${est.item.id}" data-de="${b.from}" data-ate="${b.to}">
              <td><div class="item-nome">${b.kind === 'semana' ? 'Segunda a sexta' : 'Fim de semana'}${b.current ? ' <span class="selo destaque">Agora</span>' : ''}</div>
                <div class="item-sub">${shortDay(b.from)} a ${shortDay(b.to)}${b.used ? ` | já saiu ${fmtQty(b.used)} ${unit}` : ''}</div>
                ${b.holidays.length ? `<div class="selos">${b.holidays.map((h) => `<span class="selo baixo">${esc(h.name)} (${shortDay(h.date)})</span>`).join('')}</div>` : ''}</td>
              <td class="num">${fmtQty(b.auto)} ${unit}</td>
              <td><input class="curto" inputmode="decimal" aria-label="Sua estimativa para ${shortDay(b.from)} a ${shortDay(b.to)}" placeholder="${fmtQty(b.auto)}" value="${b.adjusted === null ? '' : esc(String(b.adjusted).replace('.', ','))}"></td>
              <td class="num"><strong>${fmtQty(b.adjusted === null ? b.auto : b.adjusted)}</strong> ${unit}
                ${b.adjusted === null ? '' : `<div class="item-sub">${diff >= 0 ? '+' : ''}${fmtQty(diff)} sobre o automático${b.user_name ? ', por ' + esc(b.user_name) : ''}</div>`}</td>
              <td><div class="linha-acoes empilhada">
                <button class="botao pequeno" type="button" data-salvar>Salvar estimativa</button>
                ${b.override_id ? `<button class="botao pequeno claro" type="button" data-limpar="${b.override_id}">Voltar ao automático</button>` : ''}
              </div></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>`;

    tela.querySelector('[data-item]').addEventListener('change', (e) => { state.estimateItem = Number(e.target.value); go('estimativas'); });
    tela.querySelector('[data-so-manuais]').addEventListener('change', (e) => { state.onlyManual = e.target.checked; go('estimativas'); });
    bindEstimateRows(tela.querySelector('tbody'));
  }

  // ---------- Previsão de compra (faturas por mês) ----------

  const STATUS = { fechada: ['neutro', 'Fechada'], aberta: ['destaque', 'Aberta'], prevista: ['neutro', 'Prevista'] };

  async function viewForecast(tela) {
    const [fc] = await Promise.all([api('GET', '/api/previsao'), loadItems()]);
    state.forecast = fc;
    if (!fc.months.some((m) => m.key === state.month)) state.month = fc.months.find((m) => m.status === 'aberta').key;

    tela.innerHTML = `
      ${header('Previsão de compra', `Uma fatura por mês, calculada pelo uso dos últimos ${fc.settings.window_days} dias. Os meses passados mostram o que foi comprado de fato.`, '<button class="botao claro" type="button" data-csv>Exportar fatura (CSV)</button>')}
      <section class="painel vidro">
        <div class="meses" role="tablist" aria-label="Faturas">
          ${fc.months.map((m) => `<button type="button" role="tab" class="${m.status}" data-mes="${m.key}" aria-selected="${m.key === state.month}">
            <span class="mes"><span class="ponto"></span>${monthName(m.month, 'short')} ${String(m.year).slice(2)}</span>
            <span class="valor">${fmtMoney(m.total)}</span>
          </button>`).join('')}
        </div>
        <div id="fatura"></div>
      </section>`;

    const box = tela.querySelector('#fatura');
    const draw = () => {
      const m = fc.months.find((x) => x.key === state.month);
      const [cls, label] = STATUS[m.status];
      const closed = m.status === 'fechada';
      const note = closed
        ? 'Soma das entradas registradas neste mês.'
        : m.status === 'aberta'
          ? `Compras sugeridas para cobrir os ${m.days} dias que faltam do mês e terminar com a folga de segurança.`
          : 'Projeção, considerando que as compras das faturas anteriores sejam feitas.';
      box.innerHTML = `
        <div class="fatura-cabeca">
          <div>
            <h2>Fatura de ${monthName(m.month)} de ${m.year} <span class="selo ${cls}">${label}</span></h2>
            <div class="fatura-total">${fmtMoney(m.total)}</div>
            <p class="fatura-nota">${note}</p>
          </div>
          <div class="fatura-lado"><dl>
            <dt>Itens</dt><dd>${m.lines.length}</dd>
            ${m.status === 'aberta' ? `<dt>Já comprado no mês</dt><dd>${fmtMoney(m.bought_total)}</dd>` : ''}
            ${m.adjusted_lines ? `<dt>Com estimativa sua</dt><dd>${m.adjusted_lines}</dd>` : ''}
          </dl></div>
        </div>
        ${m.lines.length ? `<div class="rolagem"><table>
          <thead><tr><th>Item</th>${closed ? '' : '<th class="num">Uso por dia</th><th class="num">Estoque no início</th><th class="num">Consumo previsto</th>'}<th class="num">${closed ? 'Comprado' : 'Comprar'}</th>${closed ? '' : '<th class="num">Custo</th>'}<th class="num">Total</th>${closed ? '' : '<th>Pedir até</th><th></th>'}</tr></thead>
          <tbody>${m.lines.map((l) => `<tr>
            <td><div class="item-nome">${esc(l.name)}</div><div class="item-sub">${esc(l.sku)}${l.supplier ? ' | ' + esc(l.supplier) : ''}</div></td>
            ${closed ? '' : `<td class="num">${fmtQty(l.daily)}</td><td class="num">${fmtQty(l.start_stock)}</td><td class="num">${fmtQty(l.consumption)}${l.adjusted ? `<div class="item-sub">automático ${fmtQty(l.auto_consumption)}</div>` : ''}</td>`}
            <td class="num"><strong>${fmtQty(l.buy)}</strong> ${esc(l.unit)}</td>
            ${closed ? '' : `<td class="num">${fmtMoney(l.cost)}</td>`}
            <td class="num"><strong>${fmtMoney(l.total)}</strong></td>
            ${closed ? '' : `<td>${l.order_by ? fmtDate(l.order_by) : '<span class="selo baixo">Agora</span>'}</td>
            <td><div class="linha-acoes"><button class="botao pequeno destaque" type="button" data-comprar="${l.item_id}">Registrar compra</button></div></td>`}
          </tr>`).join('')}</tbody>
        </table></div>` : `<div class="vazio"><strong>${closed ? 'Nenhuma compra registrada neste mês' : 'Nada a comprar neste mês'}</strong><p>${closed ? 'As entradas de estoque aparecem aqui.' : state.items.length ? 'O estoque atual cobre o consumo previsto. Sem saídas registradas, o sistema não tem como estimar o uso.' : 'Cadastre os itens e registre as saídas para a previsão aparecer.'}</p></div>`}`;
      tela.querySelectorAll('[data-mes]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mes === state.month)));
    };
    draw();
    const current = tela.querySelector('[aria-selected="true"]');
    // Centraliza o mês aberto rolando só a faixa de meses, nunca a página.
    if (current) {
      const strip = current.parentElement;
      strip.scrollLeft = current.offsetLeft - strip.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    }

    tela.querySelector('.meses').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mes]');
      if (!b) return;
      state.month = b.dataset.mes;
      draw();
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-comprar]');
      if (!b) return;
      const m = fc.months.find((x) => x.key === state.month);
      const line = m.lines.find((l) => l.item_id === Number(b.dataset.comprar));
      const item = state.items.find((i) => i.id === line.item_id);
      movementDialog({ item, type: 'entrada', qty: line.buy, cost: line.cost, note: `Compra da fatura de ${monthName(m.month)} de ${m.year}` });
    });
    tela.querySelector('[data-csv]').addEventListener('click', () => {
      const m = fc.months.find((x) => x.key === state.month);
      const n = (v) => String(v ?? '').replace('.', ',');
      const cell = (v) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const rows = [['SKU', 'Item', 'Unidade', 'Quantidade', 'Custo unitário', 'Total', 'Pedir até']];
      for (const l of m.lines) rows.push([l.sku, l.name, l.unit, n(l.buy), n(l.cost ?? (l.buy ? Math.round((l.total / l.buy) * 100) / 100 : 0)), n(l.total), m.status === 'fechada' ? '' : l.order_by ? fmtDate(l.order_by) : 'Agora']);
      rows.push(['', 'Total', '', '', '', n(m.total), '']);
      saveFile({ blob: new Blob(['﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv' }), name: `fatura-compras-${m.key}.csv` });
    });
  }

  // ---------- Histórico de compras (preço pago em cada entrada) ----------

  // Variação do preço em relação à compra anterior do mesmo item.
  function priceChange(cost, prev) {
    if (prev === null || prev === undefined) return '<span class="item-sub">primeira compra</span>';
    const diff = cost - prev;
    if (Math.abs(diff) < 0.005) return '<span class="item-sub">mesmo preço</span>';
    const pct = prev > 0 ? ` (${diff > 0 ? '+' : ''}${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format((diff / prev) * 100)}%)` : '';
    return `<span class="selo ${diff > 0 ? 'zerado' : 'ok'}">${diff > 0 ? 'Subiu' : 'Caiu'} ${fmtMoney(Math.abs(diff))}${pct}</span><div class="item-sub">antes ${fmtMoney(prev)}</div>`;
  }

  async function viewPurchases(tela) {
    const q = state.purchaseItem ? '?item=' + state.purchaseItem : '';
    const [{ purchases }] = await Promise.all([api('GET', '/api/compras' + q), loadItems()]);
    const item = state.items.find((i) => i.id === state.purchaseItem);

    let summary = '';
    if (item && purchases.length) {
      const costs = purchases.map((p) => p.unit_cost);
      const qty = purchases.reduce((s, p) => s + p.qty, 0);
      const spent = purchases.reduce((s, p) => s + p.qty * p.unit_cost, 0);
      summary = `<dl class="resumo">
        <div><dt>Última compra</dt><dd>${fmtMoney(costs[0])}</dd></div>
        <div><dt>Menor e maior preço</dt><dd>${fmtMoney(Math.min(...costs))} a ${fmtMoney(Math.max(...costs))}</dd></div>
        <div><dt>Preço médio pago</dt><dd>${fmtMoney(qty ? spent / qty : 0)}</dd></div>
        <div><dt>Custo no cadastro hoje</dt><dd>${fmtMoney(item.cost)}</dd></div>
      </dl>`;
    }

    tela.innerHTML = `
      ${header('Histórico de compras', 'Cada entrada com o preço pago e o fornecedor daquele dia. Mudar o custo do item depois não altera o que está aqui.')}
      <section class="painel vidro">
        <div class="filtros">
          <select aria-label="Filtrar por item" data-item>
            <option value="">Todos os itens</option>
            ${state.items.map((i) => `<option value="${i.id}" ${i.id === state.purchaseItem ? 'selected' : ''}>${esc(i.name)} (${esc(i.sku)})</option>`).join('')}
          </select>
        </div>
        ${summary}
        ${purchases.length ? `
        <div class="rolagem"><table>
          <thead><tr><th>Data</th><th>Item</th><th class="num">Quantidade</th><th class="num">Preço pago</th><th>Em relação à compra anterior</th><th class="num">Total</th><th>Fornecedor</th><th>Quem registrou</th></tr></thead>
          <tbody>${purchases.map((p) => `<tr>
            <td>${fmtWhen(p.occurred_at)}</td>
            <td><div class="item-nome">${esc(p.name)}</div><div class="item-sub">${esc(p.sku)}${p.note ? ' | ' + esc(p.note) : ''}</div></td>
            <td class="num">${fmtQty(p.qty)} ${esc(p.unit)}</td>
            <td class="num"><strong>${fmtMoney(p.unit_cost)}</strong></td>
            <td>${priceChange(p.unit_cost, p.prev_cost)}</td>
            <td class="num">${fmtMoney(p.qty * p.unit_cost)}</td>
            <td>${esc(p.supplier) || '-'}</td>
            <td>${esc(p.user_name) || '-'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${purchases.length === 500 ? '<p class="item-sub">Mostrando as 500 compras mais recentes. Filtre por item ou exporte as entradas para ver tudo.</p>' : ''}`
        : `<div class="vazio"><strong>Nenhuma compra registrada${item ? ' para este item' : ''}</strong><p>As entradas de estoque aparecem aqui com o preço pago em cada uma.</p></div>`}
      </section>`;
    tela.querySelector('[data-item]').addEventListener('change', (e) => { state.purchaseItem = Number(e.target.value) || null; go('compras'); });
  }

  // ---------- Métricas (admin) ----------

  async function viewMetrics(tela) {
    const fc = state.forecast || (state.forecast = await api('GET', '/api/previsao'));
    const s = fc.settings;
    tela.innerHTML = `
      ${header('Métricas', 'Os números que o sistema usa para calcular cada fatura de compra.')}
      <section class="painel vidro">
        <form novalidate>
          <div class="grade">
            <label class="campo"><span>Janela de análise (dias)</span><input name="window_days" inputmode="numeric" value="${s.window_days}"><small>Quantos dias de saídas entram na média de uso por dia.</small></label>
            <label class="campo"><span>Dias de segurança</span><input name="safety_days" inputmode="numeric" value="${s.safety_days}"><small>Folga que deve sobrar no fim de cada mês. Vale o maior entre esta folga e o estoque mínimo do item.</small></label>
            <label class="campo"><span>Crescimento por mês (%)</span><input name="growth_pct" inputmode="decimal" value="${String(s.growth_pct).replace('.', ',')}"><small>Aumento esperado no uso de um mês para o outro. Use valor negativo para queda.</small></label>
            <label class="campo"><span>Meses à frente</span><input name="months_ahead" inputmode="numeric" value="${s.months_ahead}"><small>Quantas faturas mostrar, contando o mês atual.</small></label>
          </div>
          <div>
            <h3>Peso de cada mês (%)</h3>
            <p class="item-sub">100 é um mês normal. Para a loja, verão costuma pedir mais: 130 significa 30% a mais de uso.</p>
          </div>
          <div class="sazonal">
            ${s.seasonality.map((v, i) => `<label>${monthName(i + 1, 'short')}<input name="m${i}" inputmode="numeric" value="${v}" aria-label="Peso de ${monthName(i + 1)}"></label>`).join('')}
          </div>
          <div class="explica">
            <strong>Como cada fatura é calculada</strong>
            <ol>
              <li>Pelas saídas da janela de análise, o sistema aprende quanto sai em cada dia da semana e em feriado.</li>
              <li>Consumo do mês = soma do uso previsto de cada dia × peso do mês × crescimento acumulado. Onde houver estimativa informada em "Estimativa de uso", ela substitui o automático.</li>
              <li>Comprar = consumo do mês + folga de segurança − estoque no início do mês.</li>
              <li>O resultado sobe para o próximo múltiplo do lote de compra e é multiplicado pelo custo.</li>
            </ol>
          </div>
          <p class="erro-form" role="alert"></p>
          <div class="rodape"><button class="botao" type="submit">Salvar métricas</button></div>
        </form>
      </section>`;
    const form = tela.querySelector('form');
    form.style.display = 'grid';
    form.style.gap = '20px';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitWith(form, async (d) => {
        const dec = (v) => Number(String(v).replace(',', '.'));
        await api('PUT', '/api/metricas', {
          window_days: dec(d.window_days), safety_days: dec(d.safety_days), growth_pct: dec(d.growth_pct), months_ahead: dec(d.months_ahead),
          seasonality: Array.from({ length: 12 }, (_, i) => dec(d['m' + i])),
        });
        state.forecast = null;
        toast('Métricas salvas');
      });
    });
  }

  // ---------- Usuários (admin) ----------

  async function viewUsers(tela) {
    const [{ users }, { pending }] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/solicitacoes/pendentes')]);
    tela.innerHTML = `
      ${header('Usuários', 'Admin ajusta tudo, inclusive métricas e usuários. Gestor cuida do estoque, das movimentações e das compras e pode pedir usuários novos.', `<button class="botao claro" type="button" data-pedidos>Solicitações${pending ? ` (${pending})` : ''}</button><button class="botao" type="button" data-novo>Adicionar usuário</button>`)}
      ${pending ? `<p class="nota vidro">${pending === 1 ? 'Há 1 solicitação de usuário aguardando' : `Há ${pending} solicitações de usuário aguardando`} resposta.</p>` : ''}
      <section class="painel vidro"><div class="rolagem"><table>
        <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Duas etapas</th><th>Situação</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr class="${u.active ? '' : 'inativo'}">
          <td class="item-nome">${esc(u.name)}</td>
          <td>${esc(u.username)}</td>
          <td>${u.role === 'admin' ? 'Admin' : 'Gestor'}</td>
          <td><span class="selo ${u.totp_enabled ? 'ok' : 'baixo'}">${u.totp_enabled ? 'Ativa' : 'Ativa no próximo login'}</span></td>
          <td>${!u.active ? 'Desativado' : u.code_locked ? '<span class="selo zerado">Bloqueado: erros no código</span>' : 'Ativo'}</td>
          <td><div class="linha-acoes"><button class="botao pequeno claro" type="button" data-editar="${u.id}">Editar</button></div></td>
        </tr>`).join('')}</tbody>
      </table></div></section>`;
    tela.querySelector('[data-novo]').addEventListener('click', () => userDialog(null));
    tela.querySelector('[data-pedidos]').addEventListener('click', requestsDialog);
    tela.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => userDialog(users.find((u) => u.id === Number(b.dataset.editar)))));
  }

  function userDialog(user) {
    openDialog(`
      <form novalidate autocomplete="off">
        <h2>${user ? 'Editar usuário' : 'Adicionar usuário'}</h2>
        <div class="grade">
          <label class="campo inteira"><span>Nome</span><input name="name" value="${esc(user ? user.name : '')}" required maxlength="80"></label>
          <label class="campo"><span>Usuário</span><input name="username" value="${esc(user ? user.username : '')}" ${user ? 'disabled' : 'required'} autocapitalize="none" spellcheck="false"></label>
          <label class="campo"><span>Perfil</span><select name="role">
            <option value="gestor" ${user && user.role === 'gestor' ? 'selected' : ''}>Gestor</option>
            <option value="admin" ${user && user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select></label>
          <label class="campo inteira"><span>${user ? 'Nova senha' : 'Senha inicial'}</span><input name="password" type="password" autocomplete="new-password" ${user ? '' : 'required'}><small>Mínimo de 10 caracteres.${user ? ' Deixe em branco para manter a atual.' : ' No primeiro login a pessoa cadastra o app autenticador.'}</small></label>
          ${user ? `
          <label class="marcar inteira"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> Usuário ativo (pode entrar no sistema)</label>
          ${user.code_locked ? `<p class="nota inteira">Este usuário errou o código do autenticador várias vezes seguidas e está bloqueado. Confirme com a pessoa que foi ela antes de liberar.</p>
          <label class="marcar inteira"><input type="checkbox" name="unlock"> Liberar o acesso</label>` : ''}
          <label class="marcar inteira"><input type="checkbox" name="reset2fa"> Refazer o cadastro do autenticador (celular novo ou perdido)</label>` : ''}
        </div>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-fechar>Cancelar</button>
          <button class="botao" type="submit">${user ? 'Salvar alterações' : 'Adicionar usuário'}</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (d) => {
          if (user) {
            const body = { name: d.name, role: d.role, active: form.active.checked, reset2fa: form.reset2fa.checked, unlock: Boolean(form.unlock && form.unlock.checked) };
            if (d.password) body.password = d.password;
            await api('PATCH', `/api/usuarios/${user.id}`, body);
          } else await api('POST', '/api/usuarios', d);
          closeDialog();
          toast(user ? 'Alterações salvas' : 'Usuário adicionado');
          go('usuarios');
        });
      });
    });
  }

  // ---------- Solicitações de novo usuário ----------

  const REQUEST_STATUS = { pendente: ['baixo', 'Aguardando'], aprovada: ['ok', 'Aprovada'], recusada: ['zerado', 'Recusada'] };
  const roleLabel = (r) => (r === 'admin' ? 'Admin' : 'Gestor');

  // Sino do admin: mostra quantas solicitações aguardam resposta.
  async function updateBell() {
    const bells = $app.querySelectorAll('[data-sino]'); // lateral e cabeçalho do celular
    if (!bells.length) return;
    try {
      const { pending } = await api('GET', '/api/solicitacoes/pendentes');
      bells.forEach((bell) => {
        const badge = bell.querySelector('.contador');
        badge.hidden = !pending;
        badge.textContent = pending > 9 ? '9+' : String(pending);
        bell.classList.toggle('com-aviso', pending > 0);
        bell.title = pending ? `${pending} ${pending === 1 ? 'solicitação aguardando' : 'solicitações aguardando'}` : 'Solicitações de usuário';
        bell.setAttribute('aria-label', bell.title);
      });
    } catch { /* tenta no próximo minuto */ }
  }

  function requestCard(r, withActions) {
    const [cls, label] = REQUEST_STATUS[r.status];
    return `<article class="pedido" data-pedido="${r.id}">
      <header><strong>${esc(r.name)}</strong><span class="selo ${cls}">${label}</span></header>
      <dl>
        <div><dt>Usuário sugerido</dt><dd>${esc(r.username)}</dd></div>
        <div><dt>Perfil</dt><dd>${roleLabel(r.role)}</dd></div>
        <div><dt>Pedido por</dt><dd>${esc(r.requested_by_name) || '-'}</dd></div>
        <div><dt>Quando</dt><dd>${fmtWhen(r.created_at)}</dd></div>
      </dl>
      ${r.note ? `<p class="pedido-nota">${esc(r.note)}</p>` : ''}
      ${r.status !== 'pendente' ? `<p class="item-sub">${label} por ${esc(r.decided_by_name) || '-'} em ${fmtWhen(r.decided_at)}${r.decision_note ? `: ${esc(r.decision_note)}` : ''}</p>` : ''}
      ${withActions && r.status === 'pendente' ? `<div class="linha-acoes">
        <button class="botao pequeno claro" type="button" data-recusar>Recusar</button>
        <button class="botao pequeno" type="button" data-aprovar>Criar usuário</button>
      </div>
      <form class="recusa" hidden novalidate>
        <label class="campo"><span>Motivo da recusa (o gestor vai ver)</span><input name="note" maxlength="300"></label>
        <div class="linha-acoes"><button class="botao pequeno perigo" type="submit">Confirmar recusa</button></div>
      </form>` : ''}
    </article>`;
  }

  async function requestsDialog() {
    let requests;
    try { ({ requests } = await api('GET', '/api/solicitacoes')); } catch (err) { return toast(err.message, true); }
    const pending = requests.filter((r) => r.status === 'pendente');
    const done = requests.filter((r) => r.status !== 'pendente').slice(0, 10);
    openDialog(`
      <h2>Solicitações de usuário</h2>
      <p class="item-sub">Pedidos de acesso enviados pelos gestores.</p>
      <div class="pedidos">
        ${pending.length ? pending.map((r) => requestCard(r, true)).join('') : '<div class="vazio"><strong>Nenhuma solicitação aguardando</strong></div>'}
      </div>
      ${done.length ? `<details class="pedidos-antigos"><summary>Respondidas recentemente (${done.length})</summary><div class="pedidos">${done.map((r) => requestCard(r, false)).join('')}</div></details>` : ''}
      <div class="rodape"><button class="botao" type="button" data-fechar>Fechar</button></div>`, (dlg) => {
      dlg.querySelectorAll('[data-pedido]').forEach((card) => {
        const r = requests.find((x) => x.id === Number(card.dataset.pedido));
        const reject = card.querySelector('.recusa');
        card.querySelector('[data-recusar]')?.addEventListener('click', () => { reject.hidden = !reject.hidden; if (!reject.hidden) reject.note.focus(); });
        card.querySelector('[data-aprovar]')?.addEventListener('click', () => approveDialog(r));
        reject?.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await api('POST', `/api/solicitacoes/${r.id}/recusar`, { note: reject.note.value });
            toast('Solicitação recusada');
            updateBell();
            requestsDialog();
          } catch (err) { toast(err.message, true); }
        });
      });
    }, 'pedidos-dialogo');
  }

  // Criar o usuário a partir do pedido: os dados vêm preenchidos e o admin define a senha inicial.
  function approveDialog(r) {
    openDialog(`
      <form novalidate autocomplete="off">
        <h2>Criar usuário</h2>
        <p class="item-sub">Pedido de ${esc(r.requested_by_name) || 'um gestor'}${r.note ? `: "${esc(r.note)}"` : ''}. Confira os dados e defina a senha inicial.</p>
        <div class="grade">
          <label class="campo inteira"><span>Nome</span><input name="name" value="${esc(r.name)}" required maxlength="80"></label>
          <label class="campo"><span>Usuário</span><input name="username" value="${esc(r.username)}" required autocapitalize="none" spellcheck="false"></label>
          <label class="campo"><span>Perfil</span><select name="role">
            <option value="gestor" ${r.role === 'gestor' ? 'selected' : ''}>Gestor</option>
            <option value="admin" ${r.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select></label>
          <label class="campo inteira"><span>Senha inicial</span><input name="password" type="password" autocomplete="new-password" required><small>Mínimo de 10 caracteres. No primeiro login a pessoa cadastra o app autenticador.</small></label>
          <label class="campo inteira"><span>Recado para o gestor (opcional)</span><input name="note" maxlength="300"></label>
        </div>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-voltar>Voltar</button>
          <button class="botao" type="submit">Criar usuário</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      dlg.querySelector('[data-voltar]').addEventListener('click', requestsDialog);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (d) => {
          await api('POST', `/api/solicitacoes/${r.id}/aprovar`, d);
          toast(`Usuário ${d.username} criado`);
          updateBell();
          if (state.view === 'usuarios') go('usuarios');
          requestsDialog();
        });
      });
    });
  }

  // Tela do gestor: pedir um usuário novo e acompanhar os pedidos.
  async function viewRequestUser(tela) {
    const { requests } = await api('GET', '/api/solicitacoes');
    tela.innerHTML = `
      ${header('Solicitar usuário', 'Peça o acesso de uma pessoa nova. Um admin recebe o aviso, confere os dados e cria o usuário.')}
      <section class="painel vidro">
        <form novalidate autocomplete="off" class="form-pedido">
          <div class="grade">
            <label class="campo inteira"><span>Nome completo</span><input name="name" required maxlength="80"></label>
            <label class="campo"><span>Usuário sugerido</span><input name="username" required autocapitalize="none" spellcheck="false" placeholder="ex.: maria.silva"><small>De 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.</small></label>
            <label class="campo"><span>Perfil</span><select name="role"><option value="gestor">Gestor</option><option value="admin">Admin</option></select></label>
            <label class="campo inteira"><span>Observação para o admin</span><textarea name="note" maxlength="300" placeholder="Ex.: atendente do turno da noite, começa na segunda."></textarea></label>
          </div>
          <p class="erro-form" role="alert"></p>
          <div class="rodape"><button class="botao" type="submit">Enviar solicitação</button></div>
        </form>
      </section>
      <section class="painel vidro">
        <h2>Minhas solicitações</h2>
        <div class="pedidos">${requests.length ? requests.map((r) => requestCard(r, false)).join('') : '<div class="vazio"><strong>Nenhuma solicitação enviada</strong><p>Os pedidos aparecem aqui com a resposta do admin.</p></div>'}</div>
      </section>`;
    const form = tela.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitWith(form, async (d) => {
        await api('POST', '/api/solicitacoes', d);
        toast('Solicitação enviada para o admin');
        go('solicitacoes');
      });
    });
  }

  // ---------- Itens removidos (só admin) ----------

  async function viewRemoved(tela) {
    const { removed } = await api('GET', '/api/itens/removidos');
    tela.innerHTML = `
      ${header('Itens removidos', 'Itens excluídos do estoque, com os dados que tinham na hora e todo o histórico. Só admins veem esta tela.')}
      <section class="painel vidro">
        ${removed.length ? `
        <div class="rolagem"><table>
          <thead><tr><th>Item</th><th class="num">Saldo ao excluir</th><th class="num">Custo</th><th>Excluído em</th><th>Por</th><th class="num">Movimentações</th><th></th></tr></thead>
          <tbody>${removed.map((r) => `<tr>
            <td><div class="item-nome">${esc(r.name)}</div><div class="item-sub">${esc(r.sku)}${r.category ? ' | ' + esc(r.category) : ''}</div></td>
            <td class="num">${fmtQty(r.qty)} ${esc(r.unit)}</td>
            <td class="num">${fmtMoney(r.cost)}</td>
            <td>${fmtWhen(r.removed_at)}</td>
            <td>${esc(r.removed_by_name) || '-'}</td>
            <td class="num">${r.movimentos}</td>
            <td><div class="linha-acoes"><button class="botao pequeno claro" type="button" data-historico="${r.id}">Ver histórico</button></div></td>
          </tr>`).join('')}</tbody>
        </table></div>`
        : '<div class="vazio"><strong>Nenhum item removido</strong><p>Quando um admin excluir um item, ele aparece aqui com todo o histórico.</p></div>'}
      </section>`;
    tela.querySelectorAll('[data-historico]').forEach((b) => b.addEventListener('click', () => removedDialog(Number(b.dataset.historico))));
  }

  async function removedDialog(id) {
    let data;
    try { data = await api('GET', `/api/itens/removidos/${id}`); } catch (err) { return toast(err.message, true); }
    const { item: r, history, purchases = [] } = data;
    const spent = purchases.reduce((s, p) => s + p.total, 0);
    openDialog(`
      <h2>${esc(r.name)}</h2>
      <p class="item-sub">${esc(r.sku)}${r.category ? ' | ' + esc(r.category) : ''}. Excluído em ${fmtWhen(r.removed_at)} por ${esc(r.removed_by_name) || '-'}.</p>
      <dl class="resumo">
        <div><dt>Saldo ao excluir</dt><dd>${fmtQty(r.qty)} ${esc(r.unit)}</dd></div>
        <div><dt>Mínimo</dt><dd>${fmtQty(r.min_qty)}</dd></div>
        <div><dt>Custo</dt><dd>${fmtMoney(r.cost)}</dd></div>
        <div><dt>Fornecedor</dt><dd>${esc(r.supplier) || '-'}</dd></div>
      </dl>
      <h3>Compras (${purchases.length})${purchases.length ? ` <span class="item-sub">total ${fmtMoney(spent)}</span>` : ''}</h3>
      ${purchases.length ? `<div class="rolagem"><table>
        <thead><tr><th>Quando</th><th class="num">Quantidade</th><th class="num">Preço pago</th><th class="num">Total</th><th>Fornecedor</th><th>Quem registrou</th></tr></thead>
        <tbody>${purchases.map((p) => `<tr>
          <td>${fmtWhen(p.occurred_at)}</td>
          <td class="num">${fmtQty(p.qty)} ${esc(r.unit)}</td>
          <td class="num"><strong>${p.unit_cost === null ? '-' : fmtMoney(p.unit_cost)}</strong></td>
          <td class="num">${fmtMoney(p.total)}</td>
          <td>${esc(p.supplier) || '-'}</td>
          <td>${esc(p.user_name) || '-'}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="item-sub">Este item não tinha compras registradas.</p>'}
      <h3>Histórico completo (${history.length})</h3>
      ${history.length ? `<div class="rolagem"><table>
        <thead><tr><th>Quando</th><th>Tipo</th><th class="num">Quantidade</th><th class="num">Saldo depois</th><th>Detalhes</th></tr></thead>
        <tbody>${history.map((m) => `<tr>
          <td>${fmtWhen(m.occurred_at)}</td>
          <td><span class="selo ${m.type === 'entrada' ? 'ok' : m.type === 'saida' ? 'neutro' : 'baixo'}">${TYPE_LABEL[m.type] || esc(m.type)}</span></td>
          <td class="num ${m.delta >= 0 ? 'mais' : 'menos'}">${m.delta >= 0 ? '+' : ''}${fmtQty(m.delta)} ${esc(r.unit)}</td>
          <td class="num">${fmtQty(m.balance_after)}</td>
          <td>${m.type === 'entrada' && m.unit_cost !== null ? `${fmtMoney(m.unit_cost)}${m.supplier ? ' | ' + esc(m.supplier) : ''}<br>` : ''}<span class="item-sub">${esc(m.note)}${m.user_name ? `${m.note ? ' | ' : ''}${esc(m.user_name)}` : ''}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="item-sub">Este item não tinha movimentações.</p>'}
      <div class="rodape"><button class="botao" type="button" data-fechar>Fechar</button></div>`, null, 'removido-dialogo');
  }

  // ---------- Perfil (gestor vê o próprio) ----------
  // Nome, foto, usuário, perfil e data de cadastro. Só a foto se troca aqui; o resto, com um admin.

  // Lê a imagem escolhida, corta o quadrado do meio e reduz para 256x256 em JPG (~20–40 KB).
  // Usa data URL (a política de segurança das páginas não aceita blob:).
  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Escolha uma imagem (JPG, PNG ou WEBP).'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler essa imagem.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Não foi possível abrir essa imagem.'));
        img.onload = () => {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 256;
          canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Busca a foto (endereço com a versão) e devolve um data URL para o <img> (a página não aceita blob:).
  const photoMemory = new Map();
  async function showPhoto(url) {
    if (photoMemory.has(url)) return photoMemory.get(url);
    const { blob } = await api('GET', url);
    const src = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    photoMemory.clear(); // só a versão atual
    photoMemory.set(url, src);
    return src;
  }

  async function viewProfile(tela) {
    const { profile: p } = await api('GET', '/api/eu/perfil');
    const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
    const since = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date(p.created_at));
    tela.innerHTML = `
      ${header('Perfil', 'Os seus dados de acesso ao sistema.')}
      <section class="painel vidro perfil">
        <div class="perfil-foto">
          <span class="perfil-imagem perfil-iniciais" role="img" aria-label="${p.photo ? 'Carregando a foto' : 'Sem foto'}" data-iniciais>${esc(initials)}</span>
          ${p.photo ? `<img class="perfil-imagem" alt="Foto de ${esc(p.name)}" hidden data-foto="${esc(p.photo)}">` : ''}
          <div class="perfil-foto-acoes">
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-arquivo>
            <button class="botao pequeno claro" type="button" data-escolher>${p.photo ? 'Trocar foto' : 'Adicionar foto'}</button>
            ${p.photo ? '<button class="botao pequeno claro" type="button" data-tirar>Tirar foto</button>' : ''}
          </div>
        </div>
        <dl class="perfil-dados">
          <div class="perfil-nome"><dt><label for="perfil-nome">Nome</label></dt><dd>
            <form class="perfil-nome-form" novalidate>
              <input id="perfil-nome" name="name" value="${esc(p.name)}" maxlength="80" required autocomplete="name">
              <button class="botao pequeno" type="submit">Salvar</button>
            </form>
            <p class="erro-form" role="alert"></p>
          </dd></div>
          <div><dt>Usuário</dt><dd>${esc(p.username)}</dd></div>
          <div><dt>Perfil</dt><dd><span class="selo ${p.role === 'admin' ? 'neutro' : 'ok'}">${p.role === 'admin' ? 'Admin' : 'Gestor'}</span></dd></div>
          <div><dt>Cadastrado em</dt><dd>${esc(since)}</dd></div>
        </dl>
        <p class="item-sub perfil-nota">Aqui você muda o seu nome e a sua foto. Para mudar o usuário de login ou o perfil, fale com um admin. A senha você troca em Configurações.</p>
      </section>`;

    // Foto: vem pela API (precisa do token), com o endereço da versão. O navegador guarda em cache; na mesma
    // sessão ela também fica em memória. Enquanto não chega, aparecem as iniciais.
    // Referências pegas agora: a tela é montada fora da vista e movida depois (go()), então buscar
    // dentro de "tela" quando a foto chegar não acharia mais nada.
    const img = tela.querySelector('[data-foto]');
    const initialsEl = tela.querySelector('[data-iniciais]');
    if (img) {
      showPhoto(img.dataset.foto).then((src) => {
        img.src = src;
        img.hidden = false;
        initialsEl.hidden = true;
      }).catch(() => { initialsEl.setAttribute('aria-label', 'Foto indisponível'); });
    }

    // Nome: salva e já atualiza onde ele aparece (menu lateral e gaveta do celular).
    const nameForm = tela.querySelector('.perfil-nome-form');
    const nameInput = nameForm.querySelector('#perfil-nome'); // form.name seria o nome do próprio formulário
    nameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const errEl = nameForm.parentElement.querySelector('.erro-form');
      const btn = nameForm.querySelector('[type=submit]');
      errEl.textContent = '';
      btn.disabled = true;
      api('PATCH', '/api/eu/nome', { name: nameInput.value })
        .then(({ name }) => {
          state.user.name = name;
          nameInput.value = name;
          $app.querySelectorAll('.quem-nome strong').forEach((el) => { el.textContent = name; });
          toast('Nome salvo');
        })
        .catch((err) => { errEl.textContent = err.message; })
        .finally(() => { btn.disabled = false; });
    });

    const input = tela.querySelector('[data-arquivo]');
    tela.querySelector('[data-escolher]').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const out = await api('PUT', '/api/eu/foto', { photo: await resizePhoto(file) });
        toast(p.photo ? 'Foto trocada' : 'Foto inserida');
        photoMemory.delete(out.photo);
        go('perfil');
      } catch (err) { toast(err.message, true); }
    });
    const remove = tela.querySelector('[data-tirar]');
    if (remove) remove.addEventListener('click', async () => {
      try {
        await api('DELETE', '/api/eu/foto');
        photoMemory.clear();
        toast('Foto removida');
        go('perfil');
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- Consulta SQL (só admin) ----------
  // Editor + lista de tabelas + resultado. O servidor roda só leitura, com papel próprio no banco
  // (server/sql.js). O texto do editor fica guardado enquanto a pessoa navega; o histórico, no navegador.

  const SQL_EXAMPLES = [
    ['Itens com custo a partir de R$ 3', 'SELECT sku, name, qty, cost FROM items WHERE cost >= 3 ORDER BY cost DESC'],
    ['Itens abaixo do mínimo', 'SELECT sku, name, qty, min_qty FROM items WHERE active AND qty <= min_qty ORDER BY name'],
    ['Saídas dos últimos 7 dias por item', "SELECT i.name, sum(-m.delta) AS saiu\n  FROM movements m JOIN items i ON i.id = m.item_id\n WHERE m.type = 'saida' AND m.occurred_at >= now() - interval '7 days'\n GROUP BY i.name ORDER BY saiu DESC"],
    ['Compras do mês com total', "SELECT i.name, m.delta AS qtd, m.unit_cost, m.delta * m.unit_cost AS total, m.supplier, m.occurred_at\n  FROM movements m JOIN items i ON i.id = m.item_id\n WHERE m.type = 'entrada' AND m.occurred_at >= date_trunc('month', now())\n ORDER BY m.occurred_at DESC"],
    ['Últimos acessos negados', 'SELECT created_at, user_name, method, path, status FROM api_logs WHERE status IN (401, 403) ORDER BY id DESC LIMIT 50'],
    ['Itens em pacote', 'SELECT sku, name, qty AS pacotes, units_per_pack, qty * units_per_pack AS unidades FROM items WHERE units_per_pack IS NOT NULL'],
  ];
  const SQL_HISTORY_KEY = 'gt_sql_historico';
  function sqlHistory() {
    try { return JSON.parse(localStorage.getItem(SQL_HISTORY_KEY)) || []; } catch { return []; }
  }
  function saveSqlHistory(text) {
    const list = [text, ...sqlHistory().filter((s) => s !== text)].slice(0, 20);
    try { localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(list)); } catch { /* sem armazenamento: sem histórico */ }
  }

  function sqlCell(v) {
    if (v === null || v === undefined) return '<span class="sql-nulo">NULL</span>';
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return text.length > 160 ? `<span title="${esc(text)}">${esc(text.slice(0, 160))}…</span>` : esc(text);
  }

  async function viewSql(tela) {
    const { tables, max_rows, timeout } = await api('GET', '/api/sql/tabelas');
    if (state.sqlText === undefined) state.sqlText = SQL_EXAMPLES[0][1];
    tela.innerHTML = `
      ${header('Consulta SQL', `Leia qualquer dado do banco em SQL (PostgreSQL). Só leitura: o próprio banco recusa alterações. Até ${max_rows} linhas e ${timeout.replace('s', ' segundos')} por consulta. Senhas, segredos e sessões ficam de fora.`)}
      <section class="painel vidro sql-area">
        <aside class="sql-tabelas" aria-label="Tabelas">
          <strong>Tabelas</strong>
          ${tables.map((t) => `<details>
            <summary><button type="button" class="sql-tabela" data-tabela="${esc(t.name)}" title="Inserir SELECT desta tabela">${esc(t.name)}</button></summary>
            <ul>${t.columns.map((c) => `<li><button type="button" data-coluna="${esc(c.name)}" title="Inserir o nome da coluna">${esc(c.name)}</button><small>${esc(c.type)}</small></li>`).join('')}</ul>
          </details>`).join('')}
        </aside>
        <div class="sql-editor-area">
          <div class="sql-barra">
            <select aria-label="Exemplos" data-exemplo><option value="">Exemplos...</option>${SQL_EXAMPLES.map(([label], i) => `<option value="${i}">${esc(label)}</option>`).join('')}</select>
            <select aria-label="Histórico" data-historico><option value="">Histórico...</option>${sqlHistory().map((s, i) => `<option value="${i}">${esc(s.replace(/\s+/g, ' ').slice(0, 70))}</option>`).join('')}</select>
            <button class="botao" type="button" data-executar title="Ctrl + Enter">Executar</button>
          </div>
          <textarea class="sql-editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Consulta SQL" data-sql>${esc(state.sqlText)}</textarea>
          <p class="item-sub">Ctrl + Enter executa. Nomes sem aspas valem em maiúsculas ou minúsculas (Items = items). Clique numa tabela ou coluna para inserir.</p>
        </div>
      </section>
      <section class="painel vidro sql-resultado" data-resultado>
        <div class="vazio"><strong>Pronto para consultar</strong><p>Escreva a consulta e toque em Executar.</p></div>
      </section>`;

    const editor = tela.querySelector('[data-sql]');
    const out = tela.querySelector('[data-resultado]');
    const runBtn = tela.querySelector('[data-executar]');
    let last = null;

    const insert = (text) => {
      const { selectionStart: a, selectionEnd: b, value } = editor;
      editor.value = value.slice(0, a) + text + value.slice(b);
      editor.selectionStart = editor.selectionEnd = a + text.length;
      editor.focus();
      state.sqlText = editor.value;
    };

    async function run() {
      const text = editor.value.trim();
      state.sqlText = editor.value;
      if (!text) return;
      runBtn.disabled = true;
      out.classList.add('carregando');
      try {
        const r = await api('POST', '/api/sql', { sql: text });
        last = r;
        saveSqlHistory(text);
        out.innerHTML = `
          <div class="sql-meta">
            <span><strong>${r.rows.length}</strong> ${r.rows.length === 1 ? 'linha' : 'linhas'} · ${r.ms} ms${r.truncated ? ` · <span class="selo baixo">mostrando só as primeiras ${r.max_rows}</span>` : ''}</span>
            ${r.rows.length ? '<button class="botao pequeno claro" type="button" data-csv>Exportar CSV</button>' : ''}
          </div>
          ${r.rows.length
            ? `<div class="rolagem sql-tabela-resultado"><table>
                <thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
                <tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${sqlCell(v)}</td>`).join('')}</tr>`).join('')}</tbody>
              </table></div>`
            : '<div class="vazio"><strong>Nenhuma linha</strong><p>A consulta rodou, mas nada atende ao filtro.</p></div>'}`;
      } catch (err) {
        out.innerHTML = `<div class="sql-erro" role="alert"><strong>Não foi possível executar</strong><p>${esc(err.message)}</p></div>`;
      } finally {
        runBtn.disabled = false;
        out.classList.remove('carregando');
      }
    }

    runBtn.addEventListener('click', run);
    editor.addEventListener('input', () => { state.sqlText = editor.value; });
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insert('  '); }
    });
    tela.querySelector('[data-exemplo]').addEventListener('change', (e) => {
      if (e.target.value === '') return;
      editor.value = state.sqlText = SQL_EXAMPLES[Number(e.target.value)][1];
      e.target.value = '';
      editor.focus();
    });
    tela.querySelector('[data-historico]').addEventListener('change', (e) => {
      if (e.target.value === '') return;
      editor.value = state.sqlText = sqlHistory()[Number(e.target.value)] || editor.value;
      e.target.value = '';
      editor.focus();
    });
    tela.querySelector('.sql-tabelas').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tabela]');
      const c = e.target.closest('[data-coluna]');
      if (t) { e.preventDefault(); editor.value = state.sqlText = `SELECT * FROM ${t.dataset.tabela} LIMIT 100`; editor.focus(); }
      else if (c) insert(c.dataset.coluna);
    });
    out.addEventListener('click', (e) => {
      if (!e.target.closest('[data-csv]') || !last) return;
      const cell = (v) => {
        const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = '﻿' + [last.columns.map(cell).join(';'), ...last.rows.map((r) => r.map(cell).join(';'))].join('\r\n');
      saveFile({ blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), name: `consulta-${new Date().toISOString().slice(0, 10)}.csv` });
    });
  }

  // ---------- Configurações (de cada usuário) ----------

  async function viewSettings(tela) {
    const u = state.user;
    const { version } = await api('GET', '/api/versao');
    tela.innerHTML = `
      ${header('Configurações', 'Valem só para o seu usuário.', `<a class="versao" href="/version" data-ajuda title="Ver as novidades desta versão">v${esc(version)}</a>`)}
      <section class="painel vidro ajustes">
        <h2>Sessão</h2>
        <label class="chave-liga">
          <input type="checkbox" role="switch" data-manter ${u.keep_alive ? 'checked' : ''}>
          <span class="trilho" aria-hidden="true"></span>
          <span><strong>Manter ativo</strong><small>Ligado: o sistema fica aberto pelo tempo que for, até você sair.
            Desligado: depois de ${u.idle_minutes} minutos sem ninguém mexer, a sessão é encerrada e pede login de novo.</small></span>
        </label>
        <p class="item-sub">Um novo login com o seu usuário neste mesmo navegador encerra a sessão anterior.</p>
      </section>
      <section class="painel vidro ajustes so-computador">
        <h2>Menu</h2>
        <div class="tipos dois posicao-menu" role="radiogroup" aria-label="Posição do menu">
          <label><input type="radio" name="menu" value="lateral" ${menuPosition() === 'lateral' ? 'checked' : ''}><span>Na lateral</span></label>
          <label><input type="radio" name="menu" value="topo" ${menuPosition() === 'topo' ? 'checked' : ''}><span>No topo</span></label>
        </div>
        <p class="item-sub">Vale para este computador. No celular o menu fica sempre na barra de baixo.</p>
      </section>
      <section class="painel vidro ajustes">
        <h2>Senha</h2>
        <p class="item-sub">Ao trocar, as suas outras sessões abertas são encerradas.</p>
        <div><button class="botao claro" type="button" data-senha>Trocar senha</button></div>
      </section>
      <section class="painel vidro ajustes">
        <h2>Ajuda</h2>
        <div class="links-ajuda">
          <a class="link-ajuda" href="/duvidas" data-ajuda>
            ${icon('ajuda')}<span><strong>Central de dúvidas</strong><small>Manual do sistema, passo a passo, com as perguntas mais comuns.</small></span>
          </a>
          <a class="link-ajuda" href="/version" data-ajuda>
            ${icon('novidades')}<span><strong>Novidades da versão</strong><small>O que mudou em cada versão. Você está na v${esc(version)}.</small></span>
          </a>
          <button class="link-ajuda" type="button" data-ver-aviso>
            ${icon('novidades')}<span><strong>Ver o aviso desta versão</strong><small>Abre de novo o resumo animado do que chegou na v${esc(version)}.</small></span>
          </button>
          ${isAdmin() ? `<a class="link-ajuda" href="/duvidasdev" data-ajuda>
            ${icon('codigo')}<span><strong>Documentação técnica</strong><small>Só para admins: arquitetura, APIs, autenticação, segurança e banco.</small></span>
          </a>
          <a class="link-ajuda" href="/partner" data-ajuda>
            ${icon('registro')}<span><strong>Registro da API</strong><small>Só para admins: quem fez o quê, quando, o que foi enviado e a resposta.</small></span>
          </a>` : ''}
        </div>
      </section>`;
    // Marca nesta aba que a pessoa saiu do sistema para a ajuda: lá aparece o botão "Voltar ao sistema".
    tela.querySelectorAll('[data-ajuda]').forEach((a) => a.addEventListener('click', () => {
      try { sessionStorage.setItem('gt_voltar', 'configuracoes'); } catch { /* sem armazenamento: sem botão de voltar */ }
    }));
    tela.querySelector('[data-ver-aviso]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const notes = await (await fetch('/api/novidades')).json();
        if (notes.releases && notes.releases[0]) whatsNewDialog(notes.releases[0]);
      } catch { toast('Não foi possível carregar as novidades. Tente de novo.', true); } finally {
        btn.disabled = false;
      }
    });
    tela.querySelectorAll('input[name="menu"]').forEach((r) => r.addEventListener('change', () => setMenuPosition(r.value)));
    const toggle = tela.querySelector('[data-manter]');
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        state.user = (await api('PATCH', '/api/eu/preferencias', { keep_alive: toggle.checked })).user;
        toast(toggle.checked ? 'Manter ativo ligado' : `Manter ativo desligado: a sessão termina após ${u.idle_minutes} min sem uso`);
      } catch (err) {
        toggle.checked = !toggle.checked;
        toast(err.message, true);
      } finally {
        toggle.disabled = false;
      }
    });
    tela.querySelector('[data-senha]').addEventListener('click', passwordDialog);
  }

  function passwordDialog() {
    openDialog(`
      <form novalidate>
        <h2>Trocar senha</h2>
        <label class="campo"><span>Senha atual</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="campo"><span>Nova senha</span><input name="next" type="password" autocomplete="new-password" required><small>Mínimo de 10 caracteres.</small></label>
        <label class="campo"><span>Repita a nova senha</span><input name="again" type="password" autocomplete="new-password" required></label>
        <p class="erro-form" role="alert"></p>
        <div class="rodape">
          <button class="botao claro" type="button" data-fechar>Cancelar</button>
          <button class="botao" type="submit">Trocar senha</button>
        </div>
      </form>`, (dlg) => {
      const form = dlg.querySelector('form');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitWith(form, async (d) => {
          if (d.next !== d.again) throw new Error('As duas senhas novas não são iguais.');
          await api('POST', '/api/eu/senha', { current: d.current, next: d.next });
          closeDialog();
          toast('Senha trocada');
        });
      });
    });
  }

  // ---------- Início ----------

  // A tarja "Ambiente de teste" fica em js/ambiente.js, incluído em todas as páginas.

  // Volta da ajuda (/version, /duvidas): reabre a tela de onde a pessoa saiu e limpa a marca.
  function returnFromHelp() {
    let back = null;
    try { back = sessionStorage.getItem('gt_voltar'); sessionStorage.removeItem('gt_voltar'); } catch { /* sem armazenamento */ }
    return back && RENDER[back] ? back : null;
  }
  // O navegador pode devolver a página guardada em memória (botão voltar); aí só limpa a marca.
  window.addEventListener('pageshow', (e) => { if (e.persisted) returnFromHelp(); });

  (async () => {
    try {
      state.user = (await api('GET', '/api/eu')).user;
      const back = returnFromHelp();
      if (back) state.view = back;
      if (state.user) {
        renderShell();
        maybeWhatsNew().finally(() => maybeLowStockAlert());
      } else renderLogin();
    } catch {
      renderLogin();
    }
  })();
})();
