// Cria o admin, ou recupera o acesso de um admin existente (nova senha e novo cadastro do autenticador).
// Uso: configurar-admin.cmd. Com o banco local, feche o sistema antes de rodar.
const readline = require('readline');
const db = require('../server/db');
const sec = require('../server/security');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Não mostra a senha enquanto é digitada.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const env = process.env;
  const username = (env.GT_ADMIN_USER || (await ask('Usuário do admin: '))).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Use de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.');
  const name = env.GT_ADMIN_NAME || (await ask('Nome completo: ')) || username;
  const password = env.GT_ADMIN_PASS || (await ask('Senha (mínimo 10 caracteres): ', { hidden: true }));
  sec.checkPasswordRules(password);
  if (!env.GT_ADMIN_PASS && password !== (await ask('Repita a senha: ', { hidden: true }))) throw new Error('As senhas não são iguais.');

  await db.init();
  const hash = await sec.hashPassword(password);
  const existing = (await db.query('select id from gestoque.users where username = $1', [username])).rows[0];
  if (existing) {
    await db.query(
      `update gestoque.users set name = $2, pass_hash = $3, role = 'admin', active = true, totp_secret = null,
              totp_enabled = false, last_totp_step = 0, failed_logins = 0, locked_until = null,
              code_failures = 0, code_locked = false where id = $1`,
      [existing.id, name, hash]
    );
    await db.query('delete from gestoque.sessions where user_id = $1', [existing.id]);
    console.log(`\nAcesso de "${username}" redefinido. No próximo login o autenticador será cadastrado de novo.`);
  } else {
    await db.query("insert into gestoque.users (username, name, role, pass_hash) values ($1, $2, 'admin', $3)", [username, name, hash]);
    console.log(`\nAdmin "${username}" criado. No primeiro login o sistema mostra o QR code do autenticador.`);
  }
  await db.close();
}

main().catch((err) => {
  console.error('\nErro:', err.message);
  process.exit(1);
});
