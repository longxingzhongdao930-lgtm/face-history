import { randomUUID } from 'node:crypto';
import { randomActions } from '../public/shared/liveness.js';

/**
 * ライブネス検知のチャレンジ（ランダムな動作指示）をメモリ上で管理する。
 * チャレンジは 1 回限り有効で、期限切れのものは破棄される。
 */
export class ChallengeStore {
  constructor({ ttlMs = 60_000, maxPending = 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.now = now;
    this.pending = new Map();
  }

  issue() {
    this.#sweep();
    if (this.pending.size >= this.maxPending) {
      // 最も古いものから捨てる（Map は挿入順）
      this.pending.delete(this.pending.keys().next().value);
    }
    const issuedAt = this.now();
    const challenge = {
      id: randomUUID(),
      actions: randomActions(),
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    this.pending.set(challenge.id, challenge);
    return challenge;
  }

  /** チャレンジを取り出して無効化する。存在しない・期限切れなら null */
  consume(id) {
    const challenge = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!challenge) return null;
    this.pending.delete(id);
    return challenge.expiresAt >= this.now() ? challenge : null;
  }

  #sweep() {
    const now = this.now();
    for (const [id, c] of this.pending) {
      if (c.expiresAt < now) this.pending.delete(id);
    }
  }
}
