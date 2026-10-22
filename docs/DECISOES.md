# Decisões tomadas

Outubro de 2026. Acrescente novas no fim da seção correspondente.

**Índice:** 1. Stack · 2. Banco · 3. Hospedagem e ambientes · 4. Fluxo de trabalho · 5. App Android · 6. Versionamento · 7. Acesso e segurança · 8. Estoque e previsão · 9. Interface

## 1. Stack
- Node puro e SPA em JavaScript puro; poucas dependências (`pg`, `exceljs`, `qrcode`, `@electric-sql/pglite`). Mesmo padrão do projeto Bigode Shop.
- Node, Git e gh portáteis em `.tools/` (máquina sem nada instalado).

## 2. Banco
- Postgres no Supabase acessado direto pelo servidor (`pg`). Login próprio: o usuário quis usuário + senha, e o Supabase Auth exige e-mail.
- Schema `gestoque` com RLS sem políticas: dados fora da API pública do Supabase.
- PGlite como banco local, com o mesmo SQL.
- Migrações idempotentes no `SCHEMA` de `server/db.js`, só acrescentando.
- Tabelas em snake_case (`removed_items`, não `removedItems`).

## 3. Hospedagem e ambientes
- Vercel: `api/index.js` como função, `public/` estático, região `pdx1`; banco pelo pooler (Vercel sem IPv6).
- `main` = produção; `Dev` = teste (Preview + Supabase separado). Preview ignora `DATABASE_URL`.
- Selo "Ambiente de teste" fora da produção.

## 4. Fluxo de trabalho
- Commits no `Dev`; `main` só recebe o `Dev` quando o usuário pede (push na `main` publica).
- Sem troca de branch local para a `main` (evita apagar arquivos ignorados do disco).

## 5. App Android
- Capacitor abrindo o site publicado: reaproveita a interface e atualiza sem APK novo.
- APK gerado pelo GitHub Actions (sem Android Studio); endereço na variável `APP_URL` do repositório.

## 6. Versionamento
- SemVer a partir de 0.1.0. O usuário escolheu 0.1.1 para a leva seguinte (mesmo com funcionalidades novas), e 0.1.2 para a leva de 2026-10-18 (token da API, /duvidasdev, /partner, menu no topo, tarja em todas as páginas, "Voltar ao sistema" direto). As duas saem juntas na próxima publicação; /version mostra cada uma separada.
- Notas em `server/novidades.json`, exibidas em /version; manual em /duvidas.

## 7. Acesso e segurança
- Perfis admin (tudo) e gestor (operação). Gestor solicita usuário; admin aprova.
- Gestor tem a tela **Perfil** (só o próprio): nome, foto, usuário, perfil e data de cadastro. Ali ele muda **só o nome e a foto** (`PATCH /api/eu/nome` ignora outros campos); login (usuário) e perfil só o admin muda. Escolha do usuário em 2026-10-20: "nome" = o nome exibido, não o login. Admin continua com Usuários (sem Perfil no menu). Foto reduzida no navegador para 256×256 JPG (~3–10 KB).
- **Fotos no Supabase Storage** (pedido do usuário em 2026-10-20: "nada público, só vindo de dentro do sistema"): bucket privado `fotos-perfil`, RLS + política restritiva `fotos_perfil_fechado` para `anon`/`authenticated`. Sem link público nem assinado: o servidor (chave de serviço) busca e entrega pela API, só para quem está logado. Banco guarda caminho, tipo e versão. Tráfego mínimo: perfil não traz a imagem, só o endereço com `?u=<id>&v=<versão>`; o navegador guarda a foto 1 ano em cache privado e só baixa de novo quando a versão muda (o `u` separa o cache de cada pessoa no mesmo navegador — bug pego no teste). Servidor confere os bytes (JPG/PNG/WEBP). Banco local: `data/fotos/`. Registro da API: só inserir/trocar/remover; buscar a foto nunca (`NEVER_LOG`). Fotos fora da Consulta SQL. Pedido do usuário em 2026-10-20.
- 2FA obrigatório por app autenticador; esperas 10 s / 100 s / 1000 s e bloqueio permanente no 4º erro, liberado só por admin.
- Erros de espera (401 do código, 429) mandam `retry_in` (segundos) e `message_template` (`{tempo}`); a tela conta ao vivo na mensagem e no botão, que fica travado até zerar. Leitor de tela ouve a frase uma vez só. Pedido do usuário em 2026-10-18.
- Sessão de 45 min sem uso, "Manter ativo" por usuário; novo login no mesmo navegador encerra o anterior.
- API (lista em `docs/API.md`): toda rota "logado"/"admin", GET ou não, exige cookie de sessão completa (senha + código) **e** token de acesso em `Authorization: Bearer`. O token é `sha256('api:' + cookie)`: sai em `/api/entrar/codigo` e `/api/eu`, fica só na memória da tela, vale para todas as abas da sessão e morre ao sair. Ações (não-GET) exigem também `X-GT: 1` e origem do próprio site. Abertas só 5 rotas (login, código, sair, eu, novidades). Pedido do usuário em 2026-10-18.
- Documentação técnica em `/duvidasdev`, só admin (link em Configurações → Ajuda só para admin). O texto fica fora de `public/` (a Vercel serve `public/` direto, sem conferir login) e sai por rota de API de admin; a página pública é só casca. Lista de APIs gerada da tabela de rotas. Pedido do usuário em 2026-10-18.
- Limpeza do registro (90 dias) garantida pelo **pg_cron** do Supabase, ligado pela migração: `gestoque-limpar-api-logs` todo dia 06:30 UTC (03:30 em São Paulo) apaga o que tem mais de 90 dias; `gestoque-vacuum-api-logs` domingo 07:00 UTC faz `VACUUM (ANALYZE)`, deixando o espaço das linhas apagadas pronto para as novas (a tabela para de crescer; o arquivo não encolhe, o espaço é reaproveitado). Reserva no servidor (`logs.cleanup`, banco local ou falha do agendador): na 1ª gravação e no máximo a cada 6 h. Pedido do usuário em 2026-10-20.
- Registro da API em `gestoque.api_logs`, visto na tela `/partner` (só admin). Leve: só ações, exportações e erros (consultas que deram certo e o ping de uso não entram); 90 dias; JSON até 16 KB. Colunas `json` e não `jsonb`, para guardar os campos na ordem exata. Segredos viram `***`. Grava antes de responder (Vercel congela a função depois) e nunca derruba a chamada. O corpo do pedido passou a ser lido antes da conferência de acesso, para registrar também o que foi negado. Pedido do usuário em 2026-10-18.

## 8. Estoque e previsão
- Foco em estoque, compras e previsão; sem vendas.
- Previsão como fatura de cartão (uma por mês), calculada pelo uso.
- Uso por dia da semana e feriados (nacionais e Carnaval); estimativa manual por período substitui o automático e mostra o automático ao lado.
- Movimentações não se editam nem se apagam; correção por contagem.
- Excluir item não perde dados: vai para as tabelas de removidos. Só admin exclui e vê removidos; Histórico de compras dos itens ativos é de todos (correção do usuário em 2026-10-18).
- Alerta de estoque mínimo ao entrar e a cada 3 h.
- Item em pacote: `items.units_per_pack` (null = item comum). Saldo, mínimo, custo, movimentações e previsão continuam **em pacotes**; a tela mostra o equivalente em unidades. Diferente do "Lote de compra" (`pack_size`), que só arredonda a compra sugerida. Planilha: coluna "Unidades por pacote" (vazio = não muda; 0 = tira o pacote). Copiado em `removed_items`. Pedido do usuário em 2026-10-18.

## 8c. Consulta SQL (admin)
- Tela "Consulta SQL" no menu, só admin. Só leitura com a trava principal **no banco**: papel `gestoque_leitura` (NOLOGIN, só SELECT; `users` sem `pass_hash`/`totp_secret`; `sessions` fechada; política RLS `leitura_sql`). A conexão `postgres` do Supabase (não é superuser, tem CREATEROLE) recebe `SET` no papel com `INHERIT FALSE`. Por consulta: transação read only, `SET LOCAL ROLE`, 8 s, 1000 linhas; só SELECT/WITH/TABLE/VALUES, sem `;` no meio e sem funções que troquem papel ou rodem SQL por dentro. Pedido do usuário em 2026-10-18.
- Resultado da consulta é **volátil**: só vai para a tela. O Registro da API guarda quem, quando, o SQL e um resumo (linhas, colunas, tempo), nunca os dados (`ctx.logResponse` em `sql.run`). Resultados gravados antes disso foram limpos pela migração. Escolha do usuário em 2026-10-20 (auditoria do SQL sim, dados não). O histórico do navegador guarda só o texto das consultas.
- Nova tabela com dado sensível: **não** liberar ao papel. Nova tabela de operação: acrescentar na lista do bloco `do $$` do `SCHEMA` e em `TABLES` (`server/sql.js`).
- Mais forte, se um dia precisar: um usuário de login próprio (só leitura) e outra `DATABASE_URL` só para a consulta, sem `SET ROLE`.

## 8b. Desempenho
- Cada ida ao banco custa caro: ~147 ms do computador até o Supabase de dev; ~70 ms do Preview (Vercel em pdx1) até o dev em us-east-2. A produção (pdx1 + us-west-2) fica na mesma região. Regra: **consultas independentes em `Promise.all`**, nunca uma esperando a outra; escrita frequente em **um comando SQL só** (ex.: `createMovement`, com CTE e `for update`).
- Registro da API e renovação da sessão rodam junto com o pedido e terminam depois da resposta (`logs.afterReply`, com `waitUntil` na Vercel).
- Medido em 2026-10-18 com atraso simulado de 147 ms: abrir Estoque/Previsão/Estimativas 0,8–1,1 s → 0,34 s; lançar entrada/saída 1,1 s → 0,32 s.
- Na tela, o clique responde na hora. **Trocando de tela**: aparece o esqueleto dela (título e texto reais, quadros de vidro e barras vazias com brilho; formato por tela em `SKELETON`, `app.js`) e os dados entram com um fade curto. **Atualizando a mesma tela** (salvar, filtrar): só esmaece, sem esqueleto, para não piscar. Passando de 120 ms, barra fina no topo. A tela nova é montada fora da vista e só entra se ainda for a última pedida (cliques rápidos não se atropelam). Pedido do usuário em 2026-10-18.

## 9. Interface
- Navegação sem mudar o endereço; só as páginas de ajuda têm endereço próprio.
- **Aviso de versão nova**: ao entrar (ou recarregar logado), se a versão do servidor é diferente da última vista por aquela pessoa naquele navegador (`localStorage` `gt_versao_vista_<id>`), abre uma janela animada com as notas da versão (`server/novidades.json`, seções com `type` novo/melhoria/ajuste e selos coloridos). Aparece uma vez por versão; vem antes do alerta de estoque, que espera a janela fechar. Pedido do usuário em 2026-10-20. Para rever a qualquer momento: botão "Ver o aviso desta versão" em Configurações → Ajuda (escolha do usuário em 2026-10-21, em vez de versão de teste ou de mostrar sempre fora da produção).
- Barras de rolagem com a identidade do sistema: trilho transparente e pílula verde-azulada (forte no claro, clara no escuro) que acende ao passar o mouse; variáveis `--rolagem*` em `app.css`. Firefox usa `scrollbar-color`; no celular fica a barra do sistema operacional. Pedido do usuário em 2026-10-20.
- Listas suspensas (`select`) com o visual do sistema: `appearance: base-select` (painel de vidro, cores do tema, item escolhido na cor de ação, setinha que gira). Onde o navegador não tem esse recurso, fica a lista do sistema operacional. Pedido do usuário em 2026-10-20.
- Identidade GesToque (verde-azulado, grafite, branco, mascote caixa), vidro fosco, modo escuro.
- Ajuda (/duvidas e /version) em Configurações; "Voltar ao sistema" só para quem veio do sistema logado.
- "Voltar ao sistema" volta à origem (Configurações), não ao último clique: pula de uma vez os passos que a página somou ao histórico (ex.: índice de versões, que muda o `#`). Pedido do usuário em 2026-10-18.
- Menu do computador: na lateral (padrão) ou no topo, como cabeçalho (marca à esquerda, telas à direita). Escolha em Configurações → Menu, guardada no navegador (`gt_menu_posicao`), como o menu recolhido. O celular usa sempre a barra de baixo. Se os nomes não cabem, o cabeçalho mostra só os ícones (medido no `app.js`, porque admin e gestor têm quantidades diferentes de telas). Pedido do usuário em 2026-10-18.
- Tarja "Ambiente de teste" em todas as páginas fora da produção (sistema, /version, /duvidas e as futuras), por um script único `public/js/ambiente.js`. Não é injetada pelo servidor porque na Vercel as páginas de ajuda saem direto como arquivo, sem passar pelo Node. Produção: `VERCEL_ENV=production` → `producao` → sem tarja. Pedido do usuário em 2026-10-18.
