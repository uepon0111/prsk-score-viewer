// WebGL2 renderer: faithful JS port of sekai-mmw-preview-web's preview
// renderer (AGPL-3.0) — quad construction, sprite transforms, z-order and
// perspective math are ported from mmw_preview.cpp; the world transform and
// batching follow prsk-chart-viewer's mmwWebgl.ts. Stage placement constants
// were measured from the shipped stage.png (2048x1176): lane trapezoid
// halfW(y)=0.8341*y+43.97, center x=1023.5, judgement frame center y=805.
(function () {
  'use strict';
  const D = window.MMW_DATA;
  const NOTE_SPRITES = D.noteSprites, LONG_SPRITES = D.longSprites,
    TOUCH_SPRITES = D.touchSprites, TRANSFORMS = D.transforms;

  // Sprite indices (NoteSpriteIndex enum order)
  // Sprite indices into MMW_DATA.noteSprites. NOTE: the generated table keeps
  // the native resource order, in which the critical "among" diamonds come
  // BEFORE the normal ones (7 = long_among_crtcl, 8 = long_among,
  // 9 = friction_among_crtcl, 10 = friction_among_long) — mapping these by
  // name order instead swaps the normal/critical diamond colors.
  const SPR = {
    CRITICAL: 0, FLICK: 1, LONG: 2, TAP: 3, FRICTION: 4, FRICTION_CRITICAL: 5,
    FRICTION_FLICK: 6, LONG_AMONG: 8, LONG_AMONG_CRITICAL: 7, FRICTION_AMONG: 10,
    FRICTION_AMONG_CRITICAL: 9, FRICTION_AMONG_FLICK: 11,
    ARROW_01: 12, ARROW_CRIT_01: 24, SIMULTANEOUS: 36,
  };
  const TR = { NOTE_LEFT: 0, NOTE_MID: 1, NOTE_RIGHT: 2, DIAMOND: 3, ARROW_LEFT1: 4, ARROW_UP1: 10, SIMULT: 16, HOLD_TICK: 17 };
  const LAYER = { FLICK_ARROW: 0, DIAMOND: 1, BASE_NOTE: 2, TICK_NOTE: 3, HOLD_PATH: 4, GUIDE_PATH: 5, UNDER_FX: 6 };

  const MAX_FLICK = 6, NOTE_SIDE_WIDTH = 91, NOTE_SIDE_PAD = 10;
  const HOLD_XCUTOFF = 36, GUIDE_XCUTOFF = 3, GUIDE_Y_TOP = -41, GUIDE_Y_BOTTOM = -12;
  const STAGE_LANE_TOP = 47, STAGE_LANE_HEIGHT = 850, STAGE_LANE_WIDTH = 1420;
  const STAGE_TEX_H = 1176, TARGET_W = 1920, TARGET_H = 1080;
  const ZOOM = 927 / 800;
  const ASPECT = TARGET_W / TARGET_H;
  const WIDTH_RATIO = (ZOOM * STAGE_LANE_WIDTH) / (STAGE_TEX_H * ASPECT) / 12;
  const HEIGHT_RATIO = (ZOOM * STAGE_LANE_HEIGHT) / STAGE_TEX_H;
  const TOP_RATIO = 0.5 + (ZOOM * STAGE_LANE_TOP) / STAGE_TEX_H;
  const SCALED_ASPECT = (TARGET_W * WIDTH_RATIO) / (TARGET_H * HEIGHT_RATIO);
  const NOTE_HEIGHT = 75 / STAGE_LANE_HEIGHT / 2;

  // Measured stage.png placement (design px, 1920x1080 space)
  const IMG = { CX: 1023.5, VP_Y: -52.7, JUDGE_Y: 805, LANE_HALF: 710, W: 2048, H: 1176 };
  const laneHalfDesign = TARGET_W * WIDTH_RATIO * 6;         // 755.6
  const laneHeightDesign = TARGET_H * HEIGHT_RATIO;          // 904.5 (VP -> judge)
  const stageScaleX = (2 * laneHalfDesign) / (2 * IMG.LANE_HALF);
  const stageScaleY = laneHeightDesign / (IMG.JUDGE_Y - IMG.VP_Y);
  // y_ndc(1) = 2*TOP_RATIO - 2*HEIGHT_RATIO (refH=1080 units) -> design py (y down):
  const judgePy = ((1 - (2 * TOP_RATIO - 2 * HEIGHT_RATIO)) / 2) * TARGET_H;
  const stageQuad = {
    left: TARGET_W / 2 - IMG.CX * stageScaleX,
    top: judgePy - IMG.JUDGE_Y * stageScaleY,
    w: IMG.W * stageScaleX, h: IMG.H * stageScaleY,
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const unlerp = (a, b, v) => (b - a) === 0 ? 0 : (v - a) / (b - a);
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const approach = (start, end, cur) => Math.pow(1.06, 45 * lerp(-1, 0, unlerp(start, end, cur)));
  const laneToLeft = (lane) => lane - 6;
  const noteCenter = (n) => laneToLeft(n.lane) + n.width / 2;
  const easeVal = (ease, a, b, t) => {
    if (ease === 'easeIn') return lerp(a, b, t * t);
    if (ease === 'easeOut') return lerp(a, b, 1 - (1 - t) * (1 - t));
    return lerp(a, b, t);
  };
  const INT_MAX = 2147483647;
  function zIndex(layer, xOffset, yOffset) {
    const y = Math.floor(clamp(1 - yOffset, 0, 1) * 0xFFFFFF + 0.5);
    const x = Math.floor(clamp(xOffset / 12 + 0.5, 0, 1) * 12 + 0.5);
    return INT_MAX - ((layer & 0xF) * 268435456) - (y * 16) - (x & 0xF);
  }

  // ---- quad primitives (ports) -------------------------------------------
  const quadvPos = (left, right, top, bottom) => [
    { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }, { x: left, y: bottom }];
  const perspPos = (left, right, top, bottom) => [
    { x: right * top, y: top }, { x: right * bottom, y: bottom },
    { x: left * bottom, y: bottom }, { x: left * top, y: top }];
  const perspPos2 = (lS, lE, rS, rE, top, bottom) => [
    { x: rS * top, y: top }, { x: rE * bottom, y: bottom },
    { x: lE * bottom, y: bottom }, { x: lS * top, y: top }];
  const makeUv = (x1, x2, y1, y2) => [
    { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
  function applyTransform(index, input) {
    const t = TRANSFORMS[index];
    const xs = input.map((p) => p.x), ys = input.map((p) => p.y);
    const mul = (off, vec) => {
      const out = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c] += vec[r] * t[off + r * 4 + c];
      return out;
    };
    const txx = mul(0, xs), txy = mul(16, xs), tyy = mul(48, ys), tyx = mul(32, ys);
    return input.map((_, i) => ({ x: txx[i] + txy[i], y: tyx[i] + tyy[i] }));
  }
  const scaleQuad = (q, s) => q.map((p) => ({ x: p.x * s, y: p.y * s }));
  const translateScaleQuad = (q, tx, ty, s) => q.map((p) => ({ x: (p.x + tx) * s, y: (p.y + ty) * s }));

  function getNoteSpriteIndex(note) {
    if (note.friction) {
      if (note.critical) return SPR.FRICTION_CRITICAL;
      return note.flick !== 'none' ? SPR.FRICTION_FLICK : SPR.FRICTION;
    }
    if (note.type === 'holdMid') return note.critical ? SPR.LONG_AMONG_CRITICAL : SPR.LONG_AMONG;
    if (note.critical) return SPR.CRITICAL;
    if (note.flick !== 'none' && !note.dirOnly && note.type !== 'hold' && note.type !== 'holdMid') return SPR.FLICK;
    if (note.type === 'hold' || note.type === 'holdEnd') return SPR.LONG;
    return SPR.TAP;
  }
  function getFrictionSpriteIndex(note) {
    if (note.critical) return SPR.FRICTION_AMONG_CRITICAL;
    return note.flick !== 'none' ? SPR.FRICTION_AMONG_FLICK : SPR.FRICTION_AMONG;
  }
  // Flick arrow sprites by width (1..6). The generated table interleaves the
  // diagonal variants irregularly (native resource order), so use explicit
  // tables: normal straight/diagonal and critical straight/diagonal.
  const ARROW_TABLE = {
    nS: [12, 14, 16, 18, 20, 22], nD: [25, 27, 17, 19, 21, 23],
    cS: [24, 26, 28, 30, 32, 34], cD: [13, 15, 29, 31, 33, 35],
  };
  function getFlickArrowSpriteIndex(note) {
    const w = clamp(Math.min(note.width, 6), 1, 6) - 1;
    const diag = note.flick !== 'default';
    return note.critical ? (diag ? ARROW_TABLE.cD[w] : ARROW_TABLE.cS[w])
      : (diag ? ARROW_TABLE.nD[w] : ARROW_TABLE.nS[w]);
  }

  // ---- GL setup ------------------------------------------------------------
  const VS_ORTHO = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in float aW;
layout(location=2) in vec2 aUv; layout(location=3) in vec4 aColor; layout(location=4) in float aTex;
uniform vec2 uWorldScale; uniform float uScreenBias;
out vec2 vUv; out vec4 vColor; out float vTex;
void main(){ vUv=aUv; vColor=aColor; vTex=aTex;
  vec2 ndc = vec2(aPos.x*uWorldScale.x, aPos.y*uWorldScale.y + uScreenBias);
  gl_Position = vec4(ndc*aW, 0.0, aW); }`;
  const FS_TEX = `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vColor; in float vTex;
uniform sampler2D uTex0; uniform sampler2D uTex1; uniform sampler2D uTex2; uniform sampler2D uTex3;
out vec4 outColor;
void main(){ vec4 c; int t = int(vTex+0.5);
  if(t==0) c=texture(uTex0,vUv); else if(t==1) c=texture(uTex1,vUv);
  else if(t==2) c=texture(uTex2,vUv); else c=texture(uTex3,vUv);
  outColor = c * vColor; }`;
  const VS_IMG = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aUv;
uniform vec2 uRef; out vec2 vUv;
void main(){ vUv=aUv; gl_Position = vec4(aPos.x*2.0/uRef.x, -aPos.y*2.0/uRef.y, 0.0, 1.0); }`;
  const FS_IMG = `#version 300 es
precision mediump float; in vec2 vUv; uniform sampler2D uTex; uniform vec4 uTint;
out vec4 outColor; void main(){ outColor = texture(uTex, vUv) * uTint; }`;
  const VS_BG = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aUv; out vec2 vUv;
void main(){ vUv=aUv; gl_Position=vec4(aPos,0.0,1.0); }`;

  // Effect pass shaders (from sekai-mmw-preview-web's glRenderer.ts):
  // positions are projected NDC; aRw restores perspective-correct UVs.
  const VS_FX = `#version 300 es
precision mediump float;
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aUv;
layout(location=2) in vec4 aColor; layout(location=3) in float aRw;
out vec2 vUv; out vec4 vColor;
void main(){ vUv=aUv; vColor=aColor;
  float w = aRw != 0.0 ? (1.0 / aRw) : 1.0;
  gl_Position = vec4(aPos * w, 0.0, w); }`;
  const FS_FX = `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vColor; uniform sampler2D uTex; out vec4 outColor;
void main(){ vec4 tc = texture(uTex, vUv) * vColor;
  outColor = vec4(tc.rgb * tc.a, tc.a); }`;

  function fillRect(tw, th, srcAspect) {
    const ta = tw / th;
    const w = ta < srcAspect ? srcAspect * th : tw;
    const h = ta > srcAspect ? tw / srcAspect : th;
    return { width: w, height: h };
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 required');
      this.gl = gl;
      this.ortho = this.program(VS_ORTHO, FS_TEX, ['uWorldScale', 'uScreenBias', 'uTex0', 'uTex1', 'uTex2', 'uTex3']);
      this.img = this.program(VS_IMG, FS_IMG, ['uRef', 'uTex', 'uTint']);
      this.bg = this.program(VS_BG, FS_IMG, ['uTex', 'uTint']);
      this.vao = gl.createVertexArray();
      this.vbo = gl.createBuffer();
      this.ebo = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 10 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 20);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 36);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
      gl.bindVertexArray(null);
      this.imgVao = gl.createVertexArray();
      this.imgVbo = gl.createBuffer();
      gl.bindVertexArray(this.imgVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.imgVbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.bindVertexArray(null);
      gl.enable(gl.BLEND);
      this.textures = [null, null, null, null];
      this.texSizes = [[1, 1], [1, 1], [1, 1], [1, 1]];
      this.bgTexture = null; this.bgSize = [1, 1];
      this.stageTexture = null;
      this.indexCap = 0;
      this.worldScale = [1, 1]; this.screenBias = 0; this.ref = [1920, 1080];
      this.quads = [];
      // effect pass (MMW particle quads in NDC space)
      this.fxProg = this.program(VS_FX, FS_FX, ['uTex']);
      this.fxVao = gl.createVertexArray();
      this.fxVbo = gl.createBuffer();
      this.fxEbo = gl.createBuffer();
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVbo);
      const fxStride = 9 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, fxStride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, fxStride, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, fxStride, 16);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, fxStride, 32);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fxEbo);
      gl.bindVertexArray(null);
      this.fxIndexCap = 0;
      this.fxQuadsUnder = [];
      this.fxQuadsOver = [];
      this.fxOpacity = 1;
    }
    program(vs, fs, uniforms) {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
      return { p, u };
    }
    makeTexture(img) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      return t;
    }
    setSkinTextures(notesImg, longImg, touchImg) {
      this.textures[0] = this.makeTexture(notesImg);
      this.textures[1] = this.makeTexture(longImg);
      this.textures[2] = this.makeTexture(touchImg);
      this.texSizes[0] = [notesImg.width, notesImg.height];
      this.texSizes[1] = [longImg.width, longImg.height];
      this.texSizes[2] = [touchImg.width, touchImg.height];
    }
    setEffectTexture(img) {
      this.textures[3] = this.makeTexture(img);
      this.texSizes[3] = [img.width, img.height];
    }
    setStageTexture(img) { this.stageTexture = this.makeTexture(img); }
    setBackgroundTexture(img) {
      const gl = this.gl;
      if (this.bgTexture) gl.deleteTexture(this.bgTexture);
      this.bgTexture = this.makeTexture(img);
      this.bgSize = [img.width, img.height];
    }
    resize(cssW, cssH, dpr) {
      const gl = this.gl;
      this.canvas.width = Math.max(1, Math.round(cssW * dpr));
      this.canvas.height = Math.max(1, Math.round(cssH * dpr));
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      const ref = fillRect(TARGET_W, TARGET_H, this.canvas.width / this.canvas.height);
      this.ref = [ref.width, ref.height];
      const scaledW = TARGET_W * WIDTH_RATIO, scaledH = TARGET_H * HEIGHT_RATIO;
      const screenTop = TARGET_H * TOP_RATIO;
      this.worldScale = [(2 * scaledW) / ref.width, (-2 * scaledH) / ref.height];
      this.screenBias = (2 * screenTop) / ref.height;
    }
    ensureIndices(count) {
      if (count <= this.indexCap) return;
      const cap = Math.max(count, this.indexCap * 2, 1024);
      const idx = new Uint32Array(cap * 6);
      for (let q = 0, o = 0, v = 0; q < cap; q++, o += 6, v += 4) {
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
        idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.indexCap = cap;
    }

    // ---- per-frame quad building ------------------------------------------
    beginFrame() { this.quads.length = 0; }
    pushQuad(positions, uvRect, tex, r, g, b, a, z, blend) {
      const [tw, th] = this.texSizes[tex];
      const uvs = uvRect.map((p) => ({ x: p.x / tw, y: p.y / th }));
      this.quads.push({ positions, uvs, r, g, b, a, tex, z, blend: blend || 0 });
    }
    pushSpriteQuad(positions, sprite, tex, r, g, b, a, z, blend) {
      this.pushQuad(positions, makeUv(sprite[0], sprite[2], sprite[1], sprite[3]), tex, r, g, b, a, z, blend);
    }

    drawNoteBase(note, noteLeft, noteRight, y, zScalar, cfg, tint) {
      const sprite = NOTE_SPRITES[getNoteSpriteIndex(note)];
      const h = NOTE_HEIGHT;
      const noteTop = 1 - h, noteBottom = 1 + h;
      let L = noteLeft, R = noteRight;
      if (cfg.mirror) { const t = -L; L = -R; R = t; }
      const z = zIndex(note.friction ? LAYER.TICK_NOTE : LAYER.BASE_NOTE, L + (R - L) / 2, y * (zScalar || 1));
      const [tr, tg, tb] = tint || [1, 1, 1];
      const mid = scaleQuad(applyTransform(TR.NOTE_MID, perspPos(L + 0.25, R - 0.3, noteTop, noteBottom)), y);
      this.pushQuad(mid, makeUv(sprite[0] + NOTE_SIDE_WIDTH, sprite[2] - NOTE_SIDE_WIDTH, sprite[1], sprite[3]), 0, tr, tg, tb, 1, z);
      const left = scaleQuad(applyTransform(TR.NOTE_LEFT, perspPos(L, L + 0.25, noteTop, noteBottom)), y);
      this.pushQuad(left, makeUv(sprite[0] + NOTE_SIDE_PAD, sprite[0] + NOTE_SIDE_WIDTH, sprite[1], sprite[3]), 0, tr, tg, tb, 1, z);
      const right = scaleQuad(applyTransform(TR.NOTE_RIGHT, perspPos(R - 0.3, R, noteTop, noteBottom)), y);
      this.pushQuad(right, makeUv(sprite[2] - NOTE_SIDE_WIDTH, sprite[2] - NOTE_SIDE_PAD, sprite[1], sprite[3]), 0, tr, tg, tb, 1, z);
    }
    drawTraceDiamond(note, noteLeft, noteRight, y, cfg) {
      const sprite = NOTE_SPRITES[getFrictionSpriteIndex(note)];
      const w = NOTE_HEIGHT / SCALED_ASPECT;
      let L = noteLeft, R = noteRight;
      if (cfg.mirror) { const t = -L; L = -R; R = t; }
      const center = L + (R - L) / 2;
      const z = zIndex(LAYER.DIAMOND, center, y);
      const quad = scaleQuad(applyTransform(TR.DIAMOND, quadvPos(center - w, center + w, 1 + NOTE_HEIGHT, 1 - NOTE_HEIGHT)), y);
      this.pushSpriteQuad(quad, sprite, 0, 1, 1, 1, 1, z);
    }
    drawFlickArrow(note, y, time, cfg) {
      const sprite = NOTE_SPRITES[getFlickArrowSpriteIndex(note)];
      const tIdx = clamp(note.width, 1, MAX_FLICK) - 1 + (note.flick === 'left' || note.flick === 'right' ? TR.ARROW_LEFT1 : TR.ARROW_UP1);
      const mirror = cfg.mirror ? -1 : 1;
      const direction = mirror * (note.flick === 'left' ? -1 : (note.flick === 'right' ? 1 : 0));
      const center = noteCenter(note) * mirror;
      const w = clamp(note.width, 0, MAX_FLICK) * (note.flick === 'right' ? -1 : 1) * mirror / 4;
      const base = applyTransform(tIdx, quadvPos(center - w, center + w, 1, 1 - 2 * Math.abs(w) * SCALED_ASPECT));
      const z = zIndex(LAYER.FLICK_ARROW, center, y);
      if (cfg.flickAnimation) {
        const t = (time % 0.5) / 0.5;
        const anim = translateScaleQuad(base, direction * t, -2 * SCALED_ASPECT * t, y);
        const alpha = 1 - t * t * t;
        this.pushSpriteQuad(anim, sprite, 0, 1, 1, 1, alpha, z);
      } else {
        this.pushSpriteQuad(scaleQuad(base, y), sprite, 0, 1, 1, 1, 1, z);
      }
    }
    drawLines(nowScaled, cfg) {
      if (!cfg.simultaneousLine) return;
      const sprite = NOTE_SPRITES[SPR.SIMULTANEOUS];
      for (const line of this.drawData.drawingLines) {
        if (nowScaled < line.visualTime.min || nowScaled > line.visualTime.max) continue;
        let L = line.xPos.min, R = line.xPos.max;
        if (cfg.mirror) { const t = -L; L = -R; R = t; }
        const y = approach(line.visualTime.min, line.visualTime.max, nowScaled);
        if (cfg.apMin && y < cfg.apMin) continue;
        const quad = scaleQuad(applyTransform(TR.SIMULT, perspPos(L, R, 1 + NOTE_HEIGHT, 1 - NOTE_HEIGHT)), y);
        this.pushSpriteQuad(quad, sprite, 0, 1, 1, 1, 1, zIndex(LAYER.UNDER_FX, 0, y));
      }
    }
    drawHoldTicks(nowScaled, cfg) {
      for (const tick of this.drawData.drawingHoldTicks) {
        if (nowScaled < tick.visualTime.min || nowScaled > tick.visualTime.max) continue;
        const note = this.score.notes.get(tick.refID);
        if (!note) continue;
        const sprite = NOTE_SPRITES[getNoteSpriteIndex(note)];
        const y = approach(tick.visualTime.min, tick.visualTime.max, nowScaled);
        if (cfg.apMin && y < cfg.apMin) continue;
        const h = NOTE_HEIGHT * 1.3;
        const w = h / SCALED_ASPECT;
        const center = tick.center * (cfg.mirror ? -1 : 1);
        const quad = scaleQuad(applyTransform(TR.HOLD_TICK, quadvPos(center - w, center + w, 1 + h, 1 - h)), y);
        this.pushSpriteQuad(quad, sprite, 0, 1, 1, 1, 1, zIndex(LAYER.DIAMOND, center, y));
      }
    }
    drawNotes(nowSec, nowScaled, cfg) {
      for (const drawing of this.drawData.drawingNotes) {
        if (nowScaled < drawing.visualTime.min || nowScaled > drawing.visualTime.max) continue;
        const note = this.score.notes.get(drawing.refID);
        if (!note) continue;
        const y = approach(drawing.visualTime.min, drawing.visualTime.max, nowScaled);
        if (cfg.apMin && y < cfg.apMin) continue;
        const L = laneToLeft(note.lane), R = L + note.width;
        if (note.skip) {
          // decorative skip notes: greyed base only
          const sprite = NOTE_SPRITES[SPR.TAP];
          const h = NOTE_HEIGHT;
          const quad = scaleQuad(perspPos(L, R, 1 - h, 1 + h), y);
          this.pushSpriteQuad(quad, sprite, 0, 0.45, 0.45, 0.5, 0.85, zIndex(LAYER.BASE_NOTE, L + note.width / 2, y));
          continue;
        }
        if (!note.hideBase) this.drawNoteBase(note, L, R, y, 1, cfg, note.damage ? [0.63, 0.5, 0.92] : undefined);
        if (note.friction) this.drawTraceDiamond(note, L, R, y, cfg);
        if (note.flick !== 'none' && note.type !== 'hold' && note.type !== 'holdMid') {
          this.drawFlickArrow(note, y, nowSec, cfg);
        }
      }
    }
    drawHoldSegments(nowSec, nowScaled, cfg) {
      const score = this.score;
      const totalTime = Math.max(window.SekaiSUS.accumulateDuration(this.drawData.maxTicks, score.tempos), 0.0001);
      const mirror = cfg.mirror ? -1 : 1;
      for (const seg of this.drawData.drawingHoldSegments) {
        const visibleScaled = nowScaled + seg.visibleDuration;
        if ((Math.min(seg.headTime, seg.tailTime) > visibleScaled && seg.startTime > nowSec) || nowSec >= seg.endTime) continue;
        const holdEnd = score.notes.get(seg.endID);
        const holdStart = score.notes.get(holdEnd.parentID >= 0 ? holdEnd.parentID : seg.endID);
        if (!holdStart) continue;
        const holdStartCenter = noteCenter(holdStart) * mirror;
        const holdActivated = nowSec >= seg.activeTime;
        const segActivated = nowSec >= seg.startTime;
        const critical = seg.critical;
        const tex = seg.isGuide ? 2 : 1;
        const atlas = seg.isGuide ? TOUCH_SPRITES : LONG_SPRITES;
        const spriteIndex = critical ? 3 : 1;
        const sprite = atlas[spriteIndex];
        const headScaled = Math.min(seg.headTime, seg.tailTime);
        const tailScaled = Math.max(seg.headTime, seg.tailTime);
        const startScaled = Math.max(headScaled, nowScaled);
        const endScaled = Math.min(tailScaled, visibleScaled);
        if (endScaled <= startScaled && !segActivated) continue;
        let startProgress, endProgress;
        if (!segActivated) {
          startProgress = 0;
          endProgress = unlerp(headScaled, tailScaled, endScaled);
        } else {
          startProgress = unlerp(seg.startTime, seg.endTime, nowSec);
          endProgress = lerp(startProgress, 1, unlerp(nowScaled, tailScaled, endScaled));
        }
        let steps = (seg.ease === 'linear' ? 10 : 15) +
          Math.floor(Math.log(Math.max((endScaled - startScaled) / seg.visibleDuration, 4.5399e-5)) + 0.5);
        steps = Math.max(steps, 1);
        let startLeft = seg.headLeft, startRight = seg.headRight, endLeft = seg.tailLeft, endRight = seg.tailRight;
        const hold = score.holdNotes.get(holdStart.id);
        if (segActivated && hold && hold.startType === 'normal') {
          const l = easeVal(seg.ease, startLeft, endLeft, startProgress);
          const r = easeVal(seg.ease, startRight, endRight, startProgress);
          this.drawNoteBase(holdStart, l, r, 1, seg.activeTime / totalTime, cfg);
          if (holdStart.friction) this.drawTraceDiamond(holdStart, l, r, 1, cfg);
        }
        if (cfg.mirror) {
          let t = -startLeft; startLeft = -startRight; startRight = t;
          t = -endLeft; endLeft = -endRight; endRight = t;
        }
        let holdStartProgress = 0, holdEndProgress = 0;
        if (seg.isGuide && hold) {
          const totalJoints = 1 + hold.steps.length;
          const headP = seg.tailStepIndex / totalJoints;
          const tailP = (seg.tailStepIndex + 1) / totalJoints;
          if (!segActivated) {
            holdStartProgress = headP;
            holdEndProgress = lerp(headP, tailP, unlerp(headScaled, tailScaled, endScaled));
          } else {
            holdStartProgress = lerp(headP, tailP, unlerp(seg.startTime, seg.endTime, nowSec));
            holdEndProgress = lerp(holdStartProgress, tailP, unlerp(nowScaled, seg.tailTime, endScaled));
          }
        }
        let fromPct = 0;
        let stepStartScaled = startScaled;
        let stepTop = approach(stepStartScaled - seg.visibleDuration, stepStartScaled, nowScaled);
        const apMin = cfg.apMin || 0;
        let stepStartProgress = startProgress;
        const alpha = seg.isGuide ? cfg.guideAlpha : cfg.holdAlpha;
        const z = zIndex(seg.isGuide ? LAYER.GUIDE_PATH : LAYER.HOLD_PATH, holdStartCenter, seg.activeTime / totalTime);
        for (let i = 0; i < steps; i++) {
          if (stepTop <= apMin) break; // beyond the display-start cutoff
          const toPct = (i + 1) / steps;
          const stepEndScaled = lerp(startScaled, endScaled, toPct);
          const stepBottom = Math.max(approach(stepEndScaled - seg.visibleDuration, stepEndScaled, nowScaled), apMin);
          const stepEndProgress = lerp(startProgress, endProgress, toPct);
          const sL = easeVal(seg.ease, startLeft, endLeft, stepStartProgress);
          const eL = easeVal(seg.ease, startLeft, endLeft, stepEndProgress);
          const sR = easeVal(seg.ease, startRight, endRight, stepStartProgress);
          const eR = easeVal(seg.ease, startRight, endRight, stepEndProgress);
          const positions = perspPos2(sL, eL, sR, eR, stepTop, stepBottom);
          let x1 = sprite[0], x2 = sprite[2], y1 = sprite[1], y2 = sprite[3];
          if (seg.isGuide) {
            x1 += GUIDE_XCUTOFF; x2 -= GUIDE_XCUTOFF;
            const yA = sprite[3] - GUIDE_Y_BOTTOM, yB = sprite[1] + GUIDE_Y_TOP;
            y1 = lerp(yA, yB, lerp(holdStartProgress, holdEndProgress, fromPct));
            y2 = lerp(yA, yB, lerp(holdStartProgress, holdEndProgress, toPct));
          } else {
            x1 += HOLD_XCUTOFF; x2 -= HOLD_XCUTOFF;
          }
          const uvs = makeUv(x1, x2, y1, y2);
          if (cfg.holdAnimation && holdActivated && spriteIndex - 1 >= 0) {
            const active = atlas[spriteIndex - 1];
            const normalAlpha = (Math.cos((nowSec - seg.activeTime) * Math.PI * 2) + 2) / 3;
            this.pushQuad(positions, uvs, tex, 1, 1, 1, alpha * normalAlpha, z);
            const dy = active[1] - sprite[1];
            this.pushQuad(positions, makeUv(x1, x2, y1 + dy, y2 + dy), tex, 1, 1, 1, alpha * (1 - normalAlpha), z);
          } else {
            this.pushQuad(positions, uvs, tex, 1, 1, 1, alpha, z);
          }
          fromPct = toPct;
          stepStartScaled = stepEndScaled;
          stepTop = stepBottom;
          stepStartProgress = stepEndProgress;
        }
      }
    }

    // ---- passes -------------------------------------------------------------
    drawBackgroundPass(cfg) {
      if (!this.bgTexture) return;
      const gl = this.gl;
      gl.useProgram(this.bg.p);
      gl.uniform1i(this.bg.u.uTex, 0);
      gl.uniform4f(this.bg.u.uTint, cfg.backgroundBrightness, cfg.backgroundBrightness, cfg.backgroundBrightness, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bgTexture);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const [iw, ih] = this.bgSize;
      const imgAspect = iw / ih, canvasAspect = this.canvas.width / this.canvas.height;
      let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
      if (canvasAspect > imgAspect) { const s = imgAspect / canvasAspect; v0 = (1 - s) / 2; v1 = 1 - v0; }
      else { const s = canvasAspect / imgAspect; u0 = (1 - s) / 2; u1 = 1 - u0; }
      const verts = new Float32Array([
        -1, -1, u0, v1, 1, -1, u1, v1, 1, 1, u1, v0,
        -1, -1, u0, v1, 1, 1, u1, v0, -1, 1, u0, v0]);
      gl.bindVertexArray(this.imgVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.imgVbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }
    drawStagePass(cfg) {
      if (!this.stageTexture) return;
      const gl = this.gl;
      // stage cover: translucent black over the stage rect first
      gl.useProgram(this.img.p);
      gl.uniform2f(this.img.u.uRef, this.ref[0], this.ref[1]);
      gl.uniform1i(this.img.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      const cx = stageQuad.left + stageQuad.w / 2 - TARGET_W / 2;
      const cy = stageQuad.top + stageQuad.h / 2 - TARGET_H / 2;
      const hw = stageQuad.w / 2, hh = stageQuad.h / 2;
      const quad = (tint, tex) => {
        gl.uniform4f(this.img.u.uTint, tint[0], tint[1], tint[2], tint[3]);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const verts = new Float32Array([
          cx - hw, cy - hh, 0, 0, cx + hw, cy - hh, 1, 0, cx + hw, cy + hh, 1, 1,
          cx - hw, cy - hh, 0, 0, cx + hw, cy + hh, 1, 1, cx - hw, cy + hh, 0, 1]);
        gl.bindVertexArray(this.imgVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.imgVbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
      };
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (cfg.stageCover > 0) {
        // 1x1 black texture via stage texture is wrong; use tint on stage tex with alpha 0 skip:
        // draw cover using the stage texture itself darkened is not possible; use a solid pass:
        this.drawSolidQuad(cx, cy, hw, hh, 0, 0, 0, cfg.stageCover * 0.9);
      }
      quad([1, 1, 1, cfg.stageOpacity], this.stageTexture);
    }
    drawSolidQuad(cx, cy, hw, hh, r, g, b, a) {
      const gl = this.gl;
      if (!this.solidTexture) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.solidTexture = t;
      }
      gl.useProgram(this.img.p);
      gl.uniform2f(this.img.u.uRef, this.ref[0], this.ref[1]);
      gl.uniform1i(this.img.u.uTex, 0);
      gl.uniform4f(this.img.u.uTint, r, g, b, a);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.solidTexture);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const verts = new Float32Array([
        cx - hw, cy - hh, 0, 0, cx + hw, cy - hh, 1, 0, cx + hw, cy + hh, 1, 1,
        cx - hw, cy - hh, 0, 0, cx + hw, cy + hh, 1, 1, cx - hw, cy + hh, 0, 1]);
      gl.bindVertexArray(this.imgVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.imgVbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }
    flushQuads() {
      const gl = this.gl;
      const quads = this.quads;
      if (!quads.length) return;
      quads.sort((a, b) => a.z - b.z);
      this.ensureIndices(quads.length);
      const data = new Float32Array(quads.length * 40);
      let o = 0;
      for (const q of quads) {
        for (let i = 0; i < 4; i++) {
          data[o++] = q.positions[i].x;
          data[o++] = q.positions[i].y;
          data[o++] = 1.0; // reciprocalW: note quads are affine (native packQuads default)
          data[o++] = q.uvs[i].x;
          data[o++] = q.uvs[i].y;
          data[o++] = q.r; data[o++] = q.g; data[o++] = q.b; data[o++] = q.a;
          data[o++] = q.tex;
        }
      }
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.useProgram(this.ortho.p);
      gl.uniform2f(this.ortho.u.uWorldScale, this.worldScale[0], this.worldScale[1]);
      gl.uniform1f(this.ortho.u.uScreenBias, this.screenBias);
      for (let t = 0; t < 4; t++) {
        gl.activeTexture(gl.TEXTURE0 + t);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[t]);
        gl.uniform1i(this.ortho.u['uTex' + t], t);
      }
      // batch by (tex, blend)
      let start = 0;
      const setBlend = (mode) => {
        if (mode === 2) gl.blendFunc(gl.ONE, gl.ONE);
        else if (mode === 1) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      };
      let curTex = quads[0].tex, curBlend = quads[0].blend;
      setBlend(curBlend);
      for (let i = 1; i <= quads.length; i++) {
        if (i === quads.length || quads[i].tex !== curTex || quads[i].blend !== curBlend) {
          gl.drawElements(gl.TRIANGLES, (i - start) * 6, gl.UNSIGNED_INT, start * 6 * 4);
          if (i < quads.length) {
            start = i; curTex = quads[i].tex; curBlend = quads[i].blend;
            setBlend(curBlend);
          }
        }
      }
      gl.bindVertexArray(null);
    }

    // ---- effect quads (NDC positions + reciprocal W, effect texture) ------
    pushFxQuad(pass, positions, uvRect, r, g, b, a, additive, order) {
      const [tw, th] = this.texSizes[3];
      const uvs = uvRect.map((p) => ({ x: p.x / tw, y: p.y / th }));
      const q = { positions, uvs, r, g, b, a: a * this.fxOpacity, additive: !!additive, order };
      (pass === 'under' ? this.fxQuadsUnder : this.fxQuadsOver).push(q);
    }
    ensureFxIndices(count) {
      if (count <= this.fxIndexCap) return;
      const cap = Math.max(count, this.fxIndexCap * 2, 1024);
      const idx = new Uint32Array(cap * 6);
      for (let q = 0, o = 0, v = 0; q < cap; q++, o += 6, v += 4) {
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
        idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      const gl = this.gl;
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.fxEbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.fxIndexCap = cap;
    }
    flushFx(quads) {
      if (!quads.length) return;
      const gl = this.gl;
      quads.sort((a, b) => a.order - b.order); // stable: keeps emission order within an order value
      this.ensureFxIndices(quads.length);
      const data = new Float32Array(quads.length * 36);
      let o = 0;
      for (const q of quads) {
        for (let i = 0; i < 4; i++) {
          data[o++] = q.positions[i].x;
          data[o++] = q.positions[i].y;
          data[o++] = q.uvs[i].x;
          data[o++] = q.uvs[i].y;
          data[o++] = q.r; data[o++] = q.g; data[o++] = q.b; data[o++] = q.a;
          data[o++] = q.positions[i].rw;
        }
      }
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.useProgram(this.fxProg.p);
      gl.uniform1i(this.fxProg.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
      let start = 0;
      let curAdd = quads[0].additive;
      const setBlend = (add) => {
        if (add) gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      };
      setBlend(curAdd);
      for (let i = 1; i <= quads.length; i++) {
        if (i === quads.length || quads[i].additive !== curAdd) {
          gl.drawElements(gl.TRIANGLES, (i - start) * 6, gl.UNSIGNED_INT, start * 6 * 4);
          if (i < quads.length) { start = i; curAdd = quads[i].additive; setBlend(curAdd); }
        }
      }
      gl.bindVertexArray(null);
    }

    render(state) {
      const { score, drawData, cfg, nowSec, nowScaled, fx } = state;
      this.score = score; this.drawData = drawData;
      const gl = this.gl;
      gl.clearColor(0.008, 0.012, 0.03, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawBackgroundPass(cfg);
      this.drawStagePass(cfg);
      this.fxOpacity = cfg.effectOpacity != null ? cfg.effectOpacity : 1;
      this.fxQuadsUnder.length = 0;
      this.fxQuadsOver.length = 0;
      if (fx) fx.emitUnder(this, nowSec);
      this.flushFx(this.fxQuadsUnder);
      this.beginFrame();
      this.drawHoldSegments(nowSec, nowScaled, cfg);
      this.drawLines(nowScaled, cfg);
      this.drawHoldTicks(nowScaled, cfg);
      this.drawNotes(nowSec, nowScaled, cfg);
      this.flushQuads();
      if (fx) fx.emitOver(this, nowSec);
      this.flushFx(this.fxQuadsOver);
    }
  }

  window.SekaiRenderer = { Renderer, STAGE_QUAD: stageQuad, NOTE_HEIGHT, SCALED_ASPECT };
})();
