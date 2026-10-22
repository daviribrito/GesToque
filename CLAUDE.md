# CLAUDE.md — GesToque

Sistema web de estoque e previsão de compras (pt-BR). Não registra vendas.

**Índice:** 1. Leia antes · 2. Ferramentas · 3. Arquitetura · 4. Banco · 5. Ambientes · 6. Regras de trabalho · 7. Preferências · 8. Interface · 9. Negócio

## 1. Leia antes
- `docs/STATUS.md` — onde parou, pendências, bugs, próxima tarefa.
- `docs/DECISOES.md` — decisões já tomadas.
- `README.md` — pastas, ambientes, publicação.

## 2. Ferramentas (fora do PATH, em `.tools/`)
- Node `.tools\node\node.exe` · npm: pôr `.tools\node` no PATH e usar `npm.cmd`
- Git `.tools\git\cmd\git.exe` · gh `.tools\gh\bin\gh.exe` (conta `daviribrito`, escopo `workflow`)
- `iniciar.cmd` (localhost:3500) · `configurar-admin.cmd` · `carregar-exemplo.cmd` (só banco local)

## 3. Arquitetura
- `server/` Node puro. `app.js` = tabela de rotas `[método, regex, função, 'aberto'|'logado'|'admin']`; lista e regras em `docs/API.md` (atualizar ao mexer em rotas).
  'logado'/'admin' exigem cookie + token `Authorization: Bearer` (GET também). Rota nova nasce 'logado' ou 'admin', nunca 'aberto' sem motivo.
  `auth.js` login/2FA/sessões/usuários/solicitações · `stock.js` itens/movimentações/planilhas/compras/removidos ·
  `forecast.js` uso/estimativas/faturas · `logs.js` registro da API (`api_logs`, tela /partner) · `db.js` conexão + SCHEMA · `config.js` .env/ambiente · `security.js` scrypt/TOTP
- `api/index.js` entrada na Vercel · `server/index.js` fora dela
- `public/` SPA (`js/app.js`, `css/app.css`) + páginas públicas `novidades.html` (/version) e `duvidas.html` (/duvidas)
- `scripts/` admin-setup, seed-demo · `mobile/` app Android (Capacitor 8, APK via GitHub Actions)

## 4. Banco
- Supabase, schema `gestoque`, RLS ligado em todas as tabelas sem políticas.
- Sem `DATABASE_URL` válido → PGlite em `data/pglite` (um processo por vez).
- Migração = editar `SCHEMA` em `server/db.js` (idempotente, só acrescentar). Roda a cada início.
- Consulta SQL (admin): papel `gestoque_leitura` só leitura. Tabela nova de operação → liberar no bloco `do $$` do SCHEMA e em `TABLES` (`server/sql.js`); tabela com segredo → nunca liberar.
- Projetos: ainda não criados (produção e dev). Até lá, só banco local.
- Vercel: sempre o **pooler** (porta 6543); conexão direta só tem IPv6.
- Fotos de perfil: Supabase Storage, bucket **privado** `fotos-perfil` (`server/photos.js`), chave `SUPABASE_SERVICE_ROLE_KEY` (Preview: `_Dev`). Nada público: a foto só sai pela API. Banco local: `data/fotos/`.

## 5. Ambientes
| | Produção | Teste |
|---|---|---|
| Branch | `main` | `Dev` |
| Vercel | gestoque.vercel.app (a criar) | Preview do `Dev` (login da Vercel) |
| Banco | `DATABASE_URL` | `DATABASE_URL_Dev` (Preview ignora `DATABASE_URL`) |
| Computador | — | `.env` aponta para dev |

Fora da produção aparece o selo "Ambiente de teste" (`config.AMBIENTE`) em todas as páginas, via `public/js/ambiente.js`. **Toda página HTML nova deve incluir `<script src="/js/ambiente.js" defer></script>`.** Na produção não aparece.

## 6. Regras de trabalho
1. Commit só no `Dev`. `main` = produção; só a pedido: `git push origin Dev:main` e `git branch -f main origin/main`. Não fazer checkout da `main`.
2. `git add` só dos arquivos alterados. Nunca versionar `.env`, `data/`, `.tools/`.
3. Commits em português; com aspas no PowerShell 5.1, usar `git commit -F arquivo`.
4. Mudou `server/` → reiniciar o servidor local.
5. Testes que gravam: servidor separado com banco local (`$env:DATABASE_URL=''; $env:PORT='3300'`). Logins em `data/login-de-teste.txt`. `GT_ESPERAS_CODIGO=1,2,3` encurta o 2FA. `GT_ATRASO_BANCO=147` simula a demora do Supabase no banco local (medir desempenho).
9. Desempenho: consultas independentes sempre em `Promise.all`; cada ida ao banco custa ~150 ms (ver DECISOES 8b).
6. Não exibir senhas/segredos no chat.
7. Nova versão: `package.json` + `package-lock.json`, bloco no topo de `server/novidades.json` (cada seção com `"type": "novo" | "melhoria" | "ajuste"`, usado no aviso de versão nova que aparece ao entrar), atualizar `public/duvidas.html`.
8. Ao terminar tarefa importante: atualizar `docs/STATUS.md` (e `DECISOES.md`).

## 7. Preferências do usuário
- Português do Brasil, linguagem simples.
- "start server" → responder só `http://localhost:3500 OK` (explicar só se der erro).

## 8. Interface
- No sistema o endereço nunca muda. Exceções: `/version` (`/novidades`, `/versao`, `/release`, `/releases`), `/duvidas` (`/duvida`, `/manual`), `/duvidasdev` (`/duvidas-dev`, só admin) e `/partner` (registro da API, só admin).
- Páginas só de admin: casca em `public/`, dados só por rota de API `'admin'` (a Vercel serve `public/` sem conferir login).
- `/duvidasdev` = documentação técnica. Casca em `public/duvidasdev.html`; texto em `server/paginas/duvidasdev.html`, servido só por `GET /api/dev/documentacao` (admin). **Mudou arquitetura, API, segurança, banco ou publicação → atualizar esse texto.** A lista de APIs sai da tabela `routes` (5º campo = descrição).
- Vidro fosco + fundo de formas suaves; Sora / Figtree; modos claro e escuro; usar variáveis de `app.css`.
- Celular < 900 px: barra de abas embaixo + gaveta "Mais". Desktop: menu lateral recolhível ou no topo (escolha em Configurações, `gt_menu_posicao` no navegador).
- Janelas via `openDialog()` (X, clique fora, Esc). Respeitar `prefers-reduced-motion`.
- Tela nova no menu: acrescentar o formato do esqueleto de carregamento em `SKELETON` (`app.js`). As telas montam só no elemento que recebem (`go()` monta fora da vista e troca de uma vez).

## 9. Negócio (resumo; detalhes em DECISOES)
- Admin: tudo (métricas, usuários, excluir item, itens removidos). Gestor: operação; solicita usuário.
- Login: senha + TOTP. Senha: 5 erros → 15 min. Código: 10 s / 100 s / 1000 s, 4º erro bloqueia até admin liberar.
- Sessão: 45 min sem uso, "Manter ativo" opcional; novo login no mesmo navegador derruba o anterior.
- Movimentações (entrada/saída/contagem) não se editam; contagem = saldo contado; saldo nunca negativo.
- Excluir item: copia para `removed_items`, `removed_items_purchases`, `removed_items_history` e apaga (transação). Removidos: só admin. Histórico de compras: todos.
- Planilhas: SKU é a chave, conferência antes de gravar, movimentação repetida ignorada.
- Previsão: fatura mensal; comprar = consumo + folga − estoque inicial, arredondado ao lote. Estimativa manual substitui o automático.
- Alerta de estoque mínimo: ao entrar e a cada 3 h.
