// Main glue: loading, transport, settings, frame loop, event dispatch.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('gl');
  const renderer = new window.SekaiRenderer.Renderer(canvas);
  const fx = new window.SekaiFx.Fx();
  const audio = new window.SekaiAudio.AudioEngine();
  const hud = new window.SekaiHud.Hud(document.body);

  const cfg = {
    noteSpeed: 10.5, holdAlpha: 0.74, guideAlpha: 0.5,
    backgroundBrightness: 1, stageCover: 0, stageOpacity: 1,
    mirror: false, flickAnimation: true, holdAnimation: true, simultaneousLine: true,
  };
  const state = {
    score: null, drawData: null, hitEvents: [], hudEvents: [], scaledTable: null,
    duration: 0, hitIdx: 0, seIdx: 0, hudEvIdx: 0,
    playing: false, manualClock: null, effects: true, showCombo: true,
    defaultBg: null, jacket: null, title: '',
  };

  const status = (msg) => { $('status').textContent = msg; };
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };

  // ---------- assets -------------------------------------------------------
  function loadImage(src, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  async function loadSkin(skin) {
    const base = `assets/notes/${skin}/`;
    const [notes, long, touch] = await Promise.all([
      loadImage(base + 'notes.png'), loadImage(base + 'longNoteLine.png'), loadImage(base + 'touchLine_eff.png'),
    ]);
    renderer.setSkinTextures(notes, long, touch);
  }
  // V3 overlay background assets (the original site's generator). Loaded
  // independently; refreshBackground prefers the V3 composition when both
  // the assets and a jacket are available.
  const V3_BASES = [
    'assets/overlay/bggen/v3/',
    'https://raw.githubusercontent.com/uepon0111/prsk-score-viewer/main/assets/overlay/bggen/v3/',
    'https://raw.githubusercontent.com/watagashi-uni/sekai-mmw-preview-web/main/public/assets/mmw/overlay/bggen/v3/',
  ];
  async function loadV3Asset(name) {
    for (const b of V3_BASES) {
      try { return await loadImage(b + name, true); } catch (e) { /* try next base */ }
    }
    throw new Error('bggen ' + name);
  }
  let v3Assets = null, v3Canvas = null, v3Jacket = null;
  async function initV3Assets() {
    try {
      const [base, bottom, centerCover, centerMask, sideCover, sideMask, windows] = await Promise.all(
        ['base.png', 'bottom.png', 'center_cover.png', 'center_mask.png', 'side_cover.png', 'side_mask.png', 'windows.png'].map(loadV3Asset));
      v3Assets = { base, bottom, centerCover, centerMask, sideCover, sideMask, windows };
      refreshBackground();
    } catch (e) { v3Assets = null; }
  }
  async function initAssets() {
    const [stage, effect, defBg] = await Promise.all([
      loadImage('assets/stage/stage.png'), loadImage('assets/effects/effect.png'),
      loadImage('assets/stage/default.png'),
    ]);
    renderer.setStageTexture(stage);
    renderer.setEffectTexture(effect);
    state.defaultBg = defBg;
    await loadSkin('01');
    refreshBackground();
    initV3Assets();
  }
  function refreshBackground() {
    if (v3Assets && state.jacket) {
      if (v3Jacket !== state.jacket || !v3Canvas) {
        try {
          v3Canvas = window.SekaiBg.composeV3Background(state.jacket, v3Assets);
          v3Jacket = state.jacket;
        } catch (e) { v3Canvas = null; }
      }
      if (v3Canvas) { renderer.setBackgroundTexture(v3Canvas); return; }
    }
    const composed = window.SekaiBg.composeBackground(state.defaultBg, state.jacket);
    renderer.setBackgroundTexture(composed);
  }
  async function loadJacketFromUrl(url) {
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      state.jacket = await loadImage(URL.createObjectURL(blob));
    } catch (e) {
      try { state.jacket = await loadImage(url, true); } catch (e2) { state.jacket = null; }
    }
    refreshBackground();
  }

  // ---------- score loading --------------------------------------------------
  function buildScore(susText) {
    // Transactional: derive everything into locals first and swap the live
    // state in one step only when the chart validates as complete. A partial
    // or corrupt chart is rejected and nothing of it is displayed.
    let score, drawData, hitEvents, hudEvents, duration, scaledTable;
    try {
      if (typeof susText !== 'string' || !/\n$/.test(susText)) throw new Error('incomplete chart: truncated');
      score = window.SekaiSUS.parseSUS(susText);
      const invalid = window.SekaiSUS.validateScore(score);
      if (invalid) throw new Error('incomplete chart: ' + invalid);
      drawData = window.SekaiDraw.calculateDrawData(score, cfg.noteSpeed);
      hitEvents = window.SekaiDraw.calculateHitEvents(score);
      hudEvents = window.SekaiDraw.calculateHudEvents(score);
      const endSec = window.SekaiSUS.accumulateDuration(score.maxTick, score.tempos);
      duration = endSec + 2;
      scaledTable = window.SekaiDraw.buildScaledTimeTable(score, Math.max(duration, (audio.bgm.duration || 0)));
    } catch (e) {
      state.score = null;
      status('譜面の読み込みに失敗しました（データが不完全です）');
      return;
    }
    state.score = score;
    state.drawData = drawData;
    state.hitEvents = hitEvents;
    state.hudEvents = hudEvents;
    state.duration = duration;
    state.scaledTable = scaledTable;
    const totalWeight = state.hitEvents.reduce((s, e) => s + (e.combo ? (e.auto ? 0.1 : 1) : 0), 0);
    hud.reset(totalWeight);
    resetEventPointers(0);
    fx.setScore(score);
    audio.fillerSec = (state.fillerSec || 0) - (score.musicOffset || 0);
    status(`譜面を読み込みました（ノーツ ${score.notes.size} / イベント ${state.hitEvents.length}）`);
  }
  function resetEventPointers(chartNow) {
    if (window.SekaiAudio) audio.stopAllLoops();
    const find = (arr, t) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time < t) lo = mid + 1; else hi = mid; }
      return lo;
    };
    state.hitIdx = find(state.hitEvents, chartNow);
    state.seIdx = state.hitIdx;
    state.hudEvIdx = find(state.hudEvents, chartNow);
  }
  // Rebuild HUD combo/score after a seek by replaying events silently.
  function replayHud(chartNow) {
    const totalWeight = state.hitEvents.reduce((s, e) => s + (e.combo ? (e.auto ? 0.1 : 1) : 0), 0);
    hud.reset(totalWeight);
    const merged = [];
    for (const e of state.hudEvents) if (e.time <= chartNow) merged.push({ t: e.time, hudEv: e });
    for (const e of state.hitEvents) if (e.time <= chartNow) merged.push({ t: e.time, hitEv: e });
    merged.sort((a, b) => a.t - b.t);
    for (const m of merged) {
      if (m.hudEv) {
        if (m.hudEv.type === 'skill') hud.onSkill(m.hudEv.time);
        else if (m.hudEv.type === 'feverBegin') hud.onFeverBegin();
        else if (m.hudEv.type === 'feverStart') hud.onFeverStart();
      } else hud.onHit(m.hitEv, m.hitEv.time);
    }
    hud.update();
  }

  let masterDb = null;
  async function getMasterDb() {
    if (masterDb) return masterDb;
    const [musics, vocals] = await Promise.all([
      fetch('https://sekai-world.github.io/sekai-master-db-diff/musics.json').then((r) => r.json()),
      fetch('https://sekai-world.github.io/sekai-master-db-diff/musicVocals.json').then((r) => r.json()),
    ]);
    masterDb = { musics, vocals };
    return masterDb;
  }
  const id4 = (id) => String(id).padStart(4, '0');
  const id3 = (id) => String(id).padStart(3, '0');

  async function loadById(id, diff) {
    status('読み込み中…');
    let title = '', jacketUrl = '', vocal = `vs_${id4(id)}_01`, filler = 0;
    try {
      const db = await getMasterDb();
      const music = db.musics.find((m) => m.id === Number(id));
      if (music) {
        title = music.title || '';
        filler = music.fillerSec || 0;
        jacketUrl = `https://storage.sekai.best/sekai-jp-assets/music/jacket/${music.assetbundleName}/${music.assetbundleName}.webp`;
        const vocalInfo = db.vocals.find((v) => v.musicId === Number(id) && v.musicVocalType === 'original_song')
          || db.vocals.find((v) => v.musicId === Number(id));
        if (vocalInfo) vocal = vocalInfo.assetbundleName;
      }
    } catch (e) { /* master DB optional */ }
    if (!jacketUrl) jacketUrl = `https://storage.sekai.best/sekai-jp-assets/music/jacket/jacket_s_${id3(id)}/jacket_s_${id3(id)}.webp`;
    const susUrls = [
      `https://assets.unipjsk.com/startapp/music/music_score/${id4(id)}_01/${diff}`,
      `https://storage.sekai.best/sekai-jp-assets/music/music_score/${id4(id)}_01/${diff}.sus`,
      `https://asset3.pjsekai.moe/music/music_score/${id4(id)}_01/${diff}.sus`,
    ];
    let susText = null, lastErr = null;
    for (const url of susUrls) {
      try {
        const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        susText = await res.text();
        if (susText && susText.includes('#')) break;
        susText = null;
      } catch (e) { lastErr = e; }
    }
    if (susText == null) { status('SUSの取得に失敗しました: ' + (lastErr && lastErr.message)); return; }
    state.fillerSec = filler;
    state.title = title;
    $('songTitle').textContent = title ? `#${id} ${title} (${diff.toUpperCase()})` : `#${id} (${diff.toUpperCase()})`;
    audio.bgm.src = `https://storage.sekai.best/sekai-jp-assets/music/long/${vocal}/${vocal}.mp3`;
    audio.bgm.load();
    loadJacketFromUrl(jacketUrl);
    buildScore(susText);
    pauseTransport();
  }

  // ---------- transport ------------------------------------------------------
  function chartNow() {
    if (audio.bgm.src && audio.bgm.readyState > 0) return audio.chartTime();
    if (state.manualClock) return (performance.now() - state.manualClock.t0) / 1000 * state.manualClock.rate + state.manualClock.base;
    return state.manualBase || 0;
  }
  function playTransport() {
    audio.ensureCtx();
    $('latencyInfo').textContent = Math.round(audio.latencyComp() * 1000) + 'ms';
    if (audio.bgm.src) {
      audio.bgm.playbackRate = audio.rate;
      audio.bgm.play().catch(() => {});
    } else {
      state.manualClock = { t0: performance.now(), base: chartNow(), rate: audio.rate };
    }
    state.playing = true;
    $('playBtn').textContent = '⏸ 一時停止';
  }
  function pauseTransport() {
    const now = chartNow();
    if (audio.bgm.src) audio.bgm.pause();
    state.manualClock = null;
    state.manualBase = now;
    state.playing = false;
    $('playBtn').textContent = '▶ 再生';
  }
  function seekChart(t) {
    t = Math.max(-1, Math.min(state.duration, t));
    if (audio.bgm.src) {
      const target = t - audio.clockShift();
      audio.bgm.currentTime = Math.max(0, target);
    }
    state.manualBase = t;
    if (state.manualClock) state.manualClock = { t0: performance.now(), base: t, rate: audio.rate };
    resetEventPointers(t);
    replayHud(t);
    fx.reset();
  }

  // ---------- frame loop ------------------------------------------------------
  function frame() {
    requestAnimationFrame(frame);
    if (!state.score) return;
    const now = chartNow();
    const scaled = state.scaledTable ? state.scaledTable.at(now) : now;
    // hit events -> HUD (effects are note-driven, updated below)
    while (state.hitIdx < state.hitEvents.length && state.hitEvents[state.hitIdx].time <= now) {
      const ev = state.hitEvents[state.hitIdx++];
      hud.onHit(ev, now);
    }
    while (state.hudEvIdx < state.hudEvents.length && state.hudEvents[state.hudEvIdx].time <= now) {
      const ev = state.hudEvents[state.hudEvIdx++];
      if (ev.type === 'skill') hud.onSkill(now);
      else if (ev.type === 'feverBegin') hud.onFeverBegin();
      else if (ev.type === 'feverStart') hud.onFeverStart();
    }
    // SE lookahead scheduling
    if (state.playing) {
      state.seIdx = audio.schedule(state.hitEvents, state.seIdx, now, 0.15);
    }
    hud.update();
    if (state.effects) fx.update(now, window.SekaiSUS.accumulateTicks(now, state.score.tempos), cfg.mirror);
    renderer.render({
      score: state.score, drawData: state.drawData, cfg,
      nowSec: now, nowScaled: scaled, fx: state.effects ? fx : null,
    });
    // transport UI
    const dur = state.duration || 0;
    $('seek').value = dur > 0 ? String(Math.round((now / dur) * 1000)) : '0';
    $('timeLabel').textContent = fmtTime(now) + ' / ' + fmtTime(dur);
    if (now > dur + 0.5 && state.playing) pauseTransport();
  }

  // ---------- layout ------------------------------------------------------------
  function layout() {
    const wrap = $('stageWrap');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const boxW = Math.min(w, h * (16 / 9));
    const boxH = boxW * (9 / 16);
    const box = $('stageBox');
    box.style.width = boxW + 'px';
    box.style.height = boxH + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    renderer.resize(boxW, boxH, dpr);
  }
  window.addEventListener('resize', layout);

  // ---------- UI wiring -----------------------------------------------------------
  function bindRange(id, key, fmt, after) {
    const el = $(id), out = $(id + '-v');
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      cfg[key] = v;
      if (out) out.textContent = fmt ? fmt(v) : v;
      if (after) after(v);
    });
  }
  bindRange('cfg-noteSpeed', 'noteSpeed', (v) => v.toFixed(1), () => {
    if (state.score) state.drawData = window.SekaiDraw.calculateDrawData(state.score, cfg.noteSpeed);
  });
  bindRange('cfg-holdAlpha', 'holdAlpha', (v) => v.toFixed(2));
  bindRange('cfg-guideAlpha', 'guideAlpha', (v) => v.toFixed(2));
  bindRange('cfg-bgBright', 'backgroundBrightness', (v) => v.toFixed(2));
  bindRange('cfg-stageCover', 'stageCover', (v) => v.toFixed(2));
  bindRange('cfg-stageOpacity', 'stageOpacity', (v) => v.toFixed(2));
  bindRange('cfg-seVol', 'seVolume', (v) => v.toFixed(2), (v) => audio.setSeVolume(v));
  $('cfg-bgmVol').addEventListener('input', (e) => {
    audio.bgm.volume = parseFloat(e.target.value);
    $('cfg-bgmVol-v').textContent = parseFloat(e.target.value).toFixed(2);
  });
  $('cfg-skin').addEventListener('change', (e) => loadSkin(e.target.value).catch(() => status('スキン読み込み失敗')));
  $('cfg-fxq').addEventListener('change', (e) => fx.setProfile(+e.target.value));
  $('cfg-seSet').addEventListener('change', async (e) => {
    audio.seSet = e.target.value;
    if (audio.seSet !== 'off') await audio.loadSE(audio.seSet);
  });
  $('cfg-mirror').addEventListener('change', (e) => { cfg.mirror = e.target.checked; });
  $('cfg-flickAnim').addEventListener('change', (e) => { cfg.flickAnimation = e.target.checked; });
  $('cfg-holdAnim').addEventListener('change', (e) => { cfg.holdAnimation = e.target.checked; });
  $('cfg-simLine').addEventListener('change', (e) => { cfg.simultaneousLine = e.target.checked; });
  $('cfg-effects').addEventListener('change', (e) => { state.effects = e.target.checked; if (!state.effects) fx.reset(); });
  $('cfg-showCombo').addEventListener('change', (e) => {
    state.showCombo = e.target.checked;
    $('hud-comboWrap').style.display = state.showCombo ? '' : 'none';
  });
  $('settingsBtn').addEventListener('click', () => $('settings').classList.toggle('open'));
  $('loadSong').addEventListener('click', () => loadById($('songId').value, $('diff').value));
  $('playBtn').addEventListener('click', () => (state.playing ? pauseTransport() : playTransport()));
  $('hud-pauseBtn').addEventListener('click', () => (state.playing ? pauseTransport() : playTransport()));
  $('seek').addEventListener('input', (e) => {
    if (state.duration) seekChart((parseFloat(e.target.value) / 1000) * state.duration);
  });
  $('rate').addEventListener('change', (e) => {
    audio.rate = parseFloat(e.target.value);
    if (audio.bgm.src) audio.bgm.playbackRate = audio.rate;
    if (state.manualClock) {
      const now = chartNow();
      state.manualClock = { t0: performance.now(), base: now, rate: audio.rate };
    }
    resetEventPointers(chartNow());
  });
  $('offsetMs').addEventListener('change', (e) => { audio.userOffsetMs = parseFloat(e.target.value) || 0; });
  $('fileSusBtn').addEventListener('click', () => $('fileSus').click());
  $('fileBgmBtn').addEventListener('click', () => $('fileBgm').click());
  $('fileJacketBtn').addEventListener('click', () => $('fileJacket').click());
  $('fileSus').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) buildScore(await f.text());
  });
  $('fileBgm').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) { audio.bgm.src = URL.createObjectURL(f); audio.bgm.load(); }
  });
  $('fileJacket').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { state.jacket = await loadImage(URL.createObjectURL(f)); refreshBackground(); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      state.playing ? pauseTransport() : playTransport();
    }
  });
  audio.bgm.volume = 0.85;
  audio.bgm.addEventListener('ended', () => pauseTransport());

  // ---------- hash cfg ------------------------------------------------------------
  function tryHashCfg() {
    const m = location.hash.match(/#cfg=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    try {
      const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
      if (json.title) $('songTitle').textContent = json.title;
      if (json.offset) { state.fillerSec = json.offset; }
      if (json.bgm) { audio.bgm.src = json.bgm; audio.bgm.load(); }
      if (json.jacket) loadJacketFromUrl(json.jacket);
      if (json.sus) {
        fetch(json.sus).then((r) => r.text()).then(buildScore).catch(() => status('SUS取得失敗'));
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // ---------- boot ------------------------------------------------------------------
  window.__sekai = { state, cfg, audio, seekChart, playTransport, pauseTransport, chartNow, renderer };
  (async function boot() {
    layout();
    try {
      await initAssets();
      await audio.loadSE('01');
    } catch (e) {
      status('素材の読み込みに失敗しました: ' + e.message);
      return;
    }
    const params = new URLSearchParams(location.search);
    if (!tryHashCfg()) {
      await loadById(params.get('id') || '796', params.get('diff') || 'master');
    }
    layout();
    requestAnimationFrame(frame);
  })();
})();
