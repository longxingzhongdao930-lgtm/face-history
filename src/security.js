/**
 * インターネットに公開する際の基本的な防御。
 */

// 顔認識モデルは同一オリジンから読み込み、カメラ映像は blob / mediastream で扱う
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** セキュリティ関連のレスポンスヘッダー */
export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}

/**
 * IP ごとの回数制限（固定ウィンドウ）。認証など誰でも呼べる API の連打・総当たりを防ぐ。
 * @param {{ windowMs: number, max: number, message: string, now?: () => number }} options
 */
export function rateLimit({ windowMs, max, message, now = () => Date.now() }) {
  /** @type {Map<string, { count: number, reset: number }>} */
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) {
      for (const [key, h] of hits) if (h.reset <= t) hits.delete(key);
    }
    const key = req.ip ?? 'unknown';
    let h = hits.get(key);
    if (!h || h.reset <= t) {
      h = { count: 0, reset: t + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
