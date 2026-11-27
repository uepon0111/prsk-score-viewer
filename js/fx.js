// Hit effects: faithful JS port of MikuMikuWorld's particle effect engine
// as ported by sekai-mmw-preview-web (mmw_port/Particle.cpp, EffectView.cpp,
// MinMax.cpp, Rendering/Renderer.h). Effect profiles are the game's own
// Unity-style particle definitions (window.MMW_FX_PROFILES, distilled from
// the bundled fx_*.json profile 0); sprites are tiles of effect.png (8x8).
// Particles are simulated in the engine's 3D world space, projected with
// its effect camera (fov 50, pos (0,5.32,-5.86), rot (-90, 27.1)) and drawn
// as NDC quads with reciprocal-w through the renderer's effect pass.
(function () {
  'use strict';
  let PROFILES = window.MMW_FX_PROFILES;
  const D2R = Math.PI / 180;
  const lerp = (a, b, t) => a + (b - a) * t;
  const unlerp = (a, b, v) => (b - a) === 0 ? 0 : (v - a) / (b - a);
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  // ---- RNG (RandN equivalent; visual parity only) -------------------------
  function RandN(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  RandN.prototype.next = function () {
    let t = (this.s += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RandN.prototype.setSeed = function (seed) { this.s = (seed >>> 0) || 0x9e3779b9; };
  const globalRandom = new RandN(1234567);
  const globalNext = () => globalRandom.next();

  // ---- MinMax / MinMaxColor evaluation (MinMax.cpp) ------------------------
  function findKeyFrame(kfs, time) {
    let min = 0, max = kfs.length - 1;
    while (min <= max) {
      const idx = (min + max) >> 1;
      if (time < kfs[idx][0]) max = idx - 1; else min = idx + 1;
    }
    return min;
  }
  // Cubic Bezier through the tangent-derived control points (the C++ hermite
  // computes x control points too but its return uses only the y values).
  function hermite(k1, k2, ratio) {
    const dt = k2[0] - k1[0];
    const y0 = k1[1];
    const y1 = k1[1] + k1[3] * k1[5] * dt;
    const y2 = k2[1] - k2[2] * k2[4] * dt;
    const y3 = k2[1];
    const u = 1 - ratio, u2 = u * u, u3 = u2 * u, t2 = ratio * ratio, t3 = t2 * ratio;
    return u3 * y0 + 3 * u2 * ratio * y1 + 3 * u * t2 * y2 + t3 * y3;
  }
  function hermiteArea(k1, k2, ratio) {
    const dt = k2[0] - k1[0];
    const y0 = k1[1];
    const y1 = k1[1] + k1[3] * k1[5] * dt;
    const y2 = k2[1] - k2[2] * k2[4] * dt;
    const y3 = k2[1];
    const a = -y0 + 3 * y1 - 3 * y2 + y3;
    const b = 3 * y0 - 6 * y1 + 3 * y2;
    const c = -3 * y0 + 3 * y1;
    const d = y0;
    const t2 = ratio * ratio, t3 = t2 * ratio, t4 = t3 * ratio;
    return (a / 4) * t4 + (b / 3) * t3 + (c / 2) * t2 + d * ratio;
  }
  function evalCurve(kfs, time, fallback) {
    if (!kfs || !kfs.length) return fallback;
    if (time <= kfs[0][0]) return kfs[0][1];
    if (time >= kfs[kfs.length - 1][0]) return kfs[kfs.length - 1][1];
    const idx = findKeyFrame(kfs, time);
    if (idx === 0) return kfs[0][1];
    const k1 = kfs[idx - 1], k2 = kfs[idx];
    const ratio = k2[0] - k1[0] > 0 ? (time - k1[0]) / (k2[0] - k1[0]) : 0;
    return hermite(k1, k2, ratio);
  }
  function integrateCurve(kfs, from, to, scale) {
    if (!kfs || !kfs.length) return 0;
    if (kfs.length === 1) return kfs[0][1];
    const idx = findKeyFrame(kfs, to);
    if (idx === 0) return kfs[0][1];
    let total = 0;
    for (let i = 0; i < idx - 1; i++) {
      const tf = kfs[i + 1][0] - kfs[i][0];
      total += hermiteArea(kfs[i], kfs[i + 1], 1) * (tf * scale);
    }
    if (idx <= kfs.length - 1) {
      const k1 = kfs[idx - 1], k2 = kfs[idx];
      const ratio = k2[0] - k1[0] > 0 ? (to - k1[0]) / (k2[0] - k1[0]) : 0;
      total += hermiteArea(k1, k2, ratio) * ((k2[0] - k1[0]) * scale);
    }
    return total;
  }
  // MinMax modes: 0 Constant, 1 Curve, 2 TwoCurves, 3 TwoConstants
  function mmEval(mm, time, lr, fallback) {
    if (!mm) return fallback || 0;
    switch (mm.m) {
      case 3: return lerp(mm.lo, mm.hi, lr);
      case 1: return evalCurve(mm.a, time, fallback || 0);
      case 2: return lerp(evalCurve(mm.a, time, fallback || 0), evalCurve(mm.b, time, fallback || 0), lr);
      default: return mm.c;
    }
  }
  function mmIntegrate(mm, from, to, scale, lr, fallback) {
    if (!mm) return (fallback || 0) * ((to - from) * scale);
    switch (mm.m) {
      case 3: return lerp(mm.lo, mm.hi, lr) * ((to - from) * scale);
      case 1: return integrateCurve(mm.a, from, to, scale);
      case 2: return lerp(integrateCurve(mm.a, from, to, scale), integrateCurve(mm.b, from, to, scale), lr);
      default: return mm.c * ((to - from) * scale);
    }
  }
  function mm3Eval(mm3, time, lr3, fallback) {
    // lr3: a number (same ratio for all axes) or [x,y,z]
    const lx = Array.isArray(lr3) ? lr3[0] : lr3, ly = Array.isArray(lr3) ? lr3[1] : lr3, lz = Array.isArray(lr3) ? lr3[2] : lr3;
    return [mmEval(mm3.x, time, lx, fallback), mmEval(mm3.y, time, ly, fallback), mmEval(mm3.z, time, lz, fallback)];
  }
  function mm3Integrate(mm3, from, to, scale, lr3) {
    const lx = Array.isArray(lr3) ? lr3[0] : lr3, ly = Array.isArray(lr3) ? lr3[1] : lr3, lz = Array.isArray(lr3) ? lr3[2] : lr3;
    return [mmIntegrate(mm3.x, from, to, scale, lx, 0), mmIntegrate(mm3.y, from, to, scale, ly, 0), mmIntegrate(mm3.z, from, to, scale, lz, 0)];
  }
  const WHITE = [1, 1, 1, 1], BLACK_A = [0, 0, 0, 1];
  function colorAt(kfs, time) {
    if (!kfs || !kfs.length) return WHITE;
    if (time >= kfs[kfs.length - 1][0]) { const k = kfs[kfs.length - 1]; return [k[1], k[2], k[3], k[4]]; }
    const idx = findKeyFrame(kfs, time);
    if (idx === 0) { const k = kfs[0]; return [k[1], k[2], k[3], k[4]]; }
    const k1 = kfs[idx - 1], k2 = kfs[idx];
    const r = k2[0] - k1[0] > 0 ? (time - k1[0]) / (k2[0] - k1[0]) : 0;
    return [lerp(k1[1], k2[1], r), lerp(k1[2], k2[2], r), lerp(k1[3], k2[3], r), lerp(k1[4], k2[4], r)];
  }
  // MinMaxColor modes: 0 Constant(=colorMax), 1 Gradient, 2 TwoColors, 3 TwoGradients, 4 Random
  function mmColorEval(mc, time, lr) {
    if (!mc) return BLACK_A; // C++ default MinMaxColor: constant Color(0,0,0,1)
    switch (mc.m) {
      case 2: return [lerp(mc.lo[0], mc.hi[0], lr), lerp(mc.lo[1], mc.hi[1], lr), lerp(mc.lo[2], mc.hi[2], lr), lerp(mc.lo[3], mc.hi[3], lr)];
      case 4: {
        // Random (Unity MinMaxGradient "Random Color"): the gradient is a
        // continuous ramp sampled at the particle's random ratio — NOT a
        // discrete snap to a keyframe. Snapping (the C++ fan port's shortcut)
        // makes ~1/3 of grains take an endpoint key at full saturation
        // (pure red on critical profiles, pure cyan on normal ones), which
        // breaks the normal-vs-critical color distinction the game shows:
        // critical grains read as a white→gold continuum, normal grains as
        // their type color continuum.
        if (!mc.a || !mc.a.length) return WHITE;
        return colorAt(mc.a, lr);
      }
      case 1: return colorAt(mc.a, time);
      case 3: {
        const c1 = colorAt(mc.a, time), c2 = colorAt(mc.b, time);
        return [lerp(c1[0], c2[0], lr), lerp(c1[1], c2[1], lr), lerp(c1[2], c2[2], lr), lerp(c1[3], c2[3], lr)];
      }
      default: return mc.hi;
    }
  }

  // ---- vec3 / quaternion / matrix (DirectX row-major conventions) ---------
  const v3 = (x, y, z) => [x || 0, y || 0, z || 0];
  const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vMul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vNeg = (a) => [-a[0], -a[1], -a[2]];
  const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vLen = (a) => Math.sqrt(vDot(a, a));
  const vNorm = (a) => { const l = vLen(a); return l > 0 ? vScale(a, 1 / l) : [0, 0, 0]; };

  function quatAxisAngle(axis, rad) {
    const s = Math.sin(rad / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
  }
  function quatMul(a, b) { // Hamilton product a*b (applies b first, then a)
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }
  function quatFromZYX(eulerDeg) {
    const qx = quatAxisAngle([1, 0, 0], eulerDeg[0] * D2R);
    const qy = quatAxisAngle([0, 1, 0], eulerDeg[1] * D2R);
    const qz = quatAxisAngle([0, 0, 1], eulerDeg[2] * D2R);
    return quatMul(quatMul(qz, qy), qx);
  }
  function vRotate(v, q) {
    // v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const u = [q[0], q[1], q[2]];
    const c1 = vCross(u, v);
    const inner = [c1[0] + q[3] * v[0], c1[1] + q[3] * v[1], c1[2] + q[3] * v[2]];
    const c2 = vCross(u, inner);
    return [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]];
  }

  const matIdentity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function matMul(a, b) { // result = a * b (apply a, then b), row-major v*M
    const o = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
    return o;
  }
  const matScaling = (s) => new Float32Array([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]);
  const matTranslation = (t) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]);
  function matRotationQuat(q) {
    const [x, y, z, w] = q;
    return new Float32Array([
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1]);
  }
  function matRotationAxis(axis, angle) {
    const [x, y, z] = axis;
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return new Float32Array([
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1]);
  }
  function matTransform4(m, v) { // v = [x,y,z,w]
    return [
      v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + v[3] * m[12],
      v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + v[3] * m[13],
      v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + v[3] * m[14],
      v[0] * m[3] + v[1] * m[7] + v[2] * m[11] + v[3] * m[15],
    ];
  }
  function matInverse(m) {
    const a = m, o = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return matIdentity();
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  }
  function matLookAtLH(eye, target, up) {
    const zaxis = vNorm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const xaxis = vNorm(vCross(up, zaxis));
    const yaxis = vCross(zaxis, xaxis);
    return new Float32Array([
      xaxis[0], yaxis[0], zaxis[0], 0,
      xaxis[1], yaxis[1], zaxis[1], 0,
      xaxis[2], yaxis[2], zaxis[2], 0,
      -vDot(xaxis, eye), -vDot(yaxis, eye), -vDot(zaxis, eye), 1]);
  }
  function matPerspectiveFovLH(fovY, aspect, zn, zf) {
    const yS = 1 / Math.tan(fovY / 2), xS = yS / aspect;
    const o = new Float32Array(16);
    o[0] = xS; o[5] = yS; o[10] = zf / (zf - zn); o[11] = 1; o[14] = -zn * zf / (zf - zn);
    return o;
  }

  // ---- effect camera (initializeEffects / Camera.cpp) --------------------
  const CAM_POS = [0, 5.32, -5.86];
  const camFront = (() => {
    const yaw = -90 * D2R, pitch = 27.1 * D2R;
    return vNorm([Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch)]);
  })();
  const VIEW = matLookAtLH(CAM_POS, vAdd(CAM_POS, camFront), [0, 1, 0]);
  const INVERSE_VIEW = (() => {
    const inv = matInverse(VIEW);
    inv[12] = 0; inv[13] = 0; inv[14] = 0; inv[15] = 1; // Camera zeroes the translation row
    return inv;
  })();
  const EFFECTS_TARGET_ASPECT = 16 / 9;
  function projectionFor(aspect) {
    const s = Math.min(aspect / EFFECTS_TARGET_ASPECT, 1);
    return matMul(matScaling([s, s, 1]), matPerspectiveFovLH(50 * D2R, aspect, 0.3, 1000));
  }

  // ---- particle instances & emitters (Particle.cpp) -----------------------
  const GRAVITY = 9.81, BILLBOARD_SCALE = 0.71;
  function newParticle() {
    return {
      alive: false, matrix: matIdentity(), pos: v3(), rot: v3(), scale: v3(1, 1, 1),
      direction: v3(), startTime: 0, time: 0, duration: 0,
      gravityLerp: 0, spriteLerp: 0, velocityLerp: 0, sizeLerp: 0, colorLerp: 0,
      limitLerp: 0, forceLerp: 0, rotationLerp: 0, speed: 0,
      startColor: [1, 1, 1, 1], flipRotation: false,
    };
  }

  function rotateToDirection(ref, velocity, scale) {
    const up = [0, 1, 0];
    const nv = vNorm(vNeg(velocity));
    let axis = vCross(nv, up);
    let angle = vLen(axis);
    if (angle >= 0.000001) {
      angle = Math.asin(Math.min(angle, 1));
    } else {
      angle = 0;
      axis = [1, 0, 0];
      if (vLen(axis) < 0.000001) axis = [-1, 0, 0];
    }
    if (vDot(vNeg(nv), up) < 0) angle = Math.PI - angle;
    const ls = vDot(velocity, velocity);
    const len = ls > 0.000001 ? Math.sqrt(ls) : 0;
    const yScale = ref.rend.speedScale * len + ref.rend.lengthScale * scale[0];
    const stretch = vScale(nv, yScale * 0.5);
    let m = matScaling([1, yScale, 1]);
    m = matMul(m, matRotationAxis(axis, angle));
    m = matMul(m, matTranslation(stretch));
    return m;
  }

  class Emitter {
    constructor(sys) {
      this.ref = sys;
      this.base = { p: v3(), r: v3(), s: v3(1, 1, 1) };
      this.children = (sys.ch || []).map((c) => new Emitter(c));
      this.particles = [];
      this.bursts = (sys.em.bursts || []).map(() => ({ last: 0, cycles: 0, nextReset: 0 }));
      this.startTime = 0; this.lastEmission = 0; this.accumulator = 0;
      this.emissionPosition = 0; this.emissionInterval = 0; this.rateOverTime = 1;
      this.aliveCount = 0;
      this.rngInitial = new RandN(1); this.rngShape = new RandN(1);
      this.rngVelocity = new RandN(1); this.rngSize = new RandN(1);
    }
    init(transform) {
      this.base = { p: transform.p.slice(), r: transform.r.slice(), s: transform.s.slice() };
      const ref = this.ref;
      const childT = {
        p: vAdd(transform.p, ref.tf.p), r: vAdd(transform.r, ref.tf.r), s: vMul(transform.s, ref.tf.s),
      };
      for (const ch of this.children) ch.init(childT);
    }
    getMaxParticleCount() {
      const ref = this.ref;
      let count = Math.trunc(this.rateOverTime * ref.dur + 1);
      for (const b of ref.em.bursts || []) {
        if (b[2] === 0) {
          const cycles = Math.ceil((ref.dur - b[0]) / b[3]) + 1;
          count += (isFinite(cycles) ? cycles : 0) * b[1];
        } else {
          count += b[1] * b[2];
        }
      }
      return Math.min(count, ref.maxP) + 1;
    }
    start(time) {
      const ref = this.ref;
      if (ref.autoSeed) {
        const seed = Math.floor(globalNext() * 4294967296);
        this.rngInitial.setSeed(seed); this.rngShape.setSeed(seed);
        this.rngVelocity.setSeed(seed); this.rngSize.setSeed(seed);
      } else {
        this.rngInitial.setSeed(ref.seed); this.rngShape.setSeed(ref.seed);
        this.rngVelocity.setSeed(ref.seed); this.rngSize.setSeed(ref.seed);
      }
      const emissionRandom = globalNext();
      globalNext(); // arcSpeed random (stored but unused by the port)
      this.startTime = time + mmEval(ref.delay, 0, emissionRandom, 0);
      this.rateOverTime = mmEval(ref.em.rate, 0, emissionRandom, 0);
      const maxCount = this.getMaxParticleCount();
      while (this.particles.length < maxCount) this.particles.push(newParticle());
      for (const b of this.bursts) b.nextReset = this.startTime + ref.dur;
      for (const ch of this.children) ch.start(time);
    }
    stop(allChildren) {
      this.lastEmission = 0; this.accumulator = 0;
      this.emissionPosition = 0; this.emissionInterval = 0; this.aliveCount = 0;
      for (const b of this.bursts) { b.last = 0; b.cycles = 0; b.nextReset = 0; }
      for (const p of this.particles) p.alive = false;
      if (allChildren) for (const ch of this.children) ch.stop(true);
    }
    emit(world, time) {
      const ref = this.ref;
      let idx = -1;
      for (let i = 0; i < this.particles.length; i++) if (!this.particles[i].alive) { idx = i; break; }
      if (idx < 0) return;
      const base = this.base;
      const qBase = quatFromZYX(base.r);
      const baseAndRefRot = vAdd(base.r, ref.tf.r);
      const qBaseRef = quatFromZYX(baseAndRefRot);
      const qAll = quatFromZYX(vAdd(baseAndRefRot, ref.em.tf.r));
      const transformPos = vRotate(vMul(ref.tf.p, base.s), qBase);
      const basePos = vRotate(vMul(base.p, base.s), qBase);
      const shapePos = vRotate(ref.em.tf.p, qBaseRef);
      const position = vAdd(vAdd(transformPos, basePos), shapePos);

      const R = this.rngInitial;
      const a = R.next(), b = R.next(), c = R.next();
      let cy = 0, cz = 0, ey = 0, ez = 0;
      if (ref.size.is3D) { cy = R.next(); cz = R.next(); }
      R.next(); // d: drawn but unused in the original
      const e = R.next();
      if (ref.rot.is3D) { ey = R.next(); ez = R.next(); }
      const f = R.next(), g = R.next(), h = R.next();
      void f;

      const speedLen = mmEval(ref.speed, 0, b, 0);
      const startRot = ref.rot.is3D ? mm3Eval(ref.rot, 0, [e, ey, ez], 0) : mm3Eval(ref.rot, 0, e, 0);
      let emitPos = [0, 0, 0], direction = [0, 0, 0];
      const em = ref.em, S = this.rngShape;
      if (em.shape === 5) { // Box
        const half = vScale(em.tf.s, 0.5);
        const local = [lerp(-half[0], half[0], S.next()), lerp(-half[1], half[1], S.next()), lerp(-half[2], half[2], S.next())];
        emitPos = vAdd(vRotate(local, qAll), position);
        direction = vRotate([0, 0, 1], qBaseRef);
      } else if (em.shape === 4) { // Cone
        let arc;
        if (em.arcMode === 1) { // Loop
          arc = this.emissionPosition * D2R;
          this.emissionPosition += mmEval(em.arcSpeed, Math.max(time - this.startTime, 0), S.next(), 0) * (time - this.startTime) * 360;
          this.emissionPosition = ((this.emissionPosition % em.arc) + em.arc) % em.arc;
        } else if (em.arcMode === 3) { // BurstSpread
          arc = this.emissionPosition * D2R;
          this.emissionPosition += this.emissionInterval;
        } else {
          arc = lerp(0, em.arc * D2R, S.next());
        }
        const angle = em.angle * D2R;
        const radius = lerp(em.radius * (1 - em.radiusThick), em.radius, S.next());
        const x = Math.cos(arc) * radius * em.tf.s[0];
        const y = Math.sin(arc) * radius * em.tf.s[1];
        const z = 0; // emitFrom is never set from JSON (Base)
        const rand = [lerp(-em.randDir, em.randDir, globalNext()), lerp(-em.randDir, em.randDir, globalNext()), lerp(-em.randDir, em.randDir, globalNext())];
        const local = [x + rand[0], y + rand[1], z + rand[2]];
        const pn = vNorm(local); pn[2] = Math.cos(angle);
        direction = vRotate([pn[0] * Math.sin(angle), pn[1] * Math.sin(angle), pn[2]], qAll);
        emitPos = vAdd(vRotate(local, qAll), position);
      } else if (em.shape === 10) { // Circle
        let angle;
        if (em.arcMode === 1) {
          angle = this.emissionPosition * D2R;
          this.emissionPosition += ((mmEval(em.arcSpeed, Math.max(time - this.startTime, 0), 0, 0) * (time - this.startTime) * 360) % em.arc + em.arc) % em.arc;
        } else if (em.arcMode === 3) {
          angle = this.emissionPosition * D2R;
          this.emissionPosition += this.emissionInterval;
        } else {
          angle = lerp(0, em.arc * D2R, S.next());
        }
        const radius = lerp(em.radius * (1 - em.radiusThick), em.radius, S.next());
        const local = [Math.cos(angle) * radius * em.tf.s[0], Math.sin(angle) * radius * em.tf.s[1], 0];
        const rotated = vRotate(local, qAll);
        direction = rotated;
        emitPos = vAdd(rotated, position);
      } else if (em.shape === 0 || em.shape === 2) { // Sphere / Hemisphere
        const angle = lerp(0, em.arc * D2R, S.next());
        const angle2 = em.shape === 0 ? lerp(0, Math.PI, S.next()) : lerp(0, Math.PI / 2, S.next());
        const radius = lerp(em.radius * (1 - em.radiusThick), em.radius, S.next());
        const local = em.shape === 0
          ? [Math.cos(angle) * Math.sin(angle2) * radius * em.tf.s[0], Math.sin(angle) * radius * em.tf.s[1], Math.cos(angle) * Math.cos(angle2) * radius * em.tf.s[2]]
          : [Math.cos(angle) * Math.sin(angle2) * radius * em.tf.s[0], Math.sin(angle) * Math.sin(angle2) * radius * em.tf.s[1], Math.cos(angle2) * radius * em.tf.s[2]];
        const rotated = vRotate(local, qAll);
        direction = rotated;
        emitPos = vAdd(rotated, position);
      }
      direction = vNorm(direction);

      const p = this.particles[idx];
      p.alive = true;
      p.pos = emitPos;
      p.rot = vNeg(startRot);
      p.duration = mmEval(ref.life, 0, a, 0);
      p.spriteLerp = a; p.gravityLerp = h;
      p.startColor = mmColorEval(ref.color, 0, g);
      p.colorLerp = g;
      p.direction = direction;
      p.speed = speedLen;
      p.startTime = time; p.time = 0;
      const vr = this.rngVelocity.next();
      p.velocityLerp = vr; p.limitLerp = vr; p.forceLerp = vr;
      p.rotationLerp = e; p.sizeLerp = c;
      const startSize = ref.size.is3D ? mm3Eval(ref.size, 0, [c, cy, cz], 1) : mm3Eval(ref.size, 0, c, 1);
      p.scale = vMul(ref.tf.s, startSize);
      if (ref.simSpace === 1) { // World: bake the world transform in at emission
        const qShift = quatFromZYX(world.r);
        let m = matRotationQuat(qShift);
        m = matMul(m, matTranslation(world.p));
        const t4 = matTransform4(m, [p.pos[0], p.pos[1], p.pos[2], 1]);
        p.pos = [t4[0], t4[1], t4[2]];
        p.rot = vAdd(p.rot, world.r);
        p.direction = vRotate(p.direction, qShift);
      }
      p.flipRotation = globalNext() < ref.flip;
      this.aliveCount++;
    }
    updateEmission(world, time) {
      const ref = this.ref;
      if (!ref.loop && time >= this.startTime + ref.dur) return;
      if (this.rateOverTime > 0) {
        const interval = this.accumulator === 0 ? 0 : 1 / this.rateOverTime;
        const nextT = this.startTime + this.lastEmission + interval;
        if (time >= nextT) {
          this.emissionInterval = ref.em.arc / this.rateOverTime;
          this.accumulator++;
          this.lastEmission = time - this.startTime;
          this.emit(world, nextT);
        }
      }
      const bursts = ref.em.bursts || [];
      for (let i = 0; i < bursts.length; i++) {
        const rb = bursts[i], burst = this.bursts[i];
        if (time >= burst.nextReset) { burst.cycles = 0; burst.nextReset += ref.dur; }
        if (burst.cycles < rb[2] || rb[2] === 0) {
          const interval = burst.cycles === 0 ? 0 : rb[3];
          const nextBurst = burst.last + interval + rb[0] + this.startTime;
          if (time >= nextBurst) {
            this.emissionPosition = 0;
            this.emissionInterval = ref.em.arc / rb[1];
            burst.last = time - this.startTime;
            burst.cycles++;
            for (let j = 0; j < rb[1]; j++) this.emit(world, time);
          }
        }
      }
    }
    update(t, world) {
      const ref = this.ref;
      const qLocal = quatFromZYX(this.base.r);
      const qShift = quatFromZYX(world.r);
      const rotation = vAdd(this.base.r, ref.tf.r);
      const pivot = ref.rend.pivot;
      let worldOffset = matIdentity();
      if (ref.n === 'aura') worldOffset = matMul(worldOffset, matScaling(world.s));
      worldOffset = matMul(worldOffset, matRotationQuat(qShift));
      worldOffset = matMul(worldOffset, matTranslation(world.p));
      const isViewAligned = ref.rend.mode === 0 && ref.rend.align === 0;
      const isWorldAligned = ref.rend.mode === 0 && ref.rend.align === 1;

      this.updateEmission(world, t);

      for (const p of this.particles) {
        if (!p.alive) continue;
        const dt = t - p.startTime - p.time;
        p.time = t - p.startTime;
        const nt = p.time / p.duration;
        if (nt < 0) continue;
        if (p.time >= p.duration) { p.alive = false; this.aliveCount = Math.max(this.aliveCount - 1, 0); continue; }

        let curRot = (isViewAligned || isWorldAligned) ? p.rot.slice() : vAdd(rotation, p.rot);
        if (ref.rotLT) {
          const tmp = mm3Integrate(ref.rotLT, 0, nt, p.duration, p.rotationLerp);
          curRot = [curRot[0] - tmp[0], curRot[1] - tmp[1], curRot[2] - tmp[2]];
        }
        let curScale = p.scale.slice();
        let velScale = ref.tf.s.slice();
        if (ref.scaleMode === 0) { // Hierarchy
          curScale = vMul(curScale, this.base.s);
          velScale = vMul(velScale, this.base.s);
        }
        if (ref.sizeLT) {
          const sol = mm3Eval(ref.sizeLT, nt, p.sizeLerp, 1);
          curScale = vMul(curScale, sol);
        }
        let vel = [0, 0, 0];
        if (ref.vel) {
          let vol = mm3Eval(ref.vel.v, nt, p.velocityLerp, 0);
          if (ref.vel.space === 0) vol = vRotate(vol, qLocal);
          vel = vAdd(vel, vol);
        }
        if (ref.force) {
          let fol = mm3Integrate(ref.force.v, 0, nt, p.duration, p.forceLerp);
          if (ref.force.space === 0) fol = vRotate(fol, qLocal);
          vel = vAdd(vel, fol);
        }
        vel = vAdd(vel, vScale(p.direction, p.speed));
        const speedMod = mmEval(ref.speedMod, nt, p.velocityLerp, 1);
        const gravity = GRAVITY * mmEval(ref.grav, nt, p.gravityLerp, 0) * p.time;
        vel = vScale(vel, speedMod);
        vel = [vel[0] * velScale[0], vel[1] * velScale[1] - gravity, vel[2] * velScale[2]];
        // limitVelocityOverLifetime (dampen 0 in practice => identity)
        const lim = ref.limit ? mm3Eval(ref.limit.v, nt, p.limitLerp, 0) : [0, 0, 0];
        const damp = ref.limit ? ref.limit.dampen : 0;
        const k = Math.pow(1 - damp, p.time * 30);
        for (let ax = 0; ax < 3; ax++) {
          const av = Math.abs(vel[ax]);
          if (av > 0.0001 && av > lim[ax]) vel[ax] = (lim[ax] + (av - lim[ax]) * k) * (vel[ax] >= 0 ? 1 : -1);
        }
        p.pos = [p.pos[0] + vel[0] * dt, p.pos[1] + vel[1] * dt, p.pos[2] + vel[2] * dt];

        const rotFactor = p.flipRotation ? -1 : 1;
        let directionMatrix = matIdentity();
        const pivotScale = curScale.slice();
        if (ref.rend.mode === 0) { // Billboard
          if (ref.rend.align === 0) directionMatrix = INVERSE_VIEW;
        } else if (ref.rend.mode === 1) { // StretchedBillboard
          directionMatrix = rotateToDirection(ref, vel, curScale);
          curScale = [curScale[0], 1, curScale[2]];
        } else if (ref.rend.mode === 2) { // HorizontalBillboard
          curRot = [90 * rotFactor, 0, curRot[2]];
          curScale = vScale(curScale, BILLBOARD_SCALE);
        } else if (ref.rend.mode === 3) { // VerticalBillboard
          directionMatrix = INVERSE_VIEW;
          curScale = vScale(curScale, BILLBOARD_SCALE);
        }
        if (p.flipRotation) curRot = vNeg(curRot);
        let m = matScaling(curScale);
        m = matMul(m, matTranslation(vMul(pivot, pivotScale)));
        const m4rot = matRotationQuat(quatFromZYX(curRot));
        if (ref.rend.mode === 1) directionMatrix = matMul(directionMatrix, matInverse(m4rot));
        m = matMul(m, directionMatrix);
        m = matMul(m, m4rot);
        m = matMul(m, matTranslation(p.pos));
        if (ref.simSpace === 0) m = matMul(m, worldOffset); // Local
        p.matrix = m;
      }
      for (const ch of this.children) ch.update(t, world);
    }
  }

  // ---- EffectView (EffectView.cpp) ----------------------------------------
  const FX_NAMES = [
    'fx_lane_critical', 'fx_lane_critical_flick', 'fx_lane_default',
    'fx_note_normal_gen', 'fx_note_normal_aura',
    'fx_note_critical_normal_gen', 'fx_note_critical_normal_aura',
    'fx_note_flick_gen', 'fx_note_flick_aura',
    'fx_note_critical_flick_gen', 'fx_note_critical_flick_aura',
    'fx_note_long_gen', 'fx_note_long_aura',
    'fx_note_critical_long_gen', 'fx_note_critical_long_aura',
    'fx_note_flick_flash', 'fx_note_critical_flick_flash',
    'fx_note_long_hold_via_aura', 'fx_note_critical_long_hold_via_aura',
    'fx_note_trace_aura', 'fx_note_critical_trace_aura',
    'fx_note_hold_aura', 'fx_note_long_hold_gen',
    'fx_note_critical_long_hold_gen_aura', 'fx_note_critical_long_hold_gen',
  ];
  const T = { // EffectType indices
    LANE_CRIT: 0, LANE_CRIT_FLICK: 1, LANE_DEF: 2,
    N_GEN: 3, N_AURA: 4, CN_GEN: 5, CN_AURA: 6,
    F_GEN: 7, F_AURA: 8, CF_GEN: 9, CF_AURA: 10,
    L_GEN: 11, L_AURA: 12, CL_GEN: 13, CL_AURA: 14,
    F_FLASH: 15, CF_FLASH: 16, VIA: 17, C_VIA: 18,
    TRACE: 19, C_TRACE: 20, HOLD_AURA: 21, HOLD_GEN: 22,
    C_HOLD_GEN_AURA: 23, C_HOLD_GEN: 24,
  };
  const POOL_SIZES = {
    fx_note_normal_gen: 6, fx_note_critical_normal_gen: 6,
    fx_note_flick_gen: 6, fx_note_critical_flick_gen: 6,
    fx_note_long_gen: 6, fx_note_critical_long_gen: 6,
    fx_note_flick_flash: 6, fx_note_critical_flick_flash: 6,
    fx_note_trace_aura: 6, fx_note_critical_trace_aura: 6,
    fx_note_long_hold_via_aura: 6, fx_note_critical_long_hold_via_aura: 6,
  };
  const UNDER_TYPES = [T.LANE_CRIT, T.LANE_CRIT_FLICK, T.LANE_DEF, T.CF_AURA, T.CL_AURA, T.CN_AURA, T.F_AURA, T.L_AURA, T.N_AURA];
  const EFFECT_WIDTH_RATIO = 0.84, MAX_LANE = 11;
  const easeFn = (ease, a, b, t) => ease === 'easeIn' ? lerp(a, b, t * t)
    : ease === 'easeOut' ? lerp(a, b, 1 - (1 - t) * (1 - t)) : lerp(a, b, t);

  class Fx {
    constructor() {
      this.profile = 0;
      this.buildPools();
      this.score = null; this.noteList = [];
      this.played = new Set();
      this.curTime = 0; this.curTick = 0; this.flip = false;
    }
    buildPools() {
      this.pools = FX_NAMES.map((name) => {
        const size = POOL_SIZES[name] || 12;
        const list = [];
        for (let i = 0; i < size; i++) {
          const root = new Emitter(PROFILES[name]);
          root.init({ p: v3(), r: v3(), s: v3(1, 1, 1) });
          list.push({ refID: 0, timeMin: -1, timeMax: -1, world: { p: v3(), r: v3(), s: v3(1, 1, 1) }, root, active: false });
        }
        return { list, next: 0, count: size, getNext() { const c = this.list[this.next]; this.next = (this.next + 1) % this.count; return c; } };
      });
    }
    // Effect strength: the site's preview config switches between the two
    // bundled profiles (0 = full effects, 1 = 低特效 / low effects) and the
    // native engine reloads its particle definitions on a change
    // (ResourceManager::loadEmbeddedEffects). Mirror that: swap the data
    // set, rebuild every pool and drop live particles.
    setProfile(p) {
      const want = p === 1 ? 1 : 0;
      if (want === this.profile) return;
      const data = want === 1 ? window.MMW_FX_PROFILES_1 : window.MMW_FX_PROFILES;
      if (!data) return;
      this.profile = want;
      PROFILES = data;
      this.buildPools();
      this.played.clear();
    }
    setScore(score) {
      this.score = score;
      this.noteList = score ? [...score.notes.values()] : [];
      this.reset();
    }
    reset() {
      for (const pool of this.pools) for (const c of pool.list) {
        c.active = false; c.timeMin = -1; c.timeMax = -1; c.root.stop(true);
      }
      this.played.clear();
    }
    acc(tick) { return window.SekaiSUS.accumulateDuration(tick, this.score.tempos); }
    noteBound(note) {
      let left = note.lane - 6, right = left + note.width;
      if (this.flip) { const t = -left; left = -right; right = t; }
      return [left, right];
    }
    effectXPos(lane, width) {
      let l = lane;
      if (this.flip) l = MAX_LANE - l - width + 1;
      return (l - 6 + width / 2) * EFFECT_WIDTH_RATIO;
    }
    effectNoteCenter(note) {
      let l = note.lane;
      if (this.flip) l = MAX_LANE - l - note.width + 1;
      return (l - 6) + note.width / 2;
    }
    holdSegmentBound(note, curTick) {
      const score = this.score, notes = score.notes;
      const hold = score.holdNotes.get(note.id);
      const steps = hold.steps;
      let it = 0;
      while (it < steps.length && notes.get(steps[it].id).tick < curTick) it++;
      let startJoint = null;
      for (let i = it - 1; i >= 0; i--) if (!steps[i].passthrough) { startJoint = steps[i]; break; }
      const startNote = startJoint ? notes.get(startJoint.id) : note;
      const startEase = startJoint ? startJoint.ease : hold.start.ease;
      if (startNote.tick === curTick) return this.noteBound(startNote);
      const [lS, rS] = this.noteBound(startNote);
      let endNote = notes.get(hold.end);
      for (let i = it; i < steps.length; i++) if (!steps[i].passthrough) { endNote = notes.get(steps[i].id); break; }
      if (endNote.tick === curTick) return this.noteBound(endNote);
      const [lE, rE] = this.noteBound(endNote);
      const progress = unlerp(this.acc(startNote.tick), this.acc(endNote.tick), this.acc(curTick));
      return [easeFn(startEase, lS, lE, progress), easeFn(startEase, rS, rE, progress)];
    }
    holdStepBound(note) {
      const score = this.score, notes = score.notes;
      const hold = score.holdNotes.get(note.parentID);
      const steps = hold.steps;
      const idx = steps.findIndex((s) => s.id === note.id);
      if (idx < 0 || !steps[idx].passthrough) return this.noteBound(note);
      let sIdx = idx;
      while (sIdx !== 0 && steps[sIdx - 1].passthrough) sIdx--;
      const startStep = sIdx !== 0 ? steps[sIdx - 1] : null;
      const startNote = startStep ? notes.get(startStep.id) : notes.get(hold.start.id);
      const startEase = startStep ? startStep.ease : hold.start.ease;
      const [lS, rS] = this.noteBound(startNote);
      let endNote = notes.get(hold.end);
      for (let i = idx; i < steps.length; i++) if (!steps[i].passthrough) { endNote = notes.get(steps[i].id); break; }
      const [lE, rE] = this.noteBound(endNote);
      const progress = unlerp(this.acc(startNote.tick), this.acc(endNote.tick), this.acc(note.tick));
      return [easeFn(startEase, lS, lE, progress), easeFn(startEase, rS, rE, progress)];
    }
    play(c, note, start, end) {
      c.active = true; c.timeMin = start; c.timeMax = end; c.refID = note.id;
      c.root.stop(true);
      c.root.start(start);
    }
    addEffect(type, note, time) {
      const c = this.pools[type].getNext();
      let xPos = this.effectNoteCenter(note);
      let zRot = 0, start = time, end = -1;
      if (note.flick !== 'none' && (type === T.F_FLASH || type === T.CF_FLASH)) {
        zRot = note.flick === 'left' ? 15 : (note.flick === 'right' ? -15 : 0);
        if (this.flip) zRot *= -1;
      } else if (type === T.VIA || type === T.C_VIA) {
        const [l, r] = this.holdStepBound(note);
        xPos = l + (r - l) / 2;
      } else if (type === T.HOLD_GEN || type === T.C_HOLD_GEN) {
        const hold = this.score.holdNotes.get(note.id);
        start = this.acc(note.tick);
        end = this.acc(this.score.notes.get(hold.end).tick);
        if (Math.abs(end - start) < 0.01) return;
        const [l, r] = this.holdSegmentBound(note, this.curTick);
        xPos = l + (r - l) / 2;
      }
      c.world.p[0] = xPos * EFFECT_WIDTH_RATIO;
      c.world.r[2] = zRot;
      this.play(c, note, start, end);
    }
    addAuraEffect(type, note, time) {
      if (type === T.HOLD_AURA || type === T.C_HOLD_GEN_AURA) {
        const hold = this.score.holdNotes.get(note.id);
        const start = this.acc(note.tick);
        const end = this.acc(this.score.notes.get(hold.end).tick);
        if (Math.abs(end - start) < 0.01) return;
        const [l, r] = this.holdSegmentBound(note, this.curTick);
        const c = this.pools[type].getNext();
        c.world.p[0] = l + (r - l) / 2;
        this.play(c, note, start, end);
        return;
      }
      const pool = this.pools[type];
      for (let i = note.lane; i < note.lane + note.width; i++) {
        const c = pool.getNext();
        c.world.p[0] = this.effectXPos(i, 1);
        this.play(c, note, time, -1);
      }
    }
    addLaneEffect(type, note, time) {
      // Lane flash effects (fx_lane_*) are intentionally disabled: the
      // white lane glow is not wanted in this viewer (user request,
      // 2026-11-26). Note bursts/auras still play; only the lane streak
      // is suppressed.
      return;
    }
    addNoteEffects(note, time) {
      const score = this.score;
      const crit = note.critical;
      if (note.friction) {
        if (note.flick !== 'none') {
          if (crit) this.addLaneEffect(T.LANE_CRIT_FLICK, note, time);
          this.addEffect(crit ? T.CF_FLASH : T.F_FLASH, note, time);
        } else {
          this.addEffect(crit ? T.C_TRACE : T.TRACE, note, time);
        }
        if (note.type === 'hold') {
          this.addEffect(crit ? T.C_HOLD_GEN : T.HOLD_GEN, note, time);
          this.addAuraEffect(crit ? T.C_HOLD_GEN_AURA : T.HOLD_AURA, note, time);
        }
        return;
      }
      if (note.flick !== 'none') {
        this.addAuraEffect(crit ? T.CF_AURA : T.F_AURA, note, time);
        this.addEffect(crit ? T.CF_GEN : T.F_GEN, note, time);
        this.addEffect(crit ? T.CF_FLASH : T.F_FLASH, note, time);
        if (crit) this.addLaneEffect(T.LANE_CRIT_FLICK, note, time);
        return;
      }
      if (note.type === 'hold') {
        const hold = score.holdNotes.get(note.id);
        if (!hold || hold.startType === 'guide') return;
        if (hold.startType === 'normal') {
          this.addAuraEffect(crit ? T.CL_AURA : T.L_AURA, note, time);
          this.addEffect(crit ? T.CL_GEN : T.L_GEN, note, time);
          this.addLaneEffect(crit ? T.LANE_CRIT : T.LANE_DEF, note, time);
        }
        this.addEffect(crit ? T.C_HOLD_GEN : T.HOLD_GEN, note, time);
        this.addAuraEffect(crit ? T.C_HOLD_GEN_AURA : T.HOLD_AURA, note, time);
      } else if (note.type === 'holdMid') {
        const hold = score.holdNotes.get(note.parentID);
        if (!hold) return;
        const step = hold.steps.find((s) => s.id === note.id);
        if (step && step.type === 'hidden') return;
        this.addEffect(crit ? T.C_VIA : T.VIA, note, time);
      } else if (note.type === 'holdEnd') {
        const hold = score.holdNotes.get(note.parentID);
        if (!hold || hold.startType === 'guide') return;
        const endNote = score.notes.get(hold.end);
        if (endNote && !endNote.hideBase) {
          this.addAuraEffect(crit ? T.CL_AURA : T.L_AURA, note, time);
          this.addEffect(crit ? T.CL_GEN : T.L_GEN, note, time);
          this.addLaneEffect(crit ? T.LANE_CRIT : T.LANE_DEF, note, time);
        }
      } else {
        this.addAuraEffect(crit ? T.CN_AURA : T.N_AURA, note, time);
        this.addEffect(crit ? T.CN_GEN : T.N_GEN, note, time);
        this.addLaneEffect(crit ? T.LANE_CRIT : T.LANE_DEF, note, time);
      }
    }
    update(nowSec, currentTick, mirror) {
      if (!this.score) return;
      this.curTime = nowSec; this.curTick = currentTick; this.flip = !!mirror;
      const notes = this.score.notes;
      for (let i = this.noteList.length - 1; i >= 0; i--) {
        const note = this.noteList[i];
        if (this.played.has(note.id)) continue;
        let isMidHold = false;
        if (note.type === 'hold') {
          const hold = this.score.holdNotes.get(note.id);
          if (hold && hold.startType !== 'guide') {
            const end = notes.get(hold.end);
            if (end && currentTick >= note.tick && currentTick <= end.tick) isMidHold = true;
          }
        }
        const noteTime = this.acc(note.tick);
        if (isMidHold || (nowSec >= noteTime - 0.02 && nowSec <= noteTime + 0.04)) {
          this.addNoteEffects(note, noteTime);
          this.played.add(note.id);
        }
      }
      for (let i = 0; i < T.HOLD_AURA; i++) {
        for (const c of this.pools[i].list) if (c.active) c.root.update(nowSec, c.world);
      }
      for (let i = T.HOLD_AURA; i < FX_NAMES.length; i++) {
        for (const c of this.pools[i].list) {
          if (nowSec >= c.timeMax) c.active = false;
          if (!c.active) continue;
          const note = notes.get(c.refID);
          if (!note) continue;
          const [l, r] = this.holdSegmentBound(note, currentTick);
          if (i === T.HOLD_AURA || i === T.C_HOLD_GEN_AURA) c.world.s[0] = (r - l) * 0.95;
          c.world.p[0] = (l + (r - l) / 2) * EFFECT_WIDTH_RATIO;
          c.root.update(nowSec, c.world);
        }
      }
    }
    drawParticles(emitter, renderer, time, pass, proj, texSize) {
      const ref = emitter.ref;
      const drawThis = pass === 'under' ? ref.rend.order <= 5 : ref.rend.order > 5;
      if (drawThis) {
        const flipUVs = ref.rend.mode === 1;
        const sx = ref.tex.sx, sy = ref.tex.sy;
        const tw = texSize[0] / sx, th = texSize[1] / sy;
        for (const p of emitter.particles) {
          if (!p.alive || time < p.startTime || time > p.startTime + p.duration) continue;
          const nt = p.time / p.duration;
          let frame = Math.trunc(sx * sy * mmEval(ref.tex.startFrame, p.time, p.spriteLerp, 0));
          frame += Math.trunc(sx * sy * mmEval(ref.tex.frameOverTime, nt, p.spriteLerp, 0));
          const cl = mmColorEval(ref.colLT, nt, p.colorLerp);
          const col = [p.startColor[0] * cl[0], p.startColor[1] * cl[1], p.startColor[2] * cl[2], p.startColor[3] * cl[3]];
          const row = Math.floor(frame / sx), colI = frame % sx;
          const x1 = colI * tw, x2 = x1 + tw, y1 = row * th, y2 = y1 + th;
          const uvs = flipUVs
            ? [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }]
            : [{ x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
          const pos = [];
          for (const corner of [[0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5]]) {
            let v = matTransform4(p.matrix, [corner[0], corner[1], 0, 1]);
            v = matTransform4(VIEW, v);
            v = matTransform4(proj, v);
            const safeW = Math.abs(v[3]) > 0.000001 ? v[3] : 1;
            pos.push({ x: v[0] / safeW, y: v[1] / safeW, rw: 1 / safeW });
          }
          renderer.pushFxQuad(pass, pos, uvs, col[0], col[1], col[2], col[3], ref.blend === 1, ref.rend.order);
        }
      }
      for (const ch of emitter.children) this.drawParticles(ch, renderer, time, pass, proj, texSize);
    }
    emitUnder(renderer, time) {
      if (!this.score) return;
      const proj = projectionFor(renderer.canvas.width / Math.max(1, renderer.canvas.height));
      const texSize = renderer.texSizes[3];
      for (const type of UNDER_TYPES) {
        for (const c of this.pools[type].list) {
          if (c.active) this.drawParticles(c.root, renderer, time, 'under', proj, texSize);
        }
      }
    }
    emitOver(renderer, time) {
      if (!this.score) return;
      const proj = projectionFor(renderer.canvas.width / Math.max(1, renderer.canvas.height));
      const texSize = renderer.texSizes[3];
      const controllers = [];
      for (let i = 3; i < FX_NAMES.length; i++) {
        for (const c of this.pools[i].list) if (c.active) controllers.push(c);
      }
      controllers.sort((a, b) => a.timeMin - b.timeMin); // stable in JS
      for (const c of controllers) this.drawParticles(c.root, renderer, time, 'over', proj, texSize);
    }
  }

  window.SekaiFx = { Fx };
})();
