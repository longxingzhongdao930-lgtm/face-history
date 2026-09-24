/**
 * テスト用の合成 68 点ランドマーク。
 * EAR / MAR / yaw を狙った値にできるよう、必要な点だけを配置する。
 */
export function face({ ear = 0.3, mar = 0.05, yaw = 0 } = {}) {
  const p = Array.from({ length: 68 }, () => [50, 50]);
  // 顎の両端（幅 100）
  p[0] = [0, 50];
  p[16] = [100, 50];
  // 鼻先: yaw = (d0 - d16) / (d0 + d16) を満たす x（y は顎と同じ高さ）
  p[30] = [50 * (1 + yaw), 50];
  // 目: 幅 20、EAR = h / 10
  const h = ear * 10;
  for (const [i, x] of [[36, 20], [42, 60]]) {
    p[i] = [x, 40];
    p[i + 3] = [x + 20, 40];
    p[i + 1] = [x + 6, 40 - h];
    p[i + 2] = [x + 14, 40 - h];
    p[i + 4] = [x + 14, 40 + h];
    p[i + 5] = [x + 6, 40 + h];
  }
  // 口（内側）: 幅 30、MAR = 2v / 30
  const v = (mar * 30) / 2;
  p[60] = [35, 80];
  p[64] = [65, 80];
  p[62] = [50, 80 - v];
  p[66] = [50, 80 + v];
  return p;
}

/** 動作ごとの合成フレーム列（ニュートラル → 動作 → ニュートラル） */
export const ACTION_FRAMES = {
  blink: [face(), face({ ear: 0.12 }), face()],
  turn_left: [face(), face({ yaw: 0.4 }), face()],
  turn_right: [face(), face({ yaw: -0.4 }), face()],
  open_mouth: [face(), face({ mar: 0.6 }), face()],
};

export function framesFor(actions, { start = 0, step = 100 } = {}) {
  const points = [face(), face(), face(), ...actions.flatMap((a) => ACTION_FRAMES[a])];
  return points.map((pts, i) => ({ t: start + i * step, points: pts }));
}

export const vec = (v) => Array(128).fill(v);
