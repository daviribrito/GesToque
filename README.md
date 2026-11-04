# GesToque — gestão de estoque

Sistema de estoque e previsão de compras da loja. Node (sem framework) no servidor, Postgres do Supabase como banco e uma página única em JavaScript puro: a navegação nunca muda o endereço do navegador.

**Demonstração:** https://daviribrito.github.io/GesToque/ (roda inteira no navegador; veja [Demonstração](#demonstração)).

## O que tem

- **Estoque**: itens com SKU, categoria, unidade, mínimo, custo, lote de compra, prazo de entrega e fornecedor. Mostra uso por dia e quantos dias o saldo dura.
- **Movimentações**: entrada, saída e contagem (ajuste), sempre com saldo e autor.
- **Importar e exportar**: Excel (.xlsx) e CSV, tanto da carga de estoque quanto das movimentações (saídas, entradas e contagens, com filtro de tipo e período). A importação usa o SKU como chave e confere a planilha antes de gravar. Na carga de estoque, diferenças de quantidade viram contagens. Nas movimentações, linhas que já existem são ignoradas, e dá para carregar só o histórico sem mexer no saldo.
- **Estimativa de uso**: ritmo de cada dia da semana e de feriado por item, com as próximas 8 semanas e ajuste manual por período.
- **Previsão de compra**: uma fatura por mês, como fatura de cartão. Meses passados mostram o que foi comprado; o mês atual fica aberto; os próximos são previstos pelo uso.
- **Histórico de compras**: cada entrada com o preço pago e o fornecedor daquele dia, a variação sobre a compra anterior do item e, por item, último preço, menor, maior e média. Mudar o custo no cadastro não altera o histórico.
- **Métricas** (admin): janela de análise, dias de segurança, crescimento por mês, meses à frente e peso de cada mês do ano.
- **Usuários** (admin): perfis admin e gestor. Login só com usuário e senha, mais código de app autenticador (TOTP) obrigatório.

### Como a fatura é calculada

1. Pelas saídas da janela de análise, o sistema aprende quanto sai em cada dia da semana e em feriado (nacionais e Carnaval). Sem feriado no histórico, feriado conta como a média de sábado e domingo.
2. Consumo do mês = soma do uso previsto de cada dia × peso do mês × crescimento acumulado. Em **Estimativa de uso** o gestor pode informar a quantidade de um período (segunda a sexta ou fim de semana); ela substitui o automático, e a tela mostra os dois valores.
3. Comprar = consumo + folga (o maior entre dias de segurança e estoque mínimo) − estoque no início do mês.
4. O valor sobe para o próximo múltiplo do lote de compra e é multiplicado pelo custo.

## Organização das pastas

```
api/            entrada do sistema na Vercel (função)
server/         servidor: rotas, login e 2FA, estoque, previsão, banco
public/         telas: HTML, CSS, JavaScript e imagens servidos ao navegador
scripts/        comandos de terminal: criar admin, carregar dados de exemplo, gerar a demonstração
demo/           demonstração no navegador: troca o banco, o login e o fetch para rodar sem servidor
mobile/         app Android (Capacitor) e o que gera o APK
.github/        automação do GitHub (gera o APK e publica a demonstração no GitHub Pages)
*.cmd           atalhos para Windows: iniciar, configurar-admin, carregar-exemplo
```

Só no computador, fora do Git: `.env` (senhas), `data/` (banco local, exportações, APKs baixados, backups), `.tools/` (Node, Git e gh portáteis), `demo-site/` (demonstração gerada) e `node_modules/`. O `.env.example` fica no Git de propósito: só tem os nomes das variáveis, sem valores reais.

## Ambientes

| | Produção | Teste |
|---|---|---|
| Branch | `main` | `Dev` |
| Site | gestoque.vercel.app | deploy de Preview do `Dev` |
| Banco | Supabase `SEU-PROJETO` (`DATABASE_URL`) | Supabase `SEU-PROJETO-DEV` (`DATABASE_URL_Dev` na Vercel) |

Os projetos do Supabase e da Vercel ainda não foram criados: troque `SEU-PROJETO` e `SEU-PROJETO-DEV` pelos identificadores reais.

O computador usa o banco de dev pelo `.env`. Fora da produção a tela mostra o selo "Ambiente de teste". O Preview nunca usa o banco de produção.

## Novidades e versões

A página pública `/novidades` (também em `/versao`, `/version`, `/release` e `/releases`) mostra o que o sistema faz e o que mudou em cada versão, sem precisar de login. O conteúdo vem de `server/novidades.json`: a cada versão nova, acrescente um bloco no topo da lista `releases` e suba o `version` do `package.json`. O selo de versão em Configurações abre essa página.

## Rodar

O projeto usa Node e Git portáteis na pasta `.tools/` (fora do Git). Em outra máquina, instale o Node 22+ ou copie a pasta.

1. Copie `.env.example` para `.env` e troque `[YOUR-PASSWORD]` pela senha do banco do Supabase.
2. `configurar-admin.cmd` cria o primeiro admin.
3. `iniciar.cmd` abre o sistema em http://localhost:3500.

Sem `DATABASE_URL` válido o sistema usa um Postgres local em `data/` (PGlite), só para testes. `carregar-exemplo.cmd` enche esse banco local com itens de exemplo.

No Supabase as tabelas ficam no schema `gestoque`, criado sozinho na primeira execução, com RLS ligado e sem políticas: só o servidor acessa.

## Publicar na Vercel

O projeto já vem pronto para a Vercel: `api/index.js` atende o sistema como função, a pasta `public/` vira arquivos estáticos e `vercel.json` liga as duas coisas (região `pdx1`, Oregon, a mesma do Supabase).

1. Em vercel.com, **Add New > Project**, importe o repositório `daviribrito/gestoque`. Preset: **Other**. Não precisa de comando de build.
2. Em **Environment Variables**, cadastre `DATABASE_URL` com a URL do **pooler** do Supabase (a Vercel não tem IPv6, então a conexão direta `db.<projeto>.supabase.co` não funciona lá):
   `postgresql://postgres.SEU-PROJETO:SENHA@aws-1-us-west-2.pooler.supabase.com:6543/postgres`
3. Faça o deploy. Cada `git push` na `main` publica uma versão nova.

Os usuários são os mesmos do Supabase: quem foi criado com `configurar-admin.cmd` entra também pela Vercel.

## Demonstração

Uma versão do sistema que roda inteira no navegador, sem servidor nem banco na nuvem, publicada no GitHub Pages (`.github/workflows/demo-pages.yml`, a cada push na `main`).

- **Mesmo código:** as rotas e a lógica de `server/` (estoque, previsão, planilhas, Consulta SQL, registro da API) são empacotadas em `js/demo.js` pelo `scripts/build-demo.js` (esbuild). O `fetch` das páginas para `/api/...` é respondido ali mesmo (`demo/navegador.js`).
- **Banco:** o mesmo Postgres, via PGlite (WebAssembly), guardado no IndexedDB do navegador do visitante. Começa com o estoque de exemplo (`scripts/exemplo-dados.js`).
- **Login de exemplo:** qualquer usuário e senha entram; o 2FA é um código fixo, mostrado num alerta e preenchido sozinho. Com o usuário `gestor` entra como gestor. Um aviso explica isso a cada entrada.
- **Isolada do sistema real:** só `demo/` troca o login, o banco e as fotos. O servidor de verdade continua com scrypt, TOTP e sessões no servidor.

Para gerar e testar no computador: `npm run demo:build` e `npm run demo:servir` (abre em http://localhost:3600/GesToque/).

## Segurança

- Senhas com scrypt; sessão em cookie `HttpOnly` e `SameSite=Strict`; 5 erros seguidos bloqueiam o login por 15 minutos.
- A sessão termina após 45 minutos sem uso. Em Configurações, cada usuário pode ligar "Manter ativo" para ficar conectado até sair. Um novo login do mesmo usuário no mesmo navegador encerra a sessão anterior.
- O segundo fator é obrigatório: no primeiro login o sistema mostra o QR code. Celular perdido: um admin marca "Refazer o cadastro do autenticador"; se for o único admin, rode `configurar-admin.cmd` com o mesmo usuário.
- Em produção use https e `NODE_ENV=production`.
