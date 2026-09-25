export const DESCRIPTOR_LENGTH = 128;

export function isValidDescriptor(value) {
  return (
    Array.isArray(value) &&
    value.length === DESCRIPTOR_LENGTH &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * 登録済みユーザーの中から descriptor に最も近いユーザーを探す。
 * 各ユーザーは複数サンプルを持ち、その最小距離をユーザーの距離とする。
 * @returns {{ user: object|null, distance: number|null, matched: boolean }}
 */
export function findBestMatch(descriptor, users, threshold) {
  let best = null;
  let bestDistance = Infinity;
  for (const user of users) {
    for (const sample of user.descriptors) {
      const d = euclideanDistance(descriptor, sample);
      if (d < bestDistance) {
        bestDistance = d;
        best = user;
      }
    }
  }
  if (!best) return { user: null, distance: null, matched: false };
  return { user: best, distance: bestDistance, matched: bestDistance <= threshold };
}
