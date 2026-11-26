// Background composition (2D canvas, 2048x2048): the game's 2D-mode room
// (live/2dmode/background/default.png) with the song jacket placed in the
// center window, like the reference video. The composed canvas becomes the
// fullscreen background texture; brightness is applied in the GL shader.
(function () {
  'use strict';
  // Jacket window rect inside default.png (measured: dark panel region).
  const WINDOW = { x: 640, y: 110, w: 770, h: 900 };
  function composeBackground(defaultImg, jacketImg) {
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 2048;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, 2048, 2048);
    if (defaultImg) ctx.drawImage(defaultImg, 0, 0, 2048, 2048);
    if (jacketImg) {
      // cover-crop jacket into the window, slightly dimmed like the game
      const s = Math.max(WINDOW.w / jacketImg.width, WINDOW.h / jacketImg.height);
      const dw = jacketImg.width * s, dh = jacketImg.height * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h);
      ctx.clip();
      ctx.filter = 'brightness(0.42) saturate(0.75)';
      ctx.drawImage(jacketImg, WINDOW.x + (WINDOW.w - dw) / 2, WINDOW.y + (WINDOW.h - dh) / 2, dw, dh);
      ctx.restore();
      ctx.filter = 'none';
    }
    return c;
  }
  window.SekaiBg = { composeBackground, WINDOW };
})();
