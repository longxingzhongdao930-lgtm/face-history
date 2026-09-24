/**
 * ライブネス（生体）検知の共通ロジック。ブラウザとサーバーの両方から読み込む。
 *
 * face-api の 68 点ランドマーク（[x, y] の配列）から以下の指標を計算する。
 *   EAR (Eye Aspect Ratio)   目の開き具合。閉じると小さくなる
 *   MAR (Mouth Aspect Ratio) 口の開き具合。開けると大きくなる
 *   yaw                      顔の左右の向き。本人から見て左を向くと正、右を向くと負
 *
 * サーバーが発行したランダムな動作（チャレンジ）を、指示された順番どおりに
 * 実行できたかを判定する。写真や録画の再生では指示に追従できないため失敗する。
 */

export const ACTIONS = {
  blink: 'ゆっくりまばたきしてください',
  turn_left: '顔をゆっくり左に向けてください',
  turn_right: '顔をゆっくり右に向けてください',
  open_mouth: '口を大きく開けてください',
};

export const LIVENESS = {
  /** まばたき: 基準値に対してこの割合を下回ったら「閉じた」とみなす */
  eyeClosedRatio: 0.75,
  /** まばたき: 閉じた後、この割合まで戻ったら「開いた」とみなす */
  eyeOpenRatio: 0.9,
  /** 左右を向いたとみなす yaw の絶対値 */
  yawThreshold: 0.25,
  /** 正面とみなす yaw の絶対値（基準値の計測用） */
  frontalYaw: 0.12,
  /** 口を開けたとみなす MAR */
  mouthOpen: 0.4,
  /** 口を閉じているとみなす MAR */
  mouthClosed: 0.25,
  /** 基準値の計測に使う先頭フレーム数 */
  baselineFrames: 2,
  minFrames: 5,
  maxFrames: 400,
  actionsPerChallenge: 2,
};

const LANDMARK_COUNT = 68;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function eyeAspectRatio(p, i) {
  // i..i+5: 目の輪郭 6 点
  return (dist(p[i + 1], p[i + 5]) + dist(p[i + 2], p[i + 4])) / (2 * dist(p[i], p[i + 3]));
}

/** 68 点ランドマークから EAR / MAR / yaw を計算する */
export function faceMetrics(points) {
  const ear = (eyeAspectRatio(points, 36) + eyeAspectRatio(points, 42)) / 2;
  const mar = dist(points[62], points[66]) / dist(points[60], points[64]);
  // 鼻先(30)から左右の顎端(0: 画像左 / 16: 画像右)までの距離の差。
  // 本人が左を向くと鼻先は画像の右（16 側）に寄るため正になる。
  const toRight = dist(points[30], points[0]);
  const toLeft = dist(points[30], points[16]);
  const yaw = (toRight - toLeft) / (toRight + toLeft);
  return { ear, mar, yaw };
}

export function isValidLandmarks(points) {
  return (
    Array.isArray(points) &&
    points.length === LANDMARK_COUNT &&
    points.every(
      (p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)),
    )
  );
}

/** 重複しないランダムな動作列を作る */
export function randomActions(count = LIVENESS.actionsPerChallenge, random = Math.random) {
  const pool = Object.keys(ACTIONS);
  const picked = [];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return picked;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * フレームを 1 枚ずつ与えて、動作の達成状況を追跡する。
 * ブラウザでは画面表示に、サーバーでは検証に同じものを使う。
 */
export class ChallengeTracker {
  constructor(actions, config = LIVENESS) {
    this.actions = actions;
    this.config = config;
    this.index = 0;
    this.baseline = [];
    this.baselineEar = null;
    // 各動作は「ニュートラル → 動作」の遷移で判定する（最初から動作状態の写真では通らない）
    this.armed = false;
    this.eyesClosed = false;
    this.completedAt = [];
  }

  get done() {
    return this.index >= this.actions.length;
  }

  get current() {
    return this.actions[this.index] ?? null;
  }

  /** 基準値の計測中か（正面を向いて目を開けた状態を数フレーム集める） */
  get calibrating() {
    return this.baselineEar == null;
  }

  #isNeutral(action, m) {
    const c = this.config;
    switch (action) {
      case 'blink':
        return m.ear > this.baselineEar * c.eyeOpenRatio;
      case 'turn_left':
      case 'turn_right':
        return Math.abs(m.yaw) <= c.frontalYaw;
      case 'open_mouth':
        return m.mar < c.mouthClosed;
      default:
        return false;
    }
  }

  #isActive(action, m) {
    const c = this.config;
    switch (action) {
      case 'blink':
        return m.ear < this.baselineEar * c.eyeClosedRatio;
      case 'turn_left':
        return m.yaw > c.yawThreshold;
      case 'turn_right':
        return m.yaw < -c.yawThreshold;
      case 'open_mouth':
        return m.mar > c.mouthOpen;
      default:
        return false;
    }
  }

  /**
   * @param {number[][]} points 68 点ランドマーク
   * @param {number} frameIndex
   * @returns {string|null} このフレームで完了した動作
   */
  push(points, frameIndex) {
    const m = faceMetrics(points);
    const c = this.config;

    if (this.calibrating) {
      if (Math.abs(m.yaw) <= c.frontalYaw) this.baseline.push(m.ear);
      if (this.baseline.length >= c.baselineFrames) this.baselineEar = median(this.baseline);
      return null;
    }
    if (this.done) return null;

    const action = this.current;
    if (!this.armed) {
      if (this.#isNeutral(action, m)) this.armed = true;
      return null;
    }

    let completed = false;
    if (action === 'blink') {
      // 目を閉じて、再び開いたら完了
      if (!this.eyesClosed) this.eyesClosed = this.#isActive(action, m);
      else completed = this.#isNeutral(action, m);
    } else {
      completed = this.#isActive(action, m);
    }
    if (!completed) return null;

    this.completedAt.push(frameIndex);
    this.index += 1;
    this.armed = false;
    this.eyesClosed = false;
    return action;
  }
}

/**
 * 記録されたフレーム列がチャレンジを満たすか検証する（サーバー側で使用）。
 * @param {string[]} actions
 * @param {{ t: number, points: number[][] }[]} frames
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyFrames(actions, frames, config = LIVENESS) {
  if (!Array.isArray(frames) || frames.length < config.minFrames || frames.length > config.maxFrames) {
    return { ok: false, reason: `フレーム数が不正です（${config.minFrames}〜${config.maxFrames}）` };
  }
  let prevT = -Infinity;
  for (const f of frames) {
    if (!f || typeof f.t !== 'number' || !Number.isFinite(f.t) || f.t < prevT) {
      return { ok: false, reason: 'フレームの時刻が不正です' };
    }
    if (!isValidLandmarks(f.points)) {
      return { ok: false, reason: 'ランドマークの形式が不正です' };
    }
    prevT = f.t;
  }

  const tracker = new ChallengeTracker(actions, config);
  frames.forEach((f, i) => tracker.push(f.points, i));
  if (tracker.calibrating) return { ok: false, reason: '正面を向いた顔が確認できませんでした' };
  if (!tracker.done) {
    return { ok: false, reason: `動作「${ACTIONS[tracker.current]}」が確認できませんでした` };
  }
  return { ok: true };
}
