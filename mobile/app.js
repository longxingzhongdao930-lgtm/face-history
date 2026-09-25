// Face History（スマホ版）: サーバー不要。顔認識・照合・保存をすべて端末内で行う。
import * as faceapi from './vendor/face-api.esm.js';
import { parseBackup } from './shared/backup-format.js';
import { ACTIONS, ChallengeTracker, LIVENESS, faceMetrics, randomActions } from './shared/liveness.js';
import { euclideanDistance, findBestMatch } from './shared/matcher.js';
import * as db from './db.js';

const REGISTER_SAMPLES = 3;
const MAX_SAMPLES = 10;
const SAMPLE_INTERVAL_MS = 500;
const LIVE_INTERVAL_MS = 250;
const LIVENESS_FRAME_MS = 70;
const LIVENESS_TIMEOUT_MS = 25_000;
/** 動作中の顔と最終的に使う顔が同一人物とみなす距離 */
const LIVENESS_CONSISTENCY = 0.6;
const HISTORY_PAGE = 30;

const $ = (sel) => document.querySelector(sel);
const els = {
  modelStatus: $('#model-status'),
  video: $('#video'),
  overlay: $('#overlay'),
  cameraStart: $('#camera-start'),
  indicator: $('#face-indicator'),
  challengePrompt: $('#challenge-prompt'),
  challengeStep: $('#challenge-step'),
  challengeText: $('#challenge-text'),
  challengeTimer: $('#challenge-timer'),
  authButton: $('#auth-button'),
  authHint: $('#auth-hint'),
  authResult: $('#auth-result'),
  registerName: $('#register-name'),
  registerButton: $('#register-button'),
  registerResult: $('#register-result'),
  historyType: $('#history-type'),
  historyResult: $('#history-result'),
  historySummary: $('#history-summary'),
  historyList: $('#history-list'),
  historyMore: $('#history-more'),
  userList: $('#user-list'),
  settingNames: $('#setting-names'),
  settingLiveness: $('#setting-liveness'),
  settingThreshold: $('#setting-threshold'),
  settingThresholdValue: $('#setting-threshold-value'),
  backupExport: $('#backup-export'),
  backupImport: $('#backup-import'),
  backupUndo: $('#backup-undo'),
  backupResult: $('#backup-result'),
  historyClear: $('#history-clear'),
  deleteAll: $('#delete-all'),
  toast: $('#toast'),
};

const state = {
  modelsReady: false,
  stream: null,
  liveTimer: null,
  busy: false,
  tab: 'auth',
  users: [],
  historyShown: HISTORY_PAGE,
};

// ---------------------------------------------------------------- 設定（端末に保存）

const settings = {
  get names() { return load('names', true); },
  set names(v) { save('names', v); },
  get liveness() { return load('liveness', true); },
  set liveness(v) { save('liveness', v); },
  get threshold() { return load('threshold', 0.5); },
  set threshold(v) { save('threshold', v); },
};
function load(key, fallback) {
  try {
    const v = localStorage.getItem(`fh:${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`fh:${key}`, JSON.stringify(value));
  } catch {
    /* プライベートブラウズ等では保存できない */
  }
}

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 次の描画まで待ち、さらに残り時間があれば待つ（遅い端末でも画面が固まらないように） */
async function nextPaint(minWaitMs = 0) {
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  if (minWaitMs > 0) await sleep(minWaitMs);
}
const formatDate = (iso) => new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}

function el(tag, { dataset, ...props } = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function showResult(target, kind, title, meta) {
  target.hidden = false;
  target.className = `result ${kind}`;
  target.replaceChildren(el('strong', { textContent: title }));
  if (meta) target.append(el('div', { className: 'meta', textContent: meta }));
}

function updateButtons() {
  const ready = state.modelsReady && !!state.stream && !state.busy;
  els.authButton.disabled = !ready;
  els.registerButton.disabled = !ready;
  document.querySelectorAll('[data-action="add-samples"]').forEach((b) => { b.disabled = !ready; });
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  try {
    return await fn();
  } finally {
    state.busy = false;
    updateButtons();
  }
}

// ---------------------------------------------------------------- face-api

const detectorOptions = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
const liveOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

async function loadModels() {
  try {
    const webgl = await faceapi.tf.setBackend('webgl').catch(() => false);
    if (!webgl) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri('models'),
      faceapi.nets.tinyFaceDetector.loadFromUri('models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('models'),
    ]);
    state.modelsReady = true;
    els.modelStatus.textContent = '準備完了';
    els.modelStatus.className = 'pill ok';
  } catch (err) {
    console.error(err);
    els.modelStatus.textContent = '読み込み失敗';
    els.modelStatus.className = 'pill error';
    toast(`顔認識モデルを読み込めませんでした: ${err.message}`);
  }
  updateButtons();
}

async function extractFace(input, options = detectorOptions()) {
  const results = await faceapi.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors();
  if (results.length === 0) throw new Error('顔が検出できませんでした。明るい場所で正面を向いてください。');
  if (results.length > 1) throw new Error(`${results.length} 人の顔が検出されました。1 人だけ映るようにしてください。`);
  const [r] = results;
  return { descriptor: Array.from(r.descriptor), box: r.detection.box };
}

/** 顔周辺を切り出して小さな JPEG（base64）にする */
function makeSnapshot(video, box, size = 160) {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const margin = Math.max(box.width, box.height) * 0.35;
  const side = Math.min(Math.max(box.width, box.height) + margin * 2, srcW, srcH);
  const sx = Math.min(Math.max(box.x + box.width / 2 - side / 2, 0), srcW - side);
  const sy = Math.min(Math.max(box.y + box.height / 2 - side / 2, 0), srcH - side);
  const canvas = el('canvas', { width: size, height: size });
  canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

// ---------------------------------------------------------------- camera

let cameraStarting = false;
async function startCamera() {
  // 自動起動とボタン操作が重なっても 1 回だけ起動する
  if (state.stream || cameraStarting) return;
  cameraStarting = true;
  try {
    await openCamera();
  } finally {
    cameraStarting = false;
  }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('このブラウザではカメラを利用できません');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    els.cameraStart.hidden = false;
    toast(`カメラを起動できません: ${err.message}`);
    return;
  }
  els.video.srcObject = state.stream;
  await els.video.play().catch(() => {});
  els.cameraStart.hidden = true;
  els.indicator.hidden = false;
  startLiveDetection();
  updateButtons();
}

function setIndicator(text, kind = '') {
  els.indicator.textContent = text;
  els.indicator.className = `face-indicator ${kind}`;
}

async function detectLive(video) {
  if (!settings.names || state.users.length === 0) {
    const detections = await faceapi.detectAllFaces(video, liveOptions());
    return { boxes: detections.map((d) => d.box), labels: [] };
  }
  const faces = await faceapi.detectAllFaces(video, liveOptions()).withFaceLandmarks().withFaceDescriptors();
  const labels = faces.map((f) => {
    const m = findBestMatch(Array.from(f.descriptor), state.users, settings.threshold);
    return { text: m.matched ? m.user.name : '未登録', known: m.matched };
  });
  return { boxes: faces.map((f) => f.detection.box), labels };
}

function startLiveDetection() {
  const tick = async () => {
    if (!state.stream) return;
    const video = els.video;
    if (state.modelsReady && !state.busy && video.readyState >= 2 && video.videoWidth) {
      try {
        const { boxes, labels } = await detectLive(video);
        if (!state.busy) {
          drawOverlay(boxes, labels);
          const names = labels.filter((l) => l.known).map((l) => l.text);
          if (names.length) setIndicator(`${names.join('、')} さん`, 'ok');
          else if (boxes.length === 1) setIndicator(labels.length ? '未登録の顔です' : '顔を検出中', labels.length ? 'warn' : 'ok');
          else if (boxes.length > 1) setIndicator(`${boxes.length} 人検出`, 'warn');
          else setIndicator('顔が見つかりません', 'warn');
        }
      } catch (err) {
        console.warn(err);
      }
    }
    if (state.stream) state.liveTimer = setTimeout(tick, LIVE_INTERVAL_MS);
  };
  tick();
}

/** 顔の枠（と名前）を描く。映像は左右反転表示なので、文字は反転し直して描く */
function drawOverlay(items, labels = []) {
  const { overlay, video } = els;
  const W = (overlay.width = video.videoWidth);
  overlay.height = video.videoHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, W, overlay.height);
  const line = Math.max(3, W / 160);
  const boxes = items.map((d) => d.box ?? d);

  boxes.forEach(({ x, y, width, height }, i) => {
    const label = labels[i];
    const color = label ? (label.known ? '#4fd1a1' : '#ffb454') : boxes.length === 1 ? '#4fd1a1' : '#ff7b70';
    ctx.lineWidth = line;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, width, height);
    if (!label) return;

    const fontSize = Math.max(16, Math.round(W / 20));
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    const text = label.known ? `${label.text} さん` : label.text;
    const padX = fontSize * 0.4;
    const w = ctx.measureText(text).width + padX * 2;
    const h = fontSize * 1.5;
    const left = W - x - width;
    const top = y - h - line > 0 ? y - h - line : y + height + line;
    ctx.fillStyle = color;
    ctx.fillRect(left - line / 2, top, w, h);
    ctx.fillStyle = '#0b1020';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left - line / 2 + padX, top + h / 2);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- liveness

const round1 = (v) => Math.round(v * 10) / 10;

function showPrompt(step, text, remainingMs) {
  els.challengePrompt.hidden = false;
  els.challengeStep.textContent = step;
  els.challengeText.textContent = text;
  els.challengeTimer.style.transform = `scaleX(${Math.max(0, remainingMs / LIVENESS_TIMEOUT_MS)})`;
}

async function waitForFrontal(video, maxWaitMs) {
  const until = performance.now() + maxWaitMs;
  while (performance.now() < until) {
    const d = await faceapi.detectSingleFace(video, liveOptions()).withFaceLandmarks();
    if (d) {
      drawOverlay([d.detection]);
      const { yaw } = faceMetrics(d.landmarks.positions.map((p) => [p.x, p.y]));
      if (Math.abs(yaw) <= LIVENESS.frontalYaw) return;
    }
    await nextPaint(LIVENESS_FRAME_MS);
  }
}

/**
 * ライブネス検知（ランダムな動作の指示）を行ってから capture() で撮影する。
 * 動作が確認できなければ Error（reason: 'liveness'）を投げる。
 */
async function withLiveness(capture) {
  const video = els.video;
  if (!settings.liveness) {
    return capture((text) => showPrompt('撮影', text, 0)).finally(() => { els.challengePrompt.hidden = true; });
  }
  const actions = randomActions();
  const tracker = new ChallengeTracker(actions);
  const frames = [];
  const checkpoints = [];

  try {
    showPrompt('準備', 'カメラの正面を向いてください', LIVENESS_TIMEOUT_MS);
    await nextPaint();
    checkpoints.push((await extractFace(video)).descriptor);

    const start = performance.now();
    while (!tracker.done) {
      const elapsed = performance.now() - start;
      if (elapsed > LIVENESS_TIMEOUT_MS || frames.length >= LIVENESS.maxFrames) break;
      const step = tracker.calibrating ? '準備' : `${tracker.index + 1} / ${actions.length}`;
      const text = tracker.calibrating ? 'カメラの正面を向いてください' : ACTIONS[tracker.current];
      showPrompt(step, text, LIVENESS_TIMEOUT_MS - elapsed);

      const frameStart = performance.now();
      const detections = await faceapi.detectAllFaces(video, liveOptions()).withFaceLandmarks();
      drawOverlay(detections.map((d) => d.detection));
      if (detections.length > 1) throw new Error('複数の顔が検出されました。1 人だけ映るようにしてください。');
      if (detections.length === 1) {
        const points = detections[0].landmarks.positions.map((p) => [round1(p.x), round1(p.y)]);
        frames.push({ t: Math.round(frameStart - start), points });
        if (tracker.push(points, frames.length - 1)) {
          try {
            checkpoints.push((await extractFace(video, liveOptions())).descriptor);
          } catch {
            /* 横向き等で取れない場合は開始時の顔で判定 */
          }
        }
      }
      await nextPaint(LIVENESS_FRAME_MS - (performance.now() - frameStart));
    }

    if (!tracker.done) {
      const pending = tracker.calibrating ? 'カメラの正面を向く' : ACTIONS[tracker.current];
      throw Object.assign(new Error(`動作「${pending}」が確認できませんでした`), { reason: 'liveness' });
    }

    const prompt = (text) => showPrompt('撮影', text, 0);
    prompt('正面を向いたまま静止してください');
    await nextPaint();
    await waitForFrontal(video, 5000);
    const result = await capture(prompt);

    // 動作中に別の顔（写真など）へ差し替えていないか
    const faces = [].concat(result).map((r) => r.descriptor ?? r);
    if (checkpoints.some((c) => faces.some((d) => euclideanDistance(c, d) > LIVENESS_CONSISTENCY))) {
      throw Object.assign(new Error('動作中に別の顔が検出されました'), { reason: 'liveness' });
    }
    return result;
  } finally {
    els.challengePrompt.hidden = true;
  }
}

async function captureSamples(count, prompt) {
  const descriptors = [];
  for (let i = 0; i < count; i++) {
    prompt?.(`正面を向いたまま静止してください（撮影 ${i + 1} / ${count}）`);
    descriptors.push((await extractFace(els.video)).descriptor);
    if (i < count - 1) await sleep(SAMPLE_INTERVAL_MS);
  }
  return descriptors;
}

// ---------------------------------------------------------------- auth

els.authButton.addEventListener('click', () => withBusy(async () => {
  showResult(els.authResult, 'info', '認証中…', '画面の指示に従ってください');
  let face;
  try {
    face = await withLiveness(async () => {
      const f = await extractFace(els.video);
      return { ...f, snapshot: makeSnapshot(els.video, f.box) };
    });
  } catch (err) {
    if (err.reason === 'liveness') {
      await db.addHistory({ type: 'auth', result: 'failure', reason: 'liveness', liveness: 'failed', detail: err.message });
      showResult(els.authResult, 'failure', '認証失敗: ライブネス検知に失敗しました', err.message);
    } else {
      showResult(els.authResult, 'failure', err.message);
    }
    return;
  }

  const match = findBestMatch(face.descriptor, state.users, settings.threshold);
  const distance = match.distance == null ? null : Number(match.distance.toFixed(4));
  const liveness = settings.liveness ? 'passed' : 'skipped';
  const meta = `距離 ${distance ?? '—'}（しきい値 ${settings.threshold.toFixed(2)}）`;
  if (match.matched) {
    await db.addHistory(
      { type: 'auth', result: 'success', userId: match.user.id, userName: match.user.name, distance, liveness },
      face.snapshot,
    );
    showResult(els.authResult, 'success', `認証成功: ${match.user.name} さん`, meta);
  } else {
    await db.addHistory({ type: 'auth', result: 'failure', reason: 'no_match', distance, liveness }, face.snapshot);
    showResult(els.authResult, 'failure', '認証失敗: 登録済みの顔と一致しません', meta);
  }
}));

// ---------------------------------------------------------------- register

els.registerButton.addEventListener('click', () => withBusy(async () => {
  const name = els.registerName.value.trim();
  if (!name) {
    els.registerName.focus();
    showResult(els.registerResult, 'failure', '名前を入力してください');
    return;
  }
  if (state.users.some((u) => u.name === name)) {
    showResult(els.registerResult, 'failure', `「${name}」は既に登録されています`);
    return;
  }
  showResult(els.registerResult, 'info', '撮影中…', '画面の指示に従ってください');
  try {
    const descriptors = await withLiveness((prompt) => captureSamples(REGISTER_SAMPLES, prompt));
    for (const d of descriptors) {
      const m = findBestMatch(d, state.users, settings.threshold);
      if (m.matched) throw new Error(`この顔は「${m.user.name}」として既に登録されています`);
    }
    const user = await db.addUser({ name, descriptors });
    await db.addHistory({ type: 'register', result: 'success', userId: user.id, userName: name, liveness: settings.liveness ? 'passed' : 'skipped' });
    await refreshUsers();
    els.registerName.value = '';
    showResult(els.registerResult, 'success', `「${name}」を登録しました`, `サンプル数 ${descriptors.length}`);
  } catch (err) {
    if (err.reason === 'liveness') {
      await db.addHistory({ type: 'register', result: 'failure', userName: name, reason: 'liveness', liveness: 'failed', detail: err.message });
    }
    showResult(els.registerResult, 'failure', err.message);
  }
}));

// ---------------------------------------------------------------- users

async function refreshUsers() {
  state.users = await db.listUsers();
  if (state.users.length === 0) {
    els.userList.replaceChildren(el('li', { className: 'empty', textContent: 'まだ登録されていません（「登録」タブから追加）' }));
    return;
  }
  els.userList.replaceChildren(...state.users.map((u) => el('li', {}, [
    el('div', { className: 'grow' }, [
      el('div', { className: 'title', textContent: u.name }),
      el('div', { className: 'sub', textContent: `サンプル ${u.descriptors.length} 件・${formatDate(u.createdAt)}` }),
    ]),
    el('div', { className: 'actions' }, [
      el('button', { className: 'btn small', type: 'button', textContent: '追加撮影', dataset: { action: 'add-samples', id: u.id } }),
      el('button', { className: 'btn small danger', type: 'button', textContent: '削除', dataset: { action: 'delete-user', id: u.id } }),
    ]),
  ])));
  updateButtons();
}

els.userList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const user = state.users.find((u) => u.id === btn.dataset.id);
  if (!user) return;
  if (btn.dataset.action === 'delete-user') {
    if (!confirm(`「${user.name}」を削除しますか？（顔データは完全に削除されます）`)) return;
    withBusy(async () => {
      await db.deleteUser(user.id);
      await db.addHistory({ type: 'delete', result: 'success', userId: user.id, userName: user.name });
      await refreshUsers();
      toast(`「${user.name}」を削除しました`);
    });
  } else {
    // 精度向上のため本人の顔を追加で撮影する（他人の顔は追加できない）
    window.scrollTo({ top: 0, behavior: 'smooth' });
    withBusy(async () => {
      try {
        const descriptors = await withLiveness((prompt) => captureSamples(REGISTER_SAMPLES, prompt));
        for (const d of descriptors) {
          if (!findBestMatch(d, [user], settings.threshold).matched) {
            throw new Error(`「${user.name}」の登録済みの顔と一致しないため追加できません`);
          }
        }
        const updated = await db.addSamples(user.id, descriptors, MAX_SAMPLES);
        await db.addHistory({ type: 'samples', result: 'success', userId: user.id, userName: user.name });
        await refreshUsers();
        toast(`「${user.name}」の顔を追加しました（計 ${updated.descriptors.length} 件）`);
      } catch (err) {
        toast(err.message);
      }
    });
  }
});

// ---------------------------------------------------------------- history

const TYPE_LABEL = { auth: '認証', register: '登録', samples: 'サンプル追加', delete: '削除', backup: 'バックアップ', restore: '復元' };

function historyItem(h) {
  const thumb = h.snapshot
    ? el('img', { className: 'thumb', src: `data:image/jpeg;base64,${h.snapshot}`, alt: '' })
    : el('div', { className: 'thumb none', textContent: TYPE_LABEL[h.type] ?? '' });
  let title;
  let badge;
  if (h.reason === 'liveness') {
    title = h.type === 'auth' ? 'なりすまし疑い' : `${h.userName ?? ''}（${TYPE_LABEL[h.type]}・なりすまし疑い）`;
    badge = el('span', { className: 'badge failure', textContent: 'ライブネス失敗' });
  } else if (h.type === 'auth') {
    title = h.result === 'success' ? `${h.userName} さん` : '不明な人物';
    badge = el('span', { className: `badge ${h.result}`, textContent: h.result === 'success' ? '認証成功' : '認証失敗' });
  } else {
    title = h.userName ?? TYPE_LABEL[h.type] ?? h.type;
    badge = el('span', { className: 'badge neutral', textContent: TYPE_LABEL[h.type] ?? h.type });
  }
  const sub = [formatDate(h.timestamp)];
  if (h.distance != null) sub.push(`距離 ${h.distance}`);
  if (h.detail) sub.push(h.detail);
  return el('li', {}, [
    thumb,
    el('div', { className: 'grow' }, [el('div', { className: 'title', textContent: title }), el('div', { className: 'sub', textContent: sub.join('・') })]),
    badge,
  ]);
}

async function refreshHistory() {
  const items = await db.listHistory({ type: els.historyType.value || undefined, result: els.historyResult.value || undefined });
  els.historySummary.textContent = `全 ${items.length} 件`;
  const shown = items.slice(0, state.historyShown);
  els.historyList.replaceChildren(...(shown.length ? shown.map(historyItem) : [el('li', { className: 'empty', textContent: '履歴はありません' })]));
  els.historyMore.hidden = items.length <= state.historyShown;
}

els.historyType.addEventListener('change', () => { state.historyShown = HISTORY_PAGE; refreshHistory(); });
els.historyResult.addEventListener('change', () => { state.historyShown = HISTORY_PAGE; refreshHistory(); });
els.historyMore.addEventListener('click', () => { state.historyShown += HISTORY_PAGE; refreshHistory(); });

// ---------------------------------------------------------------- settings / backup

function initSettings() {
  els.settingNames.checked = settings.names;
  els.settingLiveness.checked = settings.liveness;
  els.settingThreshold.value = settings.threshold;
  els.settingThresholdValue.textContent = settings.threshold.toFixed(2);
  els.settingNames.addEventListener('change', () => { settings.names = els.settingNames.checked; });
  els.settingLiveness.addEventListener('change', () => {
    if (!els.settingLiveness.checked && !confirm('ライブネス検知をオフにすると、写真でも認証できてしまいます。オフにしますか？')) {
      els.settingLiveness.checked = true;
      return;
    }
    settings.liveness = els.settingLiveness.checked;
  });
  els.settingThreshold.addEventListener('input', () => {
    settings.threshold = Number(els.settingThreshold.value);
    els.settingThresholdValue.textContent = settings.threshold.toFixed(2);
  });
}

async function refreshBackupUndo() {
  els.backupUndo.hidden = !(await db.getPreRestore());
}

const backupFileName = () => `face-history-backup-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}.json`;

els.backupExport.addEventListener('click', async () => {
  const data = await db.exportData();
  const file = new File([JSON.stringify(data)], backupFileName(), { type: 'application/json' });
  // iPhone では共有シート（「ファイルに保存」・AirDrop など）で保存できる
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Face History バックアップ' });
      showResult(els.backupResult, 'success', 'バックアップを保存しました', `ユーザー ${data.users.length} 件・履歴 ${data.history.length} 件`);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  el('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showResult(els.backupResult, 'success', 'バックアップを保存しました', `ユーザー ${data.users.length} 件・履歴 ${data.history.length} 件`);
});

async function restoreFrom(data, mode) {
  const parsed = parseBackup(data, { maxSamples: MAX_SAMPLES });
  const result = await db.restoreData(parsed, { mode });
  await db.addHistory({
    type: 'restore',
    result: 'success',
    detail: `${mode === 'replace' ? '置き換え' : '追加'}: ユーザー ${result.users} 件・履歴 ${result.history} 件`,
  });
  await Promise.all([refreshUsers(), refreshBackupUndo()]);
  return result;
}

els.backupImport.addEventListener('change', async () => {
  const [file] = els.backupImport.files;
  els.backupImport.value = '';
  if (!file) return;
  const replace = confirm(
    `「${file.name}」から復元します。\n\nOK: 今のデータをすべて置き換える（「直前の復元を取り消す」で元に戻せます）\nキャンセル: 今のデータに追加する`,
  );
  try {
    const result = await restoreFrom(JSON.parse(await file.text()), replace ? 'replace' : 'merge');
    const meta = result.skippedUsers.length ? `重複のため追加しなかったユーザー: ${result.skippedUsers.join('、')}` : '';
    showResult(els.backupResult, 'success', `復元しました（ユーザー ${result.users} 件・履歴 ${result.history} 件）`, meta);
  } catch (err) {
    showResult(els.backupResult, 'failure', `復元できませんでした: ${err.message}`);
  }
});

els.backupUndo.addEventListener('click', async () => {
  const pre = await db.getPreRestore();
  if (!pre || !confirm('直前の復元を取り消して、復元前のデータに戻しますか？')) return;
  try {
    await restoreFrom(pre, 'replace');
    await db.clearPreRestore();
    await refreshBackupUndo();
    showResult(els.backupResult, 'success', '復元前のデータに戻しました');
  } catch (err) {
    showResult(els.backupResult, 'failure', `戻せませんでした: ${err.message}`);
  }
});

els.historyClear.addEventListener('click', async () => {
  if (!confirm('履歴をすべて削除しますか？')) return;
  await db.clearHistory();
  toast('履歴を削除しました');
});

els.deleteAll.addEventListener('click', async () => {
  if (!confirm('登録者・履歴を含むすべてのデータを削除しますか？この操作は取り消せません。')) return;
  await db.deleteAll();
  await Promise.all([refreshUsers(), refreshBackupUndo()]);
  toast('すべてのデータを削除しました');
});

// ---------------------------------------------------------------- tabs & init

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
  // 履歴・設定ではカメラを小さくして一覧を見やすくする
  document.body.classList.toggle('compact-camera', name === 'history' || name === 'settings');
  if (name === 'history') refreshHistory();
  if (name === 'settings') refreshBackupUndo();
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
els.cameraStart.addEventListener('click', () => startCamera());

initSettings();
refreshUsers();
loadModels();
// 保存したデータがブラウザに消されにくくする
navigator.storage?.persist?.().catch(() => {});
// オフラインでも開けるように（2 回目以降はモデルも端末から読み込む）
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
// カメラの許可が既にあれば自動で起動
navigator.permissions?.query({ name: 'camera' }).then((p) => { if (p.state === 'granted') startCamera(); }).catch(() => {});
