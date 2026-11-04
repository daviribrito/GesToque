// Segurança da demonstração (no lugar de server/security.js, que usa o crypto do Node).
// Na demo não há segredo a proteger: senha e 2FA são de mentira e tudo fica neste navegador.
// Por isso o "hash" aqui não é hash de verdade. NUNCA usar isto no sistema real.

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const hashPassword = async (password) => `demo$${password}`;
const verifyPassword = async (password, stored) => stored === `demo$${password}`;

function checkPasswordRules(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new HttpError(400, 'A senha precisa ter pelo menos 10 caracteres.');
  }
  if (password.length > 200) throw new HttpError(400, 'A senha é longa demais.');
}

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
const hashToken = (token) => token;
const sameText = (a, b) => a === b;
const newTotpSecret = () => 'DEMO';
const totpAt = () => '123456';
const verifyTotp = () => null;
const totpUri = () => '';

module.exports = {
  HttpError,
  hashPassword,
  verifyPassword,
  checkPasswordRules,
  newToken,
  hashToken,
  sameText,
  newTotpSecret,
  totpAt,
  verifyTotp,
  totpUri,
};
