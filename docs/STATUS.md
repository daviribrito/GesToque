# Status do projeto

Atualizado em 2026-10-22. Atualize ao terminar cada tarefa importante.

**Índice:** 1. Onde parou · 2. Próxima tarefa · 3. Validar antes de continuar · 4. Concluído · 5. Pendente · 6. Bugs e riscos

## 1. Onde parou
- 2026-10-22: GesToque nasceu como cópia do sistema de gestão de estoque (versão 0.1.3), sem a identidade da marca anterior.
- Trocado: nome, textos, logo (caixa isométrica), mascote (caixa com rosto: parada, chegando e assustada, em SVG), fundo (formas suaves + grade de pontos),
  paleta verde-azulada, fonte de título Sora, schema `gestoque`, papel `gestoque_leitura`, chaves `gt_*` no navegador, variáveis `GT_*`, cabeçalho `X-GT`,
  app Android `com.gestoque.app` com ícones e abertura novos. Feriados locais saíram (ficaram os nacionais e o Carnaval).
- Ainda **sem** Supabase, Vercel e repositório no GitHub próprios. Roda só com o banco local (PGlite em `data/`).

## 2. Próxima tarefa
1. Criar os projetos do Supabase (produção e dev) e preencher o `.env` a partir do `.env.example`.
2. Criar o repositório no GitHub e o projeto na Vercel (`DATABASE_URL` e `DATABASE_URL_Dev`, sempre pelo pooler).
3. Cadastrar `APP_URL` no GitHub para gerar o APK.

## 3. Validar antes de continuar
- Login, telas e modos claro/escuro com a nova identidade, no computador e no celular.
- /duvidas, /version, /duvidasdev e /partner com o novo logo.

## 4. Concluído
Tudo o que existia na versão 0.1.3 do sistema original: login com senha + TOTP, perfis admin/gestor, estoque, movimentações, planilhas,
estimativa de uso, previsão em faturas, histórico de compras, itens removidos, consulta SQL, registro da API, /duvidas e /duvidasdev, app Android.

## 5. Pendente
- Restaurar item removido.
- Chave fixa do APK (segredo no GitHub); pré-requisito da Play Store.
- Feriados estaduais/municipais, se a loja precisar (em `server/forecast.js`, `holidaysOf`).

## 6. Bugs e riscos
- **APK:** cada build usa chave de depuração nova; não instala por cima do anterior.
- **Exportar no app Android:** provável falha de download no WebView; não testado em celular.
- **TOTP em texto puro** em `users.totp_secret`; exportações SQL carregam os segredos.
- **Sem testes automatizados** no repositório (só scripts avulsos contra servidor local com PGlite).
