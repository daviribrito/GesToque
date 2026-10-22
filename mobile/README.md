# GesToque — app Android

Aplicativo Android do sistema, feito com [Capacitor](https://capacitorjs.com). Ele abre o sistema publicado na Vercel dentro do app: mesmas telas, mesmo login com app autenticador e mesmo banco do Supabase. Tudo o que é publicado na `main` aparece no app sem gerar APK novo.

## Como sai o APK

O APK é gerado pelo GitHub Actions (`.github/workflows/android-apk.yml`), sem Android Studio no computador.

1. Uma vez só: em GitHub > **Settings > Secrets and variables > Actions > Variables**, crie `APP_URL` com o endereço da Vercel (ex.: `https://gestoque.vercel.app`).
2. A cada push no `Dev` ou na `main` que mexa em `mobile/`, o APK é gerado. Também dá para rodar à mão em **Actions > APK Android > Run workflow**.
3. Baixe o APK no fim da execução, em **Artifacts**, e instale no celular (o Android pede para permitir "instalar apps desta fonte").

O APK é de teste (assinado com chave de depuração). Para a Play Store será preciso uma chave própria de publicação.

## O que tem aqui

- `capacitor.config.json`: nome, identificador (`com.gestoque.app`) e o endereço que o app abre.
- `www/sem-conexao.html`: tela com a caixa assustada quando o celular está sem internet.
- `assets/`: ícone e tela de abertura de origem; `npm run icones` gera as versões do Android.
- `android/`: projeto Android gerado pelo Capacitor.

## Comandos (na pasta mobile, com o Node de `.tools`)

- `npm run endereco -- https://endereco.vercel.app`: troca o endereço que o app abre.
- `npm run icones`: refaz ícones e tela de abertura a partir de `assets/`.
- `npm run sync`: leva as mudanças para o projeto Android.
