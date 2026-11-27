// DOM HUD replicating the in-game layout seen in the reference video:
// top-left rank badge + score bar (C/B/A/S markers) + score digits,
// top-right LIFE bar + pause button, bottom-right AUTO LIVE badge,
// center judgement cluster ("AUTO" in auto preview), skill/fever banners.
//
// Score model (approximation — the game's exact spec is not public):
// every hit event is PERFECT; 1,000,000 base points are distributed over
// combo events by weight (auto hold ticks weigh 0.1, as the reference
// video's +661/+66 increments suggest). Skill windows multiply x1.3,
// fever x1.1. Rank thresholds are fractions of the 1,000,000 base scale
// tuned to reproduce the video's D -> C progression.
(function () {
  'use strict';
  const RANK_THRESHOLDS = [['S', 0.9], ['A', 0.65], ['B', 0.35], ['C', 0.02]];
  class Hud {
    constructor(root) {
      this.root = root;
      this.els = {};
      for (const id of ['rankBadge', 'scoreFill', 'scoreNum', 'scorePlus',
        'judgeText', 'comboWrap', 'comboNum', 'banner', 'feverBanner']) {
        this.els[id] = root.querySelector('#hud-' + id);
      }
      this.reset(1);
    }
    reset(totalWeight) {
      this.combo = 0;
      this.score = 0;
      this.totalWeight = Math.max(1, totalWeight);
      this.basePerWeight = 1000000 / this.totalWeight;
      this.skillUntil = -1;
      this.skillRate = 1;
      this.fever = false;
      this.update();
    }
    onHit(ev, nowSec) {
      if (!ev.combo) return; // holdLoop / deco events: sound only, no judgement
      const w = ev.auto ? 0.1 : 1;
      let gain = this.basePerWeight * w;
      if (nowSec < this.skillUntil) gain *= this.skillRate;
      if (this.fever) gain *= 1.1;
      this.score += gain;
      this.combo++;
      const plus = this.els.scorePlus;
      if (plus) {
        plus.textContent = '+' + Math.round(gain).toLocaleString('en-US');
        plus.classList.remove('pop');
        void plus.offsetWidth;
        plus.classList.add('pop');
      }
      const jt = this.els.judgeText;
      if (jt) {
        jt.classList.remove('pulse');
        void jt.offsetWidth;
        jt.classList.add('pulse');
      }
    }
    onSkill(nowSec) {
      this.skillUntil = nowSec + 5;
      this.skillRate = 1.3;
      this.showBanner('SKILL', 'スコアUP 130%', 2.2);
    }
    onFeverBegin() { this.showFever('FEVER CHANCE!', 2.2); }
    onFeverStart() {
      this.fever = true;
      this.showFever('SUPER FEVER!!', 2.6);
    }
    showBanner(title, sub, sec) {
      const b = this.els.banner;
      if (!b) return;
      b.querySelector('.banner-title').textContent = title;
      b.querySelector('.banner-sub').textContent = sub;
      b.classList.add('show');
      clearTimeout(this.bannerTimer);
      this.bannerTimer = setTimeout(() => b.classList.remove('show'), sec * 1000);
    }
    showFever(text, sec) {
      const b = this.els.feverBanner;
      if (!b) return;
      b.textContent = text;
      b.classList.add('show');
      clearTimeout(this.feverTimer);
      this.feverTimer = setTimeout(() => b.classList.remove('show'), sec * 1000);
    }
    rankFor(ratio) {
      for (const [rank, th] of RANK_THRESHOLDS) if (ratio >= th) return rank;
      return 'D';
    }
    update() {
      const e = this.els;
      if (e.scoreNum) e.scoreNum.textContent = String(Math.floor(this.score)).padStart(8, '0');
      if (e.scoreFill) e.scoreFill.style.width = Math.min(100, (this.score / 1000000) * 100) + '%';
      const rank = this.rankFor(this.score / 1000000);
      if (e.rankBadge) {
        e.rankBadge.textContent = rank;
        e.rankBadge.dataset.rank = rank;
      }
      if (e.comboNum) e.comboNum.textContent = this.combo;
      if (e.comboWrap) e.comboWrap.style.opacity = this.combo >= 2 ? '1' : '0';
    }
  }
  window.SekaiHud = { Hud };
})();
