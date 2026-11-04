// Tarja "Ambiente de teste" em todas as páginas (sistema, /version, /duvidas e as que vierem).
// Toda página nova inclui este script. Fora da produção (Dev na Vercel ou o computador) o servidor
// responde ambiente "teste"; na produção responde "producao" e nada aparece. Sem resposta, nada aparece.
(async () => {
  'use strict';
  try {
    const { ambiente } = await (await fetch('/api/novidades')).json();
    if (!ambiente || ambiente === 'producao') return;
    // 'demo': a demonstração estática (demo/navegador.js), com dados só no navegador.
    const demo = ambiente === 'demo';
    const tag = document.createElement('div');
    tag.className = 'selo-ambiente';
    tag.setAttribute('role', 'status');
    tag.textContent = demo ? 'Demonstração' : 'Ambiente de teste';
    document.body.append(tag);
    document.documentElement.classList.add('ambiente-teste');
    const prefix = demo ? '[Demo]' : '[Teste]';
    if (!document.title.startsWith(prefix)) document.title = `${prefix} ${document.title}`;
  } catch { /* sem a informação, não mostra nada */ }
})();
