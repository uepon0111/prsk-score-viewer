// Audio: BGM via <audio> (preservesPitch time-stretch, like the game),
// SE via WebAudio buffers scheduled with a lookahead window.
// Chart clock = audio.currentTime - fillerOffset + outputLatency + userOffset.
(function () {
  'use strict';
  const SE_FILES = {
    perfect: 'perfect', critical_tap: 'critical_tap', flick: 'flick',
    critical_flick: 'critical_flick', friction: 'friction',
    critical_friction: 'critical_friction', tick: 'tick', critical_tick: 'critical_tick',
    connect: 'connect', critical_connect: 'critical_connect',
  };
  // Per-sound gains from the reference implementation (sekai-mmw-
  // preview-web, JudgementSounds.getVolume). The pack's connect /
  // critical_connect files are the hold LOOP sounds (se_live_long*).
  const KIND_GAIN = { perfect: 0.75, critical_tap: 0.75, flick: 0.75, critical_flick: 0.8, friction: 0.8, critical_friction: 0.82, tick: 0.9, critical_tick: 0.92, connect: 0.7, critical_connect: 0.7 };

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.seGain = null;
      this.buffers = { '01': {}, '02': {} };
      this.bgm = new Audio();
      this.bgm.preload = 'auto';
      this.bgm.preservesPitch = true;
      if ('mozPreservesPitch' in this.bgm) this.bgm.mozPreservesPitch = true;
      this.rate = 1;
      this.userOffsetMs = 0;
      this.fillerSec = 0;
      this.seSet = '01';
      this.seVolume = 0.9;
      this.scheduled = new Set();
      this.activeLoops = new Map();
    }
    ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.seGain = this.ctx.createGain();
        this.seGain.gain.value = this.seVolume;
        this.seGain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    latencyComp() {
      if (!this.ctx) return 0;
      if (typeof this.ctx.outputLatency === 'number' && this.ctx.outputLatency > 0) return this.ctx.outputLatency;
      if (typeof this.ctx.getOutputTimestamp === 'function') {
        const ts = this.ctx.getOutputTimestamp();
        if (ts && typeof ts.outputLatency === 'number' && ts.outputLatency > 0) return ts.outputLatency;
      }
      if (typeof this.ctx.baseLatency === 'number') return this.ctx.baseLatency;
      return 0;
    }
    // Seconds the chart clock is ahead of the raw audio element clock.
    clockShift() {
      return -this.fillerSec + this.latencyComp() + this.userOffsetMs / 1000;
    }
    chartTime() {
      if (!this.bgm.src) return -999;
      return this.bgm.currentTime + this.clockShift();
    }
    async loadSE(set) {
      this.ensureCtx();
      const names = [...new Set(Object.values(SE_FILES))];
      await Promise.all(names.map(async (name) => {
        if (this.buffers[set][name]) return;
        try {
          const res = await fetch(`assets/sound/${set}/${name}.mp3`);
          if (!res.ok) return;
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers[set][name] = buf;
        } catch (e) { /* missing file (e.g. critical_friction in set 01) */ }
      }));
    }
    resolveSE(kind, ev) {
      if (kind === 'holdLoop') return ev && ev.critical ? 'critical_connect' : 'connect';
      return SE_FILES[kind] || 'perfect';
    }
    stopAllLoops() {
      for (const loop of this.activeLoops.values()) {
        try { loop.src.stop(); } catch (e) {}
        try { loop.src.disconnect(); loop.gn.disconnect(); } catch (e) {}
      }
      this.activeLoops.clear();
    }
    cleanupExpiredLoops(chartNow) {
      for (const [key, loop] of [...this.activeLoops]) {
        if (loop.endChart <= chartNow) {
          try { loop.src.stop(); } catch (e) {}
          this.activeLoops.delete(key);
        }
      }
    }
    // Hold loop, mirroring the reference JudgementSounds.playHoldLoop:
    // the connect sample loops (3000-sample padding trimmed at both
    // ends) from the hold's start and stops at the hold's end, so its
    // length always follows the note's length. An identical loop that
    // is already sounding (same sound, center and width) is extended
    // instead of doubled.
    startLoop(ev, chartNow) {
      const name = this.resolveSE(ev.kind, ev);
      const buf = this.buffers[this.seSet][name];
      if (!buf) return;
      const center = ev.lane + ev.width / 2;
      const key = name + '|' + center + '|' + ev.width;
      const ex = this.activeLoops.get(key);
      if (ex) {
        ex.endChart = Math.max(ex.endChart, ev.endTime);
        try { ex.src.stop(this.ctx.currentTime + Math.max((ex.endChart - chartNow) / this.rate, 0.02)); } catch (e) {}
        return;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = this.rate;
      src.loop = true;
      const pad = 3000 / buf.sampleRate;
      const loopStart = Math.min(pad, Math.max(0, buf.duration * 0.45));
      src.loopStart = loopStart;
      src.loopEnd = Math.max(loopStart + 0.01, buf.duration - pad);
      const gn = this.ctx.createGain();
      gn.gain.value = (KIND_GAIN[name] || 1) * (ev.volume || 1);
      src.connect(gn); gn.connect(this.seGain);
      const loop = { src, gn, endChart: ev.endTime };
      src.onended = () => {
        try { src.disconnect(); gn.disconnect(); } catch (e) {}
        if (this.activeLoops.get(key) === loop) this.activeLoops.delete(key);
      };
      this.activeLoops.set(key, loop);
      src.start(this.ctx.currentTime + Math.max(0, (ev.time - chartNow) / this.rate));
      try { src.stop(this.ctx.currentTime + Math.max((ev.endTime - chartNow) / this.rate, 0.02)); } catch (e) {}
    }
    // Schedule all hit events in [chartNow, chartNow + lookahead].
    schedule(events, fromIdx, chartNow, lookahead) {
      if (!this.ctx || this.seSet === 'off') return fromIdx;
      this.cleanupExpiredLoops(chartNow);
      const horizon = chartNow + lookahead;
      let i = fromIdx;
      while (i < events.length && events[i].time <= horizon) {
        const ev = events[i];
        if (ev.time >= chartNow - 0.05) {
          if (ev.kind === 'holdLoop') {
            if (ev.endTime > ev.time) this.startLoop(ev, chartNow);
          } else {
            const name = this.resolveSE(ev.kind, ev);
            let buf = this.buffers[this.seSet][name];
            if (!buf && name === 'critical_friction') buf = this.buffers[this.seSet].friction;
            if (buf) {
              const delay = Math.max(0, (ev.time - chartNow) / this.rate);
              const src = this.ctx.createBufferSource();
              src.buffer = buf;
              src.playbackRate.value = this.rate;
              const g = this.ctx.createGain();
              g.gain.value = (KIND_GAIN[name] || 1) * (ev.volume || 1);
              src.connect(g); g.connect(this.seGain);
              src.start(this.ctx.currentTime + delay);
            }
          }
        }
        i++;
      }
      return i;
    }
    setSeVolume(v) {
      this.seVolume = v;
      if (this.seGain) this.seGain.gain.value = v;
    }
  }

  window.SekaiAudio = { AudioEngine };
})();
