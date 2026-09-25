import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'fh_admin';

const sha256 = (value) => createHash('sha256').update(value).digest();

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) cookies[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

/**
 * 管理者ログイン（パスワード 1 つ + 署名付き Cookie のセッション）。
 * パスワード未設定なら無効で、全員が管理操作を行える（ローカル利用向け）。
 *
 * セッションはサーバー起動ごとに生成する鍵で署名するため、再起動するとログアウトされる。
 */
export class AdminAuth {
  constructor({
    password = '',
    sessionTtlMs = 8 * 60 * 60 * 1000,
    maxFailures = 5,
    lockoutMs = 15 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.enabled = password.length > 0;
    this.passwordHash = sha256(password);
    this.secret = randomBytes(32);
    this.sessionTtlMs = sessionTtlMs;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.now = now;
    /** @type {Map<string, { count: number, until: number }>} IP ごとのログイン失敗 */
    this.failures = new Map();
  }

  #sign(exp) {
    return createHmac('sha256', this.secret).update(String(exp)).digest('base64url');
  }

  isLoggedIn(req) {
    if (!this.enabled) return true;
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < this.now()) return false;
    const expected = Buffer.from(this.#sign(exp));
    const actual = Buffer.from(sig);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** @returns {{ ok: true } | { ok: false, locked: boolean }} */
  login(req, res, password) {
    const key = req.ip ?? 'unknown';
    const entry = this.failures.get(key);
    if (entry && entry.count >= this.maxFailures && entry.until > this.now()) {
      return { ok: false, locked: true };
    }
    const ok = typeof password === 'string' && timingSafeEqual(sha256(password), this.passwordHash);
    if (!ok) {
      if (this.failures.size > 10_000) this.#sweep();
      const count = entry && entry.until > this.now() ? entry.count + 1 : 1;
      this.failures.set(key, { count, until: this.now() + this.lockoutMs });
      return { ok: false, locked: false };
    }
    this.failures.delete(key);
    const exp = this.now() + this.sessionTtlMs;
    this.#setCookie(req, res, `${exp}.${this.#sign(exp)}`, Math.floor(this.sessionTtlMs / 1000));
    return { ok: true };
  }

  #sweep() {
    const now = this.now();
    for (const [key, e] of this.failures) {
      if (e.until <= now) this.failures.delete(key);
    }
  }

  logout(req, res) {
    this.#setCookie(req, res, '', 0);
  }

  #setCookie(req, res, value, maxAge) {
    const attrs = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (req.secure) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }
}
