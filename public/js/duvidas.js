// Central de dúvidas (/duvidas): índice, busca, atalhos e as demonstrações animadas.
// As telas das demonstrações usam os mesmos estilos do sistema (app.css); os dados são de exemplo.
(() => {
  'use strict';

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICONS = {
    ajuda: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2.2-2.4 3.9M12 17h.01"/>',
    chave: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
    estoque: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    movimentacoes: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
    planilha: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
    estimativas: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 14h3M13.5 14h3M7.5 17.5h3"/>',
    previsao: '<path d="M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    compras: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    removidos: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
    alerta: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
    configuracoes: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  };
  const icon = (name) => `<svg class="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.ajuda}</svg>`;

  // Rola até um elemento sem mudar o endereço da página.
  function goTo(el) {
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    el.classList.remove('piscar');
    void el.offsetWidth;
    el.classList.add('piscar');
  }

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

  // ---------- Índice e atalhos ----------

  const topics = [...document.querySelectorAll('.topico')];
  const index = document.getElementById('indice');
  index.innerHTML = topics.map((t) => `<li><button type="button" data-ir="${t.id}">${icon(t.dataset.icone)}<span>${t.dataset.titulo}</span></button></li>`).join('');
  index.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ir]');
    if (b) goTo(document.getElementById(b.dataset.ir));
  });

  const COMMON = ['faq-codigo-errado', 'faq-errei-saida', 'faq-contagem-diferenca', 'faq-previsao-zerada', 'faq-celular-perdido', 'faq-saiu-sozinho', 'faq-colunas', 'faq-com-estimativa', 'faq-excluir-volta', 'faq-gestor-criar', 'faq-app', 'faq-bloqueado'];
  const shortcuts = document.getElementById('atalhos');
  shortcuts.innerHTML = COMMON.map((id) => {
    const d = document.getElementById(id);
    return d ? `<button type="button" data-faq="${id}">${icon(d.closest('.topico').dataset.icone)}<span>${d.querySelector('summary').textContent}</span></button>` : '';
  }).join('');
  shortcuts.addEventListener('click', (e) => {
    const b = e.target.closest('[data-faq]');
    if (!b) return;
    const d = document.getElementById(b.dataset.faq);
    d.open = true;
    goTo(d);
  });

  // ---------- Busca ----------

  const search = document.getElementById('busca');
  const result = document.getElementById('busca-resultado');
  const openedBySearch = new Set();
  search.addEventListener('input', () => {
    const q = norm(search.value.trim());
    openedBySearch.forEach((d) => { d.open = false; });
    openedBySearch.clear();
    let found = 0;
    for (const t of topics) {
      if (t.id === 'comuns') { t.hidden = q.length > 0; continue; }
      if (!q) { t.hidden = false; continue; }
      const hit = norm(t.textContent).includes(q);
      t.hidden = !hit;
      if (!hit) continue;
      found++;
      if (q.length >= 3) {
        t.querySelectorAll('.faq details').forEach((d) => {
          if (norm(d.textContent).includes(q) && !d.open) { d.open = true; openedBySearch.add(d); }
        });
      }
    }
    result.textContent = !q ? '' : found ? `${found} ${found === 1 ? 'assunto encontrado' : 'assuntos encontrados'}.` : 'Nada encontrado. Tente outra palavra, como "saída", "senha" ou "fatura".';
  });

  // ---------- Demonstrações animadas ----------
  // Cada passo: legenda e ações. Alvo = valor de data-alvo, ou um seletor que começa com [ ou .
  //   cursor: move o cursor até o alvo; clique: true faz o efeito de toque
  //   digitar: [alvo, texto]  mostrar / esconder: [alvos]  texto: [alvo, texto]  classe: [alvo, classe]
  //   aviso: texto do aviso verde no rodapé da tela

  const STEPS = {
    entrar: [
      { legenda: 'Digite o seu usuário.', digitar: ['usuario', 'maria.silva'] },
      { legenda: 'Digite a sua senha.', digitar: ['senha', '••••••••••'] },
      { legenda: 'Toque em Entrar.', cursor: 'entrar', clique: true },
      { legenda: 'Abra o app autenticador no celular e digite o código de 6 dígitos que aparece nele.', esconder: ['[data-etapa=senha]'], mostrar: ['[data-etapa=codigo]'], digitar: ['codigo', '482 913'] },
      { legenda: 'Toque em Confirmar código.', cursor: 'confirmar', clique: true },
      { legenda: 'Pronto: você está dentro do sistema.', esconder: ['[data-etapa=codigo]'], mostrar: ['[data-etapa=dentro]'] },
    ],
    item: [
      { legenda: 'Na tela Estoque, toque em Adicionar item.', cursor: 'novo', clique: true },
      { legenda: 'Escreva o nome do item.', mostrar: ['dialogo'], digitar: ['nome', 'Calda de morango 1,3 kg'] },
      { legenda: 'Dê um SKU (código único) e diga quanto há hoje.', digitar: ['sku', 'CAL-MOR'], digitar2: ['qtd', '12'] },
      { legenda: 'Informe o estoque mínimo: chegando nele, o sistema avisa.', digitar: ['minimo', '6'] },
      { legenda: 'Toque em Adicionar item.', cursor: 'salvar', clique: true },
      { legenda: 'O item entra na lista, já com a situação calculada.', esconder: ['dialogo'], mostrar: ['linha-nova'], texto: ['nome-tabela', 'Calda de morango 1,3 kg'], classe: ['linha-nova', 'm-novo'] },
    ],
    saida: [
      { legenda: 'Na linha do item, toque em Movimentar.', cursor: 'mover', clique: true },
      { legenda: 'Escolha o tipo: Saída.', mostrar: ['dialogo'], cursor: 'tipo-saida', clique: true, classe: ['tipo-saida', 'on'] },
      { legenda: 'Digite quanto saiu.', digitar: ['qtd', '2'] },
      { legenda: 'Toque em Registrar.', cursor: 'registrar', clique: true },
      { legenda: 'O saldo cai na hora: de 29 para 27 baldes.', esconder: ['dialogo'], texto: ['saldo', '27'], classe: ['saldo', 'm-destaque'], aviso: 'Movimentação registrada. Saldo: 27 balde' },
    ],
    importar: [
      { legenda: 'Na tela Estoque, toque em Importar.', cursor: 'importar', clique: true },
      { legenda: 'Escolha o arquivo .xlsx ou .csv.', mostrar: ['dialogo'], digitar: ['arquivo', 'estoque-gestoque.xlsx'] },
      { legenda: 'Toque em Conferir planilha. Nada é gravado ainda.', cursor: 'botao', clique: true },
      { legenda: 'Confira o resumo: o que é novo, o que muda e se há linha com erro.', mostrar: ['resumo'], texto: ['botao', 'Importar agora'] },
      { legenda: 'Estando certo, toque em Importar agora.', cursor: 'botao', clique: true },
      { legenda: 'Pronto: os itens foram criados e atualizados.', esconder: ['dialogo'], aviso: 'Planilha importada' },
    ],
    estimativa: [
      { legenda: 'O sistema calculou 50 caixas para o fim de semana.', cursor: 'campo' },
      { legenda: 'Vai ter evento? Digite a sua estimativa: 60.', digitar: ['campo', '60'] },
      { legenda: 'Toque em Salvar estimativa.', cursor: 'salvar', clique: true },
      { legenda: 'Agora vale 60, e a tela mostra a diferença sobre o automático.', texto: ['vale', '60'], mostrar: ['dif'], classe: ['vale', 'm-destaque'], aviso: 'Estimativa salva' },
    ],
    previsao: [
      { legenda: 'Escolha o mês. O mês atual é a fatura aberta.', cursor: 'mes' },
      { legenda: 'Na linha do item, toque em Registrar compra.', cursor: 'comprar', clique: true },
      { legenda: 'Quantidade e custo já vêm da fatura. Confira e toque em Registrar.', mostrar: ['dialogo'], cursor: 'registrar', clique: true },
      { legenda: 'A compra entra no estoque e o valor sai da fatura.', esconder: ['dialogo', 'linha'], texto: ['total', 'R$ 272,00'], classe: ['total', 'm-destaque'], aviso: 'Movimentação registrada. Saldo: 39 balde' },
    ],
    removido: [
      { legenda: 'O admin abre o item e toca em Excluir item.', cursor: 'excluir', clique: true },
      { legenda: 'Na confirmação, o item sai do estoque e vai para os removidos, com compras e histórico.', esconder: ['[data-etapa=editar]'], mostrar: ['[data-etapa=lista]'], pausa: 2000 },
      { legenda: 'Em Itens removidos, toque em Ver histórico.', cursor: 'historico', clique: true },
      { legenda: 'Aparecem as compras, o total gasto e todas as movimentações guardadas.', mostrar: ['detalhe'], pausa: 2400 },
    ],
    solicitacao: [
      { legenda: 'O gestor abre Solicitar usuário e preenche os dados da pessoa.', digitar: ['nome', 'Maria Silva'], digitar2: ['login', 'maria.silva'] },
      { legenda: 'Toque em Enviar solicitação.', cursor: 'enviar', clique: true, aviso: 'Solicitação enviada para o admin' },
      { legenda: 'O admin vê o sino destacado, com o número de pedidos, e toca nele.', esconder: ['[data-etapa=gestor]', 'aviso'], mostrar: ['[data-etapa=admin]'], cursor: 'sino', clique: true },
      { legenda: 'Confere os dados e toca em Criar usuário (ali ele define a senha inicial).', mostrar: ['pedido'], cursor: 'criar', clique: true },
      { legenda: 'O usuário é criado e a pessoa já pode entrar.', esconder: ['pedido'], aviso: 'Usuário maria.silva criado' },
    ],
  };

  function makeDemo(root, steps) {
    const screen = root.querySelector('.demo-tela');
    const initial = screen.innerHTML;
    root.insertAdjacentHTML('beforeend', `
      <div class="demo-controle">
        <button type="button" class="demo-botao" data-tocar aria-label="Pausar a demonstração">${reduced ? '▶' : '❚❚'}</button>
        <div class="demo-texto">
          <span class="demo-passo"></span>
          <p class="demo-legenda" aria-live="polite"></p>
          <div class="demo-pontos">${steps.map((_, i) => `<i data-ponto="${i}"></i>`).join('')}</div>
        </div>
        <span class="demo-nav">
          <button type="button" class="demo-botao" data-ant aria-label="Passo anterior">‹</button>
          <button type="button" class="demo-botao" data-prox aria-label="Próximo passo">›</button>
        </span>
      </div>`);
    const caption = root.querySelector('.demo-legenda');
    const stepLabel = root.querySelector('.demo-passo');
    const playBtn = root.querySelector('[data-tocar]');
    let cursor;
    let current = -1;
    let playing = !reduced;
    let visible = false;
    let run = 0; // muda a cada reinício: passos antigos param no meio

    const el = (target) => screen.querySelector(/^[[.]/.test(target) ? target : `[data-alvo="${target}"]`);

    function reset() {
      screen.innerHTML = initial;
      cursor = document.createElement('span');
      cursor.className = 'm-cursor';
      cursor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.5-6.8L4 20z"/></svg>';
      screen.append(cursor);
      current = -1;
    }

    function moveCursor(target) {
      const t = el(target);
      if (!t) return;
      const s = screen.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      cursor.style.left = `${r.left - s.left + Math.min(r.width * 0.6, r.width - 6)}px`;
      cursor.style.top = `${r.top - s.top + r.height * 0.55}px`;
      cursor.classList.add('visivel');
    }

    async function type(target, text, fast, token) {
      const t = el(target);
      if (!t) return;
      t.classList.add('m-foco');
      t.textContent = '';
      if (fast) { t.textContent = text; t.classList.remove('m-foco'); return; }
      for (const ch of text) {
        if (token !== run) return;
        t.textContent += ch;
        await sleep(60);
      }
      await sleep(250);
      t.classList.remove('m-foco');
    }

    async function apply(i, fast) {
      const s = steps[i];
      const token = run;
      const wait = (ms) => (fast ? Promise.resolve() : sleep(ms));
      (s.esconder || []).forEach((x) => { const t = el(x); if (t) t.hidden = true; });
      (s.mostrar || []).forEach((x) => { const t = el(x); if (t) t.hidden = false; });
      if (s.cursor) {
        moveCursor(s.cursor);
        await wait(750);
        if (token !== run) return;
        if (s.clique && !fast) {
          const t = el(s.cursor);
          cursor.classList.remove('toque');
          void cursor.offsetWidth;
          cursor.classList.add('toque');
          if (t) { t.classList.add('m-apertado'); await sleep(260); t.classList.remove('m-apertado'); }
        }
      }
      if (s.digitar) await type(s.digitar[0], s.digitar[1], fast, token);
      if (s.digitar2) await type(s.digitar2[0], s.digitar2[1], fast, token);
      if (token !== run) return;
      if (s.texto) { const t = el(s.texto[0]); if (t) t.textContent = s.texto[1]; }
      if (s.classe) { const t = el(s.classe[0]); if (t) t.classList.add(s.classe[1]); }
      if (s.aviso) { const t = el('aviso'); if (t) { t.textContent = s.aviso; t.hidden = false; } }
    }

    function label(i) {
      caption.textContent = steps[i].legenda;
      stepLabel.textContent = `Passo ${i + 1} de ${steps.length}`;
      root.querySelectorAll('[data-ponto]').forEach((p) => p.classList.toggle('on', Number(p.dataset.ponto) <= i));
    }

    // Vai direto a um passo: refaz os anteriores sem animação e anima só o pedido.
    async function show(i, animate) {
      run++;
      reset();
      for (let k = 0; k < i; k++) await apply(k, true);
      current = i;
      label(i);
      await apply(i, !animate);
    }

    // Toca a partir do passo atual; no fim, espera um pouco e recomeça. Só anda com a demonstração visível.
    async function runLoop() {
      const token = ++run;
      while (token === run) {
        if (!visible) { await sleep(300); continue; }
        if (current >= steps.length - 1) {
          await sleep(2200);
          if (token !== run) return;
          reset();
        }
        const next = current + 1;
        current = next;
        label(next);
        await apply(next, false);
        if (token !== run) return;
        await sleep(steps[next].pausa || 1500);
      }
    }

    function setPlaying(p) {
      playing = p;
      playBtn.textContent = p ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', p ? 'Pausar a demonstração' : 'Tocar a demonstração');
      if (p) runLoop();
      else run++;
    }

    playBtn.addEventListener('click', () => setPlaying(!playing));
    root.querySelector('[data-prox]').addEventListener('click', () => { setPlaying(false); show(Math.min(current + 1, steps.length - 1), !reduced); });
    root.querySelector('[data-ant]').addEventListener('click', () => { setPlaying(false); show(Math.max(current - 1, 0), false); });

    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; }, { threshold: 0.35 }).observe(root);

    reset();
    if (reduced) show(0, false);
    else runLoop();
  }

  document.querySelectorAll('[data-demo]').forEach((root) => {
    const steps = STEPS[root.dataset.demo];
    if (steps) makeDemo(root, steps);
  });
})();
