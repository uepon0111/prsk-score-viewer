// Background composition.
// Primary path (composeV3Background): a faithful port of the original
// site's overlay background generator (sekai-mmw-preview-web,
// src/lib/overlayBackgroundGen.ts, renderV3). The jacket (cover) is used
// WHOLE — never cropped — and homography-warped into six window panels of
// the room background (center, center floor-reflection, left/right and
// their reflections), composited with the generator's cover/mask/window
// assets, then tiled into the 2048x2048 square background texture.
// Fallback (composeBackground): the older approximation — the game's
// default room image with the jacket cover-cropped into a center window —
// used only when the V3 assets cannot be loaded.
(function () {
  'use strict';

  // ---- V3 generator port -------------------------------------------------
  const MORPH_LEFT_NORMAL = [[566, 161], [1183, 134], [633, 731], [1226, 682]];
  const MORPH_RIGHT_NORMAL = [[966, 104], [1413, 72], [954, 525], [1390, 524]];
  const MORPH_LEFT_MIRROR = [[633, 1071], [1256, 1045], [598, 572], [1197, 569]];
  const MORPH_RIGHT_MIRROR = [[954, 1122], [1393, 1167], [942, 702], [1366, 717]];
  const MORPH_CENTER_NORMAL = [[824, 227], [1224, 227], [833, 608], [1216, 608]];
  const MORPH_CENTER_MIRROR = [[830, 1017], [1214, 1017], [833, 676], [1216, 676]];

  function toImageData(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) };
  }
  function blankImage(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  function cloneImage(s) { return { width: s.width, height: s.height, data: new Uint8ClampedArray(s.data) }; }

  function resizeNearest(source, targetWidth, targetHeight) {
    const width = Math.max(1, targetWidth), height = Math.max(1, targetHeight);
    const target = blankImage(width, height);
    const sd = source.data, td = target.data, sw = source.width, sh = source.height;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / width));
        const so = (sy * sw + sx) * 4, dofs = (y * width + x) * 4;
        td[dofs] = sd[so]; td[dofs + 1] = sd[so + 1]; td[dofs + 2] = sd[so + 2]; td[dofs + 3] = sd[so + 3];
      }
    }
    return target;
  }

  function overlayImage(base, top, offsetX, offsetY) {
    const bd = base.data, td = top.data, bw = base.width, bh = base.height, tw = top.width, th = top.height;
    for (let y = 0; y < th; y++) {
      const ty = y + offsetY;
      if (ty < 0 || ty >= bh) continue;
      for (let x = 0; x < tw; x++) {
        const tx = x + offsetX;
        if (tx < 0 || tx >= bw) continue;
        const si = (y * tw + x) * 4, di = (ty * bw + tx) * 4;
        const sa = td[si + 3];
        if (sa === 0) continue;
        const da = bd[di + 3];
        if (da === 0 || sa === 255) {
          bd[di] = td[si]; bd[di + 1] = td[si + 1]; bd[di + 2] = td[si + 2]; bd[di + 3] = sa;
          continue;
        }
        const saf = sa / 255, daf = da / 255;
        const outA = saf + daf * (1 - saf);
        bd[di] = Math.round(((td[si] / 255) * saf + (bd[di] / 255) * daf * (1 - saf)) / outA * 255);
        bd[di + 1] = Math.round(((td[si + 1] / 255) * saf + (bd[di + 1] / 255) * daf * (1 - saf)) / outA * 255);
        bd[di + 2] = Math.round(((td[si + 2] / 255) * saf + (bd[di + 2] / 255) * daf * (1 - saf)) / outA * 255);
        bd[di + 3] = Math.round(outA * 255);
      }
    }
  }

  function applyAlphaMask(image, mask) {
    const masked = cloneImage(image);
    const len = Math.min(masked.data.length, mask.data.length);
    for (let i = 3; i < len; i += 4) masked.data[i] = Math.min(masked.data[i], mask.data[i]);
    return masked;
  }

  function solveLinear8(matrix, values) {
    const size = 8;
    const left = matrix.map((r) => [...r]);
    const right = [...values];
    for (let pivot = 0; pivot < size; pivot++) {
      let maxRow = pivot, maxValue = Math.abs(left[pivot][pivot]);
      for (let row = pivot + 1; row < size; row++) {
        const v = Math.abs(left[row][pivot]);
        if (v > maxValue) { maxValue = v; maxRow = row; }
      }
      if (maxValue < 1e-8) return null;
      if (maxRow !== pivot) {
        const tr = left[pivot]; left[pivot] = left[maxRow]; left[maxRow] = tr;
        const tv = right[pivot]; right[pivot] = right[maxRow]; right[maxRow] = tv;
      }
      const pv = left[pivot][pivot];
      for (let col = pivot; col < size; col++) left[pivot][col] /= pv;
      right[pivot] /= pv;
      for (let row = 0; row < size; row++) {
        if (row === pivot) continue;
        const f = left[row][pivot];
        if (Math.abs(f) < 1e-8) continue;
        for (let col = pivot; col < size; col++) left[row][col] -= f * left[pivot][col];
        right[row] -= f * right[pivot];
      }
    }
    return right;
  }
  function buildHomography(source, target) {
    const matrix = [], values = [];
    for (let i = 0; i < 4; i++) {
      const sx = source[i][0], sy = source[i][1], tx = target[i][0], ty = target[i][1];
      matrix.push([sx, sy, 1, 0, 0, 0, -sx * tx, -sy * tx]); values.push(tx);
      matrix.push([0, 0, 0, sx, sy, 1, -sx * ty, -sy * ty]); values.push(ty);
    }
    const s = solveLinear8(matrix, values);
    if (!s) return null;
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
  }
  function invert3x3(m) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-10) return null;
    const r = 1 / det;
    return [A * r, D * r, G * r, B * r, E * r, H * r, C * r, F * r, I * r];
  }

  function morph(sourceImage, quad, targetW, targetH) {
    const minX = Math.min(...quad.map((p) => p[0])), minY = Math.min(...quad.map((p) => p[1]));
    const maxX = Math.max(...quad.map((p) => p[0])), maxY = Math.max(...quad.map((p) => p[1]));
    const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
    const minImage = resizeNearest(sourceImage, width, height);
    const localQuad = quad.map(([x, y]) => [x - minX, y - minY]);
    const sourcePoints = [[0, 0], [width, 0], [0, height], [width, height]];
    const projection = buildHomography(sourcePoints, localQuad);
    if (!projection) return blankImage(targetW, targetH);
    const inv = invert3x3(projection);
    if (!inv) return blankImage(targetW, targetH);
    const projected = blankImage(width, height);
    const md = minImage.data, pd = projected.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const den = inv[6] * x + inv[7] * y + inv[8];
        if (Math.abs(den) < 1e-8) continue;
        const sx = Math.round((inv[0] * x + inv[1] * y + inv[2]) / den);
        const sy = Math.round((inv[3] * x + inv[4] * y + inv[5]) / den);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const so = (sy * width + sx) * 4, dofs = (y * width + x) * 4;
        pd[dofs] = md[so]; pd[dofs + 1] = md[so + 1]; pd[dofs + 2] = md[so + 2]; pd[dofs + 3] = md[so + 3];
      }
    }
    const target = blankImage(targetW, targetH);
    overlayImage(target, projected, minX, minY);
    return target;
  }

  function renderV3(cover, assets) {
    const base = cloneImage(assets.base);
    const W = base.width, H = base.height;
    const sideJackets = blankImage(W, H);
    overlayImage(sideJackets, morph(cover, MORPH_LEFT_NORMAL, W, H), 0, 0);
    overlayImage(sideJackets, morph(cover, MORPH_RIGHT_NORMAL, W, H), 0, 0);
    overlayImage(sideJackets, morph(cover, MORPH_LEFT_MIRROR, W, H), 0, 0);
    overlayImage(sideJackets, morph(cover, MORPH_RIGHT_MIRROR, W, H), 0, 0);
    overlayImage(sideJackets, assets.sideCover, 0, 0);
    const center = blankImage(W, H);
    overlayImage(center, morph(cover, MORPH_CENTER_NORMAL, W, H), 0, 0);
    overlayImage(center, morph(cover, MORPH_CENTER_MIRROR, W, H), 0, 0);
    overlayImage(center, assets.centerCover, 0, 0);
    const maskedSide = applyAlphaMask(sideJackets, assets.sideMask);
    const maskedCenter = applyAlphaMask(center, assets.centerMask);
    overlayImage(base, maskedSide, 0, 0);
    overlayImage(base, assets.sideCover, 0, 0);
    overlayImage(base, assets.windows, 0, 0);
    overlayImage(base, maskedCenter, 0, 0);
    overlayImage(base, assets.bottom, 0, 0);
    return base;
  }

  function imageDataToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }

  // renderToSquareBackground: tile the 2048x1168 render into a 2048x2048
  // canvas with the pattern origin shifted to the vertical center, exactly
  // like the original (pattern translate + drawImage at the same offset).
  function toSquareCanvas(rendered, size) {
    const src = imageDataToCanvas(rendered);
    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const ctx = out.getContext('2d');
    const cy = (size - src.height) / 2;
    // band above: source rows [size/2 - cy ... ] wrap from the image bottom
    ctx.drawImage(src, 0, src.height - cy, src.width, cy, 0, 0, size, cy);
    ctx.drawImage(src, 0, cy, size, src.height);
    const below = size - cy - src.height;
    if (below > 0) ctx.drawImage(src, 0, 0, src.width, below, 0, cy + src.height, size, below);
    return out;
  }

  // assets: {base, bottom, centerCover, centerMask, sideCover, sideMask,
  // windows} as HTMLImageElements (2048x1168 each).
  function composeV3Background(jacketImg, assets) {
    const cover = toImageData(jacketImg);
    const a = {
      base: toImageData(assets.base), bottom: toImageData(assets.bottom),
      centerCover: toImageData(assets.centerCover), centerMask: toImageData(assets.centerMask),
      sideCover: toImageData(assets.sideCover), sideMask: toImageData(assets.sideMask),
      windows: toImageData(assets.windows),
    };
    const rendered = renderV3(cover, a);
    return toSquareCanvas(rendered, a.base.width);
  }

  // ---- legacy fallback ----------------------------------------------------
  const WINDOW = { x: 695, y: 592, w: 627, h: 480 };
  function composeBackground(defaultImg, jacketImg) {
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 2048;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, 2048, 2048);
    if (defaultImg) ctx.drawImage(defaultImg, 0, 0, 2048, 2048);
    if (jacketImg) {
      const s = Math.max(WINDOW.w / jacketImg.width, WINDOW.h / jacketImg.height);
      const dw = jacketImg.width * s, dh = jacketImg.height * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h);
      ctx.clip();
      ctx.filter = 'brightness(0.55) saturate(0.75)';
      ctx.drawImage(jacketImg, WINDOW.x + (WINDOW.w - dw) / 2, WINDOW.y + (WINDOW.h - dh) / 2, dw, dh);
      ctx.restore();
      ctx.filter = 'none';
      ctx.strokeStyle = 'rgba(6,8,18,0.9)';
      ctx.lineWidth = 16;
      ctx.strokeRect(WINDOW.x - 8, WINDOW.y - 8, WINDOW.w + 16, WINDOW.h + 16);
      ctx.strokeStyle = 'rgba(170,195,255,0.20)';
      ctx.lineWidth = 3;
      ctx.strokeRect(WINDOW.x - 1, WINDOW.y - 1, WINDOW.w + 2, WINDOW.h + 2);
    }
    return c;
  }

  window.SekaiBg = { composeBackground, composeV3Background, WINDOW };
})();
