// Aplica o modo salvo antes de a página aparecer, para não piscar no modo errado.
(function () {
  var tema = 'claro';
  try { tema = localStorage.getItem('gt_tema') || 'claro'; } catch (e) { /* armazenamento bloqueado: fica no padrão */ }
  document.documentElement.setAttribute('data-tema', tema === 'escuro' ? 'escuro' : 'claro');
})();
