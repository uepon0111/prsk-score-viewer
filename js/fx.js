// Hit effects: lane flashes, judgement-line glows and pooled particles.
// Inspired by MikuMikuWorld's particle system (fx_*.json profiles) but
// implemented as a lightweight pooled system using effect.png sprites:
//  - circular burst sprites (NOTE_CIRCULAR_*) for note hits
//  - small 64x64 spark sprites for scatter particles
//  - linear sprite stretched into a lane light pillar
//  - touch_line glow sprites on the judgement line
(function () {
  'use strict';
  const SCALED_ASPECT = window.SekaiRenderer.SCALED_ASPECT;
  const TEX_EFFECT = 3, TEX_TOUCH = 2;
  const CIRCULAR = {
    cyan: [261, 1, 389, 129], green: [781, 1, 909, 129],
    yellow: [1, 259, 129, 387], pink: [391, 259, 519, 387],
  };
  const SPARK = [651, 779, 715, 843];
  const PILLAR = [1, 1, 129, 257];
  const TOUCH_SPRITES = { normal: [0, 0, 244, 56], critical: [0, 112, 244, 168] };

  const KIND_STYLE = {
    perfect: { color: [0.45, 0.9, 1.0], circ: 'cyan', n: 10, power: 1 },
    critical_tap: { color: [1.0, 0.85, 0.3], circ: 'yellow', n: 14, power: 1.2 },
    flick: { color: [1.0, 0.45, 0.65], circ: 'pink', n: 12, power: 1.1 },
    critical_flick: { color: [1.0, 0.7, 0.3], circ: 'yellow', n: 16, power: 1.3 },
    friction: { color: [0.45, 1.0, 0.6], circ: 'green', n: 8, power: 0.8 },
    critical_friction: { color: [0.8, 1.0, 0.35], circ: 'yellow', n: 12, power: 1 },
    tick: { color: [0.5, 0.95, 0.75], circ: 'green', n: 3, power: 0.45 },
    critical_tick: { color: [1.0, 0.9, 0.4], circ: 'yellow', n: 4, power: 0.55 },
    connect: { color: [0.45, 0.9, 1.0], circ: 'cyan', n: 6, power: 0.7 },
    critical_connect: { color: [1.0, 0.85, 0.3], circ: 'yellow', n: 8, power: 0.8 },
  };

  class Fx {
    constructor() {
      this.particles = [];
      this.flashes = [];
      this.pool = [];
      for (let i = 0; i < 1400; i++) this.pool.push({ alive: false });
      this.lastT = 0;
    }
    reset() {
      for (const p of this.pool) p.alive = false;
      this.flashes.length = 0;
    }
    spawn() {
      for (const p of this.pool) if (!p.alive) { p.alive = true; return p; }
      return null;
    }
    trigger(ev, nowSec, mirror) {
      const style = KIND_STYLE[ev.kind] || KIND_STYLE.perfect;
      const m = mirror ? -1 : 1;
      const center = (ev.lane - 6 + ev.width / 2) * m;
      const isTick = ev.kind === 'tick' || ev.kind === 'critical_tick';
      this.flashes.push({
        t0: nowSec, dur: isTick ? 0.18 : 0.3, center, width: ev.width,
        color: style.color, critical: !!ev.critical, pillar: !isTick,
      });
      // expanding ring
      const ring = this.spawn();
      if (ring) {
        Object.assign(ring, {
          type: 'ring', t0: nowSec, dur: 0.38, x: center, y: 1,
          size: 0.35 * style.power * (0.6 + ev.width * 0.22), grow: 2.6,
          color: style.color, circ: style.circ, alpha: 0.9,
        });
      }
      // scatter sparks
      for (let i = 0; i < style.n; i++) {
        const p = this.spawn();
        if (!p) break;
        const ang = Math.random() * Math.PI * 2;
        const spd = (0.25 + Math.random() * 0.75) * style.power;
        Object.assign(p, {
          type: 'spark', t0: nowSec, dur: 0.35 + Math.random() * 0.3,
          x: center + (Math.random() - 0.5) * ev.width * 0.7, y: 1,
          vx: Math.cos(ang) * spd * 0.55, vy: -Math.abs(Math.sin(ang)) * spd - 0.25,
          size: 0.05 + Math.random() * 0.075, color: style.color,
          alpha: 0.95, spin: (Math.random() - 0.5) * 6,
        });
      }
    }
    emitQuads(r, nowSec) {
      const dt = Math.min(0.05, Math.max(0, nowSec - this.lastT));
      this.lastT = nowSec;
      let z = 2147483648;
      // lane flashes (under particles)
      this.flashes = this.flashes.filter((f) => nowSec - f.t0 < f.dur);
      for (const f of this.flashes) {
        const k = (nowSec - f.t0) / f.dur;
        const fade = (1 - k) * (1 - k);
        if (f.pillar) {
          const hw = f.width * 0.46;
          const top = 1 - 0.52 * (0.4 + 0.6 * (1 - k));
          const pos = [
            { x: f.center + hw, y: 1.02 }, { x: f.center + hw, y: top },
            { x: f.center - hw, y: top }, { x: f.center - hw, y: 1.02 }];
          r.pushQuad(pos, [{ x: PILLAR[2], y: PILLAR[1] }, { x: PILLAR[2], y: PILLAR[3] }, { x: PILLAR[0], y: PILLAR[3] }, { x: PILLAR[0], y: PILLAR[1] }],
            TEX_EFFECT, f.color[0], f.color[1], f.color[2], 0.34 * fade, z++, 2);
        }
        // judgement line glow
        const gw = f.width * 0.62 + 0.25;
        const spr = f.critical ? TOUCH_SPRITES.critical : TOUCH_SPRITES.normal;
        const hgt = 0.055 + 0.03 * (1 - k);
        const pos = [
          { x: f.center + gw, y: 1 + hgt }, { x: f.center + gw, y: 1 - hgt },
          { x: f.center - gw, y: 1 - hgt }, { x: f.center - gw, y: 1 + hgt }];
        r.pushQuad(pos, [{ x: spr[2], y: spr[1] }, { x: spr[2], y: spr[3] }, { x: spr[0], y: spr[3] }, { x: spr[0], y: spr[1] }],
          TEX_TOUCH, 1, 1, 1, 0.85 * fade, z++, 2);
      }
      // particles
      for (const p of this.pool) {
        if (!p.alive) continue;
        const age = nowSec - p.t0;
        if (age < 0) continue;
        if (age >= p.dur) { p.alive = false; continue; }
        const k = age / p.dur;
        if (p.type === 'ring') {
          const s = p.size * (0.5 + p.grow * k) * 0.5;
          const a = p.alpha * (1 - k) * (1 - k);
          const spr = CIRCULAR[p.circ];
          const pos = [
            { x: p.x + s, y: p.y + s * SCALED_ASPECT }, { x: p.x + s, y: p.y - s * SCALED_ASPECT },
            { x: p.x - s, y: p.y - s * SCALED_ASPECT }, { x: p.x - s, y: p.y + s * SCALED_ASPECT }];
          r.pushQuad(pos, [{ x: spr[2], y: spr[1] }, { x: spr[2], y: spr[3] }, { x: spr[0], y: spr[3] }, { x: spr[0], y: spr[1] }],
            TEX_EFFECT, p.color[0], p.color[1], p.color[2], a, z++, 2);
        } else {
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vy += 1.5 * dt; // gravity in virtual units
          const s = p.size * (1 - k * 0.5);
          const a = p.alpha * (1 - k);
          const pos = [
            { x: p.x + s, y: p.y + s * SCALED_ASPECT }, { x: p.x + s, y: p.y - s * SCALED_ASPECT },
            { x: p.x - s, y: p.y - s * SCALED_ASPECT }, { x: p.x - s, y: p.y + s * SCALED_ASPECT }];
          r.pushQuad(pos, [{ x: SPARK[2], y: SPARK[1] }, { x: SPARK[2], y: SPARK[3] }, { x: SPARK[0], y: SPARK[3] }, { x: SPARK[0], y: SPARK[1] }],
            TEX_EFFECT, p.color[0], p.color[1], p.color[2], a, z++, 2);
        }
      }
    }
  }

  window.SekaiFx = { Fx };
})();
