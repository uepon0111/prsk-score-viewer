// DrawData precomputation: a faithful port of sekai-mmw-preview-web's
// calculateDrawData / addHoldNote (AGPL-3.0), plus hit/HUD event streams.
(function () {
  'use strict';
  const { accumulateDuration, accumulateScaledDuration, TPB } = window.SekaiSUS;

  const lerp = (a, b, t) => a + (b - a) * t;
  const unlerp = (a, b, v) => (b - a) === 0 ? 0 : (v - a) / (b - a);
  const laneToLeft = (lane) => lane - 6;
  const noteCenter = (note) => laneToLeft(note.lane) + note.width / 2;
  const getNoteDuration = (noteSpeed) => lerp(0.35, 4.0, Math.pow(unlerp(12, 1, noteSpeed), 1.31));
  const sanitizeSpeed = (r) => (isFinite(r) && r > 0 ? r : 1);

  function easeFn(ease) {
    if (ease === 'easeIn') return (a, b, t) => lerp(a, b, t * t);
    if (ease === 'easeOut') return (a, b, t) => lerp(a, b, 1 - (1 - t) * (1 - t));
    return (a, b, t) => lerp(a, b, t);
  }

  function effectiveSpeedRatio(note, score) {
    let ratio = note.speedRatio;
    if ((note.type === 'holdMid' || note.type === 'holdEnd') && note.parentID >= 0) {
      const parent = score.notes.get(note.parentID);
      if (parent) ratio = parent.speedRatio;
    }
    return sanitizeSpeed(ratio);
  }
  function noteVisibleDuration(note, score, noteSpeed) {
    return getNoteDuration(noteSpeed) / effectiveSpeedRatio(note, score);
  }
  function noteVisualTime(note, score, noteSpeed) {
    const target = accumulateScaledDuration(note.tick, score.tempos, score.hiSpeeds);
    return { min: target - noteVisibleDuration(note, score, noteSpeed), max: target };
  }
  function seVolumeAtTick(tick, score) {
    for (let i = score.seVolumes.length - 1; i >= 0; i--) {
      if (score.seVolumes[i].tick <= tick) {
        const v = score.seVolumes[i].volume;
        return isFinite(v) && v >= 0 ? v : 1;
      }
    }
    return 1;
  }

  function addHoldNote(drawData, hold, score) {
    const startNote = score.notes.get(hold.start.id);
    const noteDuration = noteVisibleDuration(startNote, score, drawData.noteSpeed);
    const activeTime = accumulateDuration(startNote.tick, score.tempos);
    const mkPt = (note, ease) => ({
      id: note.id, tick: note.tick,
      time: accumulateScaledDuration(note.tick, score.tempos, score.hiSpeeds),
      left: laneToLeft(note.lane), right: laneToLeft(note.lane) + note.width,
      ease, realTime: accumulateDuration(note.tick, score.tempos),
    });
    // Path points: pass-through relays are not vertices; the ribbon runs
    // straight (with the head's ease) between surrounding path points.
    const pts = [mkPt(startNote, hold.start.ease)];
    for (const step of hold.steps) {
      if (step.passthrough) continue;
      const n = score.notes.get(step.id);
      if (n) pts.push(mkPt(n, step.ease));
    }
    const endNote = score.notes.get(hold.end);
    if (endNote && endNote.id !== startNote.id) pts.push(mkPt(endNote, 'linear'));
    for (let i = 0; i + 1 < pts.length; i++) {
      const head = pts[i], tail = pts[i + 1];
      drawData.drawingHoldSegments.push({
        endID: hold.end, ease: head.ease, isGuide: hold.startType === 'guide',
        critical: score.notes.get(head.id).critical, tailStepIndex: i,
        headTime: head.time, tailTime: tail.time,
        headLeft: head.left, headRight: head.right, tailLeft: tail.left, tailRight: tail.right,
        startTime: head.realTime, endTime: tail.realTime, activeTime, visibleDuration: noteDuration,
      });
    }
    // Relay diamonds: pass-through relays sit at the interpolated position
    // on their containing segment.
    for (const step of hold.steps) {
      if (step.type === 'hidden' || step.hideTick) continue;
      const n = score.notes.get(step.id);
      if (!n) continue;
      const tickTime = accumulateScaledDuration(n.tick, score.tempos, score.hiSpeeds);
      let center = noteCenter(n);
      if (step.passthrough) {
        for (let i = 0; i + 1 < pts.length; i++) {
          const head = pts[i], tail = pts[i + 1];
          if (tickTime >= head.time - 1e-9 && tickTime <= tail.time + 1e-9) {
            const p = tail.time > head.time ? (tickTime - head.time) / (tail.time - head.time) : 0;
            const hc = (head.left + head.right) / 2, tc = (tail.left + tail.right) / 2;
            center = easeFn(head.ease)(hc, tc, p);
            break;
          }
        }
      }
      drawData.drawingHoldTicks.push({
        refID: n.id, center,
        visualTime: { min: tickTime - noteDuration, max: tickTime }, visibleDuration: noteDuration,
      });
    }
  }

  function calculateDrawData(score, noteSpeed, noSoflan) {
    // noSoflan (ソフランなし): speed changes are disabled — every scaled
    // position is computed with the hi-speed list emptied, so notes,
    // ribbons and lines all live in plain tempo time, matching the
    // plain clock table the host uses in this mode. Building drawData
    // in hi-speed space while the clock runs in plain space (the old
    // behaviour) displaced ribbons and could hide the whole chart.
    if (noSoflan) score = Object.assign({}, score, { hiSpeeds: [] });
    const drawData = {
      noteSpeed, maxTicks: 1,
      drawingNotes: [], drawingLines: [], drawingHoldTicks: [], drawingHoldSegments: [],
    };
    const simultaneous = new Map(); // tick -> {min,max,duration,speedRatio,mismatch}
    const notesDesc = [...score.notes.values()].sort((a, b) => b.tick - a.tick || b.id - a.id);
    for (const note of notesDesc) {
      drawData.maxTicks = Math.max(drawData.maxTicks, note.tick);
      if (note.type === 'holdMid') continue;
      if (note.type === 'holdEnd' && note.hideBase) continue; // hidden-trace end: no node (test10 none())
      if (note.type === 'hold') {
        const hold = score.holdNotes.get(note.id);
        if (hold && hold.startType !== 'normal') continue;
      }
      if (note.type === 'holdEnd' && note.parentID >= 0) {
        const hold = score.holdNotes.get(note.parentID);
        if (hold && hold.endType !== 'normal') continue;
      }
      if (note.hideBase && note.type === 'tap') {
        // FrictionHide taps draw only their diamond (handled in renderer via friction flag)
      }
      drawData.drawingNotes.push({ refID: note.id, visualTime: noteVisualTime(note, score, noteSpeed) });
      const center = noteCenter(note);
      const speedRatio = effectiveSpeedRatio(note, score);
      const visibleDuration = noteVisibleDuration(note, score, noteSpeed);
      let entry = simultaneous.get(note.tick);
      if (!entry) {
        entry = { min: center, max: center, duration: visibleDuration, speedRatio, mismatch: false };
        simultaneous.set(note.tick, entry);
      } else {
        entry.min = Math.min(entry.min, center);
        entry.max = Math.max(entry.max, center);
        entry.duration = Math.max(entry.duration, visibleDuration);
        if (Math.abs(entry.speedRatio - speedRatio) > 0.0001) entry.mismatch = true;
      }
    }
    for (const [tick, entry] of simultaneous) {
      if (entry.min === entry.max || entry.mismatch) continue;
      const target = accumulateScaledDuration(tick, score.tempos, score.hiSpeeds);
      drawData.drawingLines.push({
        xPos: { min: entry.min, max: entry.max },
        visualTime: { min: target - entry.duration, max: target },
        visibleDuration: entry.duration,
      });
    }
    const holdsDesc = [...score.holdNotes.values()].reverse();
    for (const hold of holdsDesc) addHoldNote(drawData, hold, score);
    return drawData;
  }

  // ---- hit events (SE + combo + score), in real (unscaled) seconds --------
  function noteSEKind(note, score) {
    if (note.type === 'holdMid') {
      const hold = score.holdNotes.get(note.parentID);
      if (hold) {
        const step = hold.steps.find((s) => s.id === note.id);
        if (step && (step.type === 'hidden' || step.hideTick)) return '';
      }
      return note.critical ? 'critical_tick' : 'tick';
    }
    if (note.flick !== 'none' && !note.dirOnly) return note.critical ? 'critical_flick' : 'flick';
    if (note.friction) return note.critical ? 'critical_friction' : 'friction';
    if (note.critical && note.type === 'tap') return 'critical_tap';
    return 'perfect';
  }

  function calculateHitEvents(score) {
    const events = [];
    for (const note of score.notes.values()) {
      if (note.skip) continue;
      const hold = note.type === 'hold' || note.type === 'holdMid' || note.type === 'holdEnd'
        ? score.holdNotes.get(note.type === 'hold' ? note.id : note.parentID) : null;
      // Event gating follows the reference implementation (sekai-mmw-
      // preview-web, native calculateHitEvents): a hold start sounds only
      // when its startType is Normal (hidden/guide heads are silent), a
      // hold end only when its endType is Normal, and relay ticks come
      // only from non-hidden steps. A Normal hold start additionally
      // emits a 'holdLoop' event spanning the whole hold: the loop sound
      // (the pack's connect / critical_connect) plays for exactly the
      // hold's duration instead of ringing out at full sample length.
      if (note.type === 'hold') {
        if (!hold || hold.startType !== 'normal') continue;
        const kind = noteSEKind(note, score);
        if (kind) {
          events.push({
            time: accumulateDuration(note.tick, score.tempos),
            tick: note.tick, kind, noteID: note.id,
            lane: note.lane, width: note.width, critical: note.critical,
            volume: seVolumeAtTick(note.tick, score),
            combo: !note.deco && !note.damage, isEnd: false, isStart: true,
          });
        }
        const end = score.notes.get(hold.end);
        if (end && end.tick > note.tick) {
          events.push({
            time: accumulateDuration(note.tick, score.tempos),
            endTime: accumulateDuration(end.tick, score.tempos),
            tick: note.tick, kind: 'holdLoop', noteID: note.id,
            lane: note.lane, width: note.width, critical: note.critical,
            volume: seVolumeAtTick(note.tick, score),
            combo: false, isEnd: false, isStart: true,
          });
        }
        continue;
      }
      if (note.type === 'holdEnd') {
        if (!hold || hold.endType !== 'normal' || note.hideBase) continue;
        const kind = noteSEKind(note, score);
        if (!kind) continue;
        events.push({
          time: accumulateDuration(note.tick, score.tempos),
          tick: note.tick, kind, noteID: note.id,
          lane: note.lane, width: note.width, critical: note.critical,
          volume: seVolumeAtTick(note.tick, score),
          combo: !note.deco && !note.damage, isEnd: true, isStart: false,
        });
        continue;
      }
      const kind = noteSEKind(note, score);
      if (!kind) continue;
      events.push({
        time: accumulateDuration(note.tick, score.tempos),
        tick: note.tick, kind, noteID: note.id,
        lane: note.lane, width: note.width, critical: note.critical,
        volume: seVolumeAtTick(note.tick, score),
        combo: !note.deco && !note.damage, isEnd: false, isStart: false,
      });
    }
    // Auto hold ticks: 1/8-measure grid points strictly inside each hold
    // (test10's rule: the grid runs from chain start to end, ignoring
    // joints — a grid point on a relay counts alongside the relay).
    for (const hold of score.holdNotes.values()) {
      if (hold.startType === 'guide') continue;
      const start = score.notes.get(hold.start.id);
      const end = score.notes.get(hold.end);
      if (!start || !end || end.tick <= start.tick) continue;
      const critical = start.critical;
      for (const t of score.barGridTicks || []) {
        if (t <= start.tick) continue;
        if (t >= end.tick) break;
        events.push({
          time: accumulateDuration(t, score.tempos), tick: t,
          kind: critical ? 'critical_tick' : 'tick', noteID: -1,
          lane: start.lane, width: start.width, critical, volume: seVolumeAtTick(t, score),
          combo: true, auto: true,
        });
      }
    }
    events.sort((a, b) => a.time - b.time || a.tick - b.tick);
    return events;
  }

  function calculateHudEvents(score) {
    return score.events.map((e) => ({
      time: accumulateDuration(e.tick, score.tempos), tick: e.tick, type: e.type,
    })).sort((a, b) => a.time - b.time);
  }

  // sec -> scaled-sec lookup (10ms steps) for the render loop.
  function buildScaledTimeTable(score, durationSec) {
    const step = 0.01;
    const count = Math.ceil(durationSec / step) + 2;
    const table = new Float64Array(count);
    const { accumulateTicks } = window.SekaiSUS;
    for (let i = 0; i < count; i++) {
      const tick = accumulateTicks(i * step, score.tempos);
      table[i] = accumulateScaledDuration(tick, score.tempos, score.hiSpeeds);
    }
    return {
      step,
      at(sec) {
        // Outside the table, extrapolate with the edge slope instead of
        // clamping: the host player's clock starts at -1.6s (lead-in),
        // and clamping froze the scaled time at 0, drawing the t=0 frame
        // (notes that have not fallen yet) during the whole lead-in.
        if (sec <= 0) return table[0] + (sec / step) * (table[1] - table[0]);
        const f = sec / step;
        const i = Math.floor(f);
        if (i >= count - 1) {
          const slope = (table[count - 1] - table[count - 2]) / step;
          return table[count - 1] + (sec - (count - 1) * step) * slope;
        }
        return table[i] + (table[i + 1] - table[i]) * (f - i);
      },
    };
  }

  window.SekaiDraw = {
    calculateDrawData, calculateHitEvents, calculateHudEvents, buildScaledTimeTable,
    getNoteDuration, laneToLeft, noteCenter, easeFn, lerp, unlerp,
  };
})();
