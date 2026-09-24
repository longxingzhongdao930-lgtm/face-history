import * as faceapi from '/vendor/face-api/face-api.esm.js';
import { ACTIONS, ChallengeTracker, LIVENESS, faceMetrics } from '/shared/liveness.js';

const REGISTER_SAMPLES = 3;
const SAMPLE_INTERVAL_MS = 600;
const LIVE_INTERVAL_MS = 250;
const HISTORY_PAGE = 30;
/** ライブネス検知のフレーム間隔（サーバーのフレーム数上限を超えないように間引く） */
const LIVENESS_FRAME_MS = 70;
const LIVENESS_TIMEOUT_MS = 25_000;

const $ = (sel) => document.querySelector(sel);
const els = {
  modelStatus: $('#model-status'),
  video: $('#video'),
  overlay: $('#overlay'),
  placeholder: $('#camera-placeholder'),
  cameraToggle: $('#camera-toggle'),
  faceIndicator: $('#face-indicator'),
  authCamera: $('#auth-camera'),
  authFile: $('#auth-file'),
  authFileLabel: $('#auth-file-label'),
  authHint: $('#auth-hint'),
  challengePrompt: $('#challenge-prompt'),
  challengeStep: $('#challenge-step'),
  challengeText: $('#challenge-text'),
  challengeTimer: $('#challenge-timer'),
  authResult: $('#auth-result'),
  registerName: $('#register-name'),
  registerCamera: $('#register-camera'),
  registerFile: $('#register-file'),
  registerResult: $('#register-result'),
  historyType: $('#history-type'),
  historyResult: $('#history-result'),
  historyClear: $('#history-clear'),
  historySummary: $('#history-summary'),
  historyList: $('#history-list'),
  historyMore: $('#history-more'),
  userList: $('#user-list'),
  toast: $('#toast'),
};

const state = {
  modelsReady: false,
  stream: null,
  liveTimer: null,
  busy: false,
  historyOffset: 0,
  config: { liveness: false },
};

// ---------------------------------------------------------------- utilities

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

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
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

function showResult(target, kind, title, meta) {
  target.hidden = false;
  target.className = `result ${kind}`;
  target.replaceChildren(el('strong', { textContent: title }));
  if (meta) target.append(el('div', { className: 'meta', textContent: meta }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 次の描画まで待ち、さらに残り時間があれば待つ */
async function nextPaint(minWaitMs = 0) {
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  if (minWaitMs > 0) await sleep(minWaitMs);
}

const formatDate = (iso) => new Date(iso).toLocaleString('ja-JP');

function updateButtons() {
  const camReady = state.modelsReady && !!state.stream && !state.busy;
  els.authCamera.disabled = !camReady;
  els.registerCamera.disabled = !camReady;
  for (const input of [els.authFile, els.registerFile]) {
    input.disabled = !state.modelsReady || state.busy;
  }
  document.querySelectorAll('[data-action="add-samples"]').forEach((b) => { b.disabled = !camReady; });
}

/** 処理中はボタンを無効化し、ライブ検出を止める */
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
    // WebGL が使えない環境（一部の VM・古い端末）では CPU にフォールバック
    const webgl = await faceapi.tf.setBackend('webgl').catch(() => false);
    if (!webgl) await faceapi.tf.setBackend('cpu');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]);
    state.modelsReady = true;
    els.modelStatus.textContent = `準備完了（${faceapi.tf.getBackend()}）`;
    els.modelStatus.className = 'pill ok';
  } catch (err) {
    console.error(err);
    els.modelStatus.textContent = 'モデル読み込み失敗';
    els.modelStatus.className = 'pill error';
    toast(`顔認識モデルを読み込めませんでした: ${err.message}`);
  }
  updateButtons();
}

/**
 * 入力（video / img）から顔を 1 つだけ抽出する。
 * @returns {{ descriptor: number[], box: faceapi.Box, score: number }}
 */
async function extractFace(input, options = detectorOptions()) {
  const results = await faceapi
    .detectAllFaces(input, options)
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (results.length === 0) throw new Error('顔が検出できませんでした。明るい場所で正面を向いてください。');
  if (results.length > 1) throw new Error(`${results.length} 人の顔が検出されました。1 人だけ映るようにしてください。`);
  const [r] = results;
  return { descriptor: Array.from(r.descriptor), box: r.detection.box, score: r.detection.score };
}

/** 顔周辺を切り出して小さな JPEG data URL にする（履歴用） */
function makeSnapshot(input, box, size = 160) {
  const srcW = input.videoWidth || input.naturalWidth || input.width;
  const srcH = input.videoHeight || input.naturalHeight || input.height;
  const margin = Math.max(box.width, box.height) * 0.35;
  const side = Math.min(Math.max(box.width, box.height) + margin * 2, srcW, srcH);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const sx = Math.min(Math.max(cx - side / 2, 0), srcW - side);
  const sy = Math.min(Math.max(cy - side / 2, 0), srcH - side);
  const canvas = el('canvas', { width: size, height: size });
  canvas.getContext('2d').drawImage(input, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // decode 済みなので描画に影響しない
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ---------------------------------------------------------------- camera

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('このブラウザではカメラを利用できません（HTTPS または localhost が必要です）');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    toast(`カメラを起動できません: ${err.message}`);
    return;
  }
  els.video.srcObject = state.stream;
  await els.video.play().catch(() => {});
  els.placeholder.hidden = true;
  els.cameraToggle.textContent = 'カメラを停止';
  startLiveDetection();
  updateButtons();
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  els.video.srcObject = null;
  clearTimeout(state.liveTimer);
  els.overlay.getContext('2d').clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.placeholder.hidden = false;
  els.cameraToggle.textContent = 'カメラを起動';
  setIndicator('—', '');
  updateButtons();
}

function setIndicator(text, kind) {
  els.faceIndicator.textContent = text;
  els.faceIndicator.className = `face-indicator ${kind}`;
}

function startLiveDetection() {
  const tick = async () => {
    if (!state.stream) return;
    const video = els.video;
    if (state.modelsReady && !state.busy && video.readyState >= 2 && video.videoWidth) {
      try {
        const detections = await faceapi.detectAllFaces(video, liveOptions());
        drawOverlay(detections);
        if (detections.length === 1) setIndicator('顔を検出中', 'ok');
        else if (detections.length > 1) setIndicator(`${detections.length} 人検出（1 人にしてください）`, 'warn');
        else setIndicator('顔が見つかりません', 'warn');
      } catch (err) {
        console.warn(err);
      }
    }
    if (state.stream) state.liveTimer = setTimeout(tick, LIVE_INTERVAL_MS);
  };
  tick();
}

function drawOverlay(detections) {
  const { overlay, video } = els;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.lineWidth = Math.max(2, overlay.width / 200);
  ctx.strokeStyle = detections.length === 1 ? '#4fd1a1' : '#ff7b70';
  for (const d of detections) {
    const { x, y, width, height } = d.box;
    ctx.strokeRect(x, y, width, height);
  }
}

// ---------------------------------------------------------------- auth

async function authenticate(input) {
  const face = await extractFace(input);
  const snapshot = makeSnapshot(input, face.box);
  return api('/auth', { method: 'POST', body: { descriptor: face.descriptor, snapshot } });
}

const round1 = (v) => Math.round(v * 10) / 10;

function showPrompt(step, text, remainingMs) {
  els.challengePrompt.hidden = false;
  els.challengeStep.textContent = step;
  els.challengeText.textContent = text;
  els.challengeTimer.style.transform = `scaleX(${Math.max(0, remainingMs / LIVENESS_TIMEOUT_MS)})`;
}

function hidePrompt() {
  els.challengePrompt.hidden = true;
}

/**
 * ライブネス検知付きの認証。
 * サーバーから受け取ったランダムな動作を指示し、ランドマークの推移を記録して送る。
 * サーバーは同じ判定ロジックで記録を再検証する。
 */
async function authenticateWithLiveness() {
  const video = els.video;
  const challenge = await api('/liveness/challenge', { method: 'POST' });
  const actions = challenge.actions.map((a) => a.id);
  const tracker = new ChallengeTracker(actions);
  const frames = [];
  const checkpoints = [];
  const timeout = Math.min(LIVENESS_TIMEOUT_MS, challenge.ttlMs - 5000);

  try {
    showPrompt('準備', 'カメラの正面を向いてください', timeout);
    await nextPaint();
    // 開始時点の顔（最終的に照合する顔と同一人物かをサーバーで確認する）
    checkpoints.push((await extractFace(video)).descriptor);

    const start = performance.now();
    while (!tracker.done) {
      const elapsed = performance.now() - start;
      // 時間切れでも記録はサーバーへ送り、失敗（なりすまし疑い）として履歴に残す
      if (elapsed > timeout || frames.length >= LIVENESS.maxFrames) break;
      const step = tracker.calibrating ? '準備' : `${tracker.index + 1} / ${actions.length}`;
      const text = tracker.calibrating ? 'カメラの正面を向いてください' : ACTIONS[tracker.current];
      showPrompt(step, text, timeout - elapsed);

      const frameStart = performance.now();
      const detections = await faceapi.detectAllFaces(video, liveOptions()).withFaceLandmarks();
      drawOverlay(detections.map((d) => d.detection));
      if (detections.length > 1) throw new Error('複数の顔が検出されました。1 人だけ映るようにしてください。');
      if (detections.length === 1) {
        const points = detections[0].landmarks.positions.map((p) => [round1(p.x), round1(p.y)]);
        frames.push({ t: Math.round(frameStart - start), points });
        const completed = tracker.push(points, frames.length - 1);
        if (completed) {
          // 動作直後の顔も記録（横向き等で取れない場合は開始時・最終の顔で判定）。
          // 遅い端末でも止まらないよう軽量な検出器を使う
          try {
            checkpoints.push((await extractFace(video, liveOptions())).descriptor);
          } catch {
            /* ignore */
          }
        }
      }
      // 処理が遅い端末でも毎フレーム描画の機会を与える（指示文・タイマーを更新するため）
      await nextPaint(LIVENESS_FRAME_MS - (performance.now() - frameStart));
    }

    showPrompt('照合', '正面を向いたまま静止してください', 0);
    await nextPaint();
    // 照合精度を上げるため、顔が正面に戻るまで待ってから撮影する
    if (tracker.done) await waitForFrontal(video, 5000);
    const face = await extractFace(video);
    const snapshot = makeSnapshot(video, face.box);
    return await api('/auth', {
      method: 'POST',
      body: { descriptor: face.descriptor, snapshot, liveness: { challengeId: challenge.id, frames, checkpoints } },
    });
  } finally {
    hidePrompt();
  }
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

function showAuthResult(res) {
  const meta = `距離 ${res.distance ?? '—'}（しきい値 ${res.threshold}）・${formatDate(new Date().toISOString())}`;
  if (res.result === 'success') {
    showResult(els.authResult, 'success', `認証成功: ${res.user.name} さん`, meta);
  } else if (res.reason === 'liveness') {
    showResult(els.authResult, 'failure', '認証失敗: ライブネス検知に失敗しました', `${res.detail ?? ''}・${meta}`);
  } else {
    showResult(els.authResult, 'failure', '認証失敗: 登録済みの顔と一致しません', meta);
  }
  refreshHistory();
}

els.authCamera.addEventListener('click', () => withBusy(async () => {
  showResult(els.authResult, 'info', '認証中…');
  try {
    const res = state.config.liveness ? await authenticateWithLiveness() : await authenticate(els.video);
    showAuthResult(res);
  } catch (err) {
    showResult(els.authResult, 'failure', err.message);
  }
}));

els.authFile.addEventListener('change', () => withBusy(async () => {
  const [file] = els.authFile.files;
  els.authFile.value = '';
  if (!file) return;
  showResult(els.authResult, 'info', '認証中…');
  try {
    showAuthResult(await authenticate(await loadImageFile(file)));
  } catch (err) {
    showResult(els.authResult, 'failure', err.message);
  }
}));

// ---------------------------------------------------------------- register

function registerName() {
  const name = els.registerName.value.trim();
  if (!name) {
    els.registerName.focus();
    throw new Error('名前を入力してください');
  }
  return name;
}

async function captureSamples(count, onProgress) {
  const descriptors = [];
  for (let i = 0; i < count; i++) {
    onProgress?.(i + 1, count);
    const face = await extractFace(els.video);
    descriptors.push(face.descriptor);
    if (i < count - 1) await sleep(SAMPLE_INTERVAL_MS);
  }
  return descriptors;
}

async function submitRegistration(name, descriptors) {
  const user = await api('/users', { method: 'POST', body: { name, descriptors } });
  showResult(els.registerResult, 'success', `「${user.name}」を登録しました`, `サンプル数 ${user.samples}`);
  els.registerName.value = '';
  refreshUsers();
  refreshHistory();
}

els.registerCamera.addEventListener('click', () => withBusy(async () => {
  try {
    const name = registerName();
    const descriptors = await captureSamples(REGISTER_SAMPLES, (i, n) => {
      showResult(els.registerResult, 'info', `撮影中… ${i} / ${n}`, '顔の角度を少しずつ変えてください');
    });
    await submitRegistration(name, descriptors);
  } catch (err) {
    showResult(els.registerResult, 'failure', err.message);
  }
}));

els.registerFile.addEventListener('change', () => withBusy(async () => {
  const files = [...els.registerFile.files];
  els.registerFile.value = '';
  if (files.length === 0) return;
  try {
    const name = registerName();
    const descriptors = [];
    for (const [i, file] of files.entries()) {
      showResult(els.registerResult, 'info', `解析中… ${i + 1} / ${files.length}`);
      try {
        descriptors.push((await extractFace(await loadImageFile(file))).descriptor);
      } catch (err) {
        throw new Error(`${file.name}: ${err.message}`);
      }
    }
    await submitRegistration(name, descriptors);
  } catch (err) {
    showResult(els.registerResult, 'failure', err.message);
  }
}));

// ---------------------------------------------------------------- users

async function refreshUsers() {
  let users;
  try {
    users = await api('/users');
  } catch (err) {
    toast(`ユーザー一覧を取得できません: ${err.message}`);
    return;
  }
  if (users.length === 0) {
    els.userList.replaceChildren(el('li', { className: 'empty', textContent: '登録ユーザーはいません' }));
    return;
  }
  els.userList.replaceChildren(...users.map((u) => el('li', {}, [
    el('div', { className: 'grow' }, [
      el('div', { className: 'title', textContent: u.name }),
      el('div', { className: 'sub', textContent: `サンプル ${u.samples} 件・登録 ${formatDate(u.createdAt)}` }),
    ]),
    el('button', { className: 'btn small', type: 'button', textContent: 'サンプル追加', dataset: { action: 'add-samples', id: u.id, name: u.name } }),
    el('button', { className: 'btn small danger', type: 'button', textContent: '削除', dataset: { action: 'delete-user', id: u.id, name: u.name } }),
  ])));
  updateButtons();
}

els.userList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, name } = btn.dataset;
  if (action === 'delete-user') {
    if (!confirm(`「${name}」を削除しますか？（顔データは完全に削除されます）`)) return;
    withBusy(async () => {
      try {
        await api(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast(`「${name}」を削除しました`);
        refreshUsers();
        refreshHistory();
      } catch (err) {
        toast(err.message);
      }
    });
  } else if (action === 'add-samples') {
    withBusy(async () => {
      try {
        toast('撮影中…カメラを見てください');
        const descriptors = await captureSamples(REGISTER_SAMPLES);
        const user = await api(`/users/${encodeURIComponent(id)}/samples`, { method: 'POST', body: { descriptors } });
        toast(`「${user.name}」のサンプルを追加しました（計 ${user.samples} 件）`);
        refreshUsers();
      } catch (err) {
        toast(err.message);
      }
    });
  }
});

// ---------------------------------------------------------------- history

const TYPE_LABEL = { auth: '認証', register: '登録', delete: '削除' };

function historyItem(h) {
  const thumb = h.hasSnapshot
    ? el('img', { className: 'thumb', src: `/api/history/${h.id}/snapshot`, alt: '', loading: 'lazy' })
    : el('div', { className: 'thumb none', textContent: TYPE_LABEL[h.type] ?? '' });

  let title;
  let badge;
  if (h.type === 'auth' && h.reason === 'liveness') {
    title = h.candidateName ? `${h.candidateName}（なりすまし疑い）` : '不明な人物（なりすまし疑い）';
    badge = el('span', { className: 'badge failure', textContent: 'ライブネス失敗' });
  } else if (h.type === 'auth') {
    title = h.result === 'success' ? h.userName : '不明な人物';
    badge = el('span', { className: `badge ${h.result}`, textContent: h.result === 'success' ? '認証成功' : '認証失敗' });
  } else {
    title = h.userName;
    badge = el('span', { className: 'badge neutral', textContent: TYPE_LABEL[h.type] ?? h.type });
  }
  const sub = [formatDate(h.timestamp)];
  if (h.distance != null) sub.push(`距離 ${h.distance}`);
  if (h.liveness === 'passed') sub.push('ライブネス OK');
  if (h.detail) sub.push(h.detail);

  return el('li', {}, [
    thumb,
    el('div', { className: 'grow' }, [
      el('div', { className: 'title', textContent: title }),
      el('div', { className: 'sub', textContent: sub.join('・') }),
    ]),
    badge,
  ]);
}

async function refreshHistory({ append = false } = {}) {
  const offset = append ? state.historyOffset : 0;
  const params = new URLSearchParams({ limit: HISTORY_PAGE, offset });
  if (els.historyType.value) params.set('type', els.historyType.value);
  if (els.historyResult.value) params.set('result', els.historyResult.value);

  let page;
  try {
    page = await api(`/history?${params}`);
  } catch (err) {
    toast(`履歴を取得できません: ${err.message}`);
    return;
  }
  const items = page.items.map(historyItem);
  if (append) els.historyList.append(...items);
  else if (items.length) els.historyList.replaceChildren(...items);
  else els.historyList.replaceChildren(el('li', { className: 'empty', textContent: '履歴はありません' }));

  state.historyOffset = offset + page.items.length;
  els.historySummary.textContent = `全 ${page.total} 件`;
  els.historyMore.hidden = state.historyOffset >= page.total;
}

els.historyType.addEventListener('change', () => refreshHistory());
els.historyResult.addEventListener('change', () => refreshHistory());
els.historyMore.addEventListener('click', () => refreshHistory({ append: true }));
els.historyClear.addEventListener('click', async () => {
  if (!confirm('履歴をすべて削除しますか？（スナップショットも削除されます）')) return;
  try {
    const { removed } = await api('/history', { method: 'DELETE' });
    toast(`${removed} 件の履歴を削除しました`);
    refreshHistory();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- tabs & init

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = p.id !== `panel-${name}`;
    });
    if (name === 'history') refreshHistory();
    if (name === 'users') refreshUsers();
  });
});

els.cameraToggle.addEventListener('click', () => (state.stream ? stopCamera() : startCamera()));

async function loadConfig() {
  try {
    state.config = await api('/config');
  } catch (err) {
    toast(`設定を取得できません: ${err.message}`);
  }
  // ライブネス検知が有効なときは、写真での認証（なりすましと区別できない）を無効にする
  els.authFileLabel.hidden = state.config.liveness;
  els.authHint.textContent = state.config.liveness
    ? 'カメラに顔を正面から映して「認証する」を押し、画面の指示（まばたき・顔の向き・口を開ける）に従ってください。'
    : 'カメラに顔を正面から映して「認証する」を押してください。';
}

updateButtons();
loadConfig();
refreshUsers();
loadModels();
