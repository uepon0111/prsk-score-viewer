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
  const KIND_GAIN = { tick: 0.65, critical_tick: 0.7, connect: 0.8, critical_connect: 0.85 };

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
      if (ev && ev.isEnd && kind === 'perfect') return 'connect';
      if (ev && ev.isEnd && kind === 'critical_tap') return 'critical_connect';
      return SE_FILES[kind] || 'perfect';
    }
    // Schedule all hit events in [chartNow, chartNow + lookahead].
    schedule(events, fromIdx, chartNow, lookahead) {
      if (!this.ctx || this.seSet === 'off') return fromIdx;
      const horizon = chartNow + lookahead;
      let i = fromIdx;
      while (i < events.length && events[i].time <= horizon) {
        const ev = events[i];
        if (ev.time >= chartNow - 0.05) {
          const name = this.resolveSE(ev.kind, ev);
          let buf = this.buffers[this.seSet][name];
          if (!buf && name === 'critical_friction') buf = this.buffers[this.seSet].friction;
          if (buf) {
            const delay = Math.max(0, (ev.time - chartNow) / this.rate);
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            const g = this.ctx.createGain();
            g.gain.value = (KIND_GAIN[ev.kind] || 1) * (ev.volume || 1);
            src.connect(g); g.connect(this.seGain);
            src.start(this.ctx.currentTime + delay);
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
