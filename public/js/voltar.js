// Páginas de ajuda (/version e /duvidas): botão flutuante "Voltar ao sistema" e ajustes para quem está logado.
// O botão só aparece quando a pessoa veio de dentro do sistema (Configurações marca isso nesta aba)
// e continua logada. Quem abre o endereço direto não vê o botão.
(async () => {
  'use strict';
  // Conta quantos passos esta página somou ao histórico (cada clique no índice de versões muda o # do
  // endereço) para o botão voltar direto a Configurações, e não ao último clique.
  const stepsOf = () => (history.state && typeof history.state.mmPassos === 'number' ? history.state.mmPassos : null);
  let steps = stepsOf();
  if (steps === null) {
    steps = 0;
    history.replaceState({ ...(history.state || {}), mmPassos: 0 }, '');
  }
  window.addEventListener('popstate', () => {
    const s = stepsOf();
    if (s === null) {
      steps += 1;
      history.replaceState({ mmPassos: steps }, '');
    } else steps = s;
  });

  let fromApp = null;
  try { fromApp = sessionStorage.getItem('gt_voltar'); } catch { /* sem armazenamento: sem botão */ }

  let user = null;
  try { user = (await (await fetch('/api/eu', { credentials: 'same-origin' })).json()).user; } catch { /* fora do ar: trata como deslogado */ }

  // Logado não precisa do "Entrar no sistema".
  if (user) document.querySelectorAll('[data-so-deslogado]').forEach((el) => { el.hidden = true; });
  if (!user || !fromApp) return;

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'voltar-flutuante';
  back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg><span>Voltar ao sistema</span>';
  back.addEventListener('click', () => {
    const cameFromHere = document.referrer && new URL(document.referrer).origin === location.origin;
    if (cameFromHere && history.length > steps + 1) history.go(-(steps + 1));
    else location.assign('/');
  });
  document.body.append(back);
})();
