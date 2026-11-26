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
    let startTime = activeTime;
    const head0 = {
      id: startNote.id, tick: startNote.tick,
      time: accumulateScaledDuration(startNote.tick, score.tempos, score.hiSpeeds),
      left: laneToLeft(startNote.lane), right: laneToLeft(startNote.lane) + startNote.width,
      ease: hold.start.ease,
    };
    let head = head0;
    const steps = hold.steps;
    for (let tailIndex = 0; tailIndex <= steps.length; tailIndex++) {
      const isEnd = tailIndex === steps.length;
      const tailStep = isEnd ? { id: hold.end, type: 'hidden', ease: 'linear' } : steps[tailIndex];
      if (!isEnd && tailStep.type === 'skip') continue;
      const tailNote = score.notes.get(tailStep.id);
      if (!tailNote) continue;
      const tail = {
        id: tailNote.id, tick: tailNote.tick,
        time: accumulateScaledDuration(tailNote.tick, score.tempos, score.hiSpeeds),
        left: laneToLeft(tailNote.lane), right: laneToLeft(tailNote.lane) + tailNote.width,
        ease: tailStep.ease,
      };
      const endTime = accumulateDuration(tailNote.tick, score.tempos);
      drawData.drawingHoldSegments.push({
        endID: hold.end, ease: head.ease, isGuide: hold.startType === 'guide',
        critical: score.notes.get(head.id).critical, tailStepIndex: tailIndex,
        headTime: head.time, tailTime: tail.time,
        headLeft: head.left, headRight: head.right, tailLeft: tail.left, tailRight: tail.right,
        startTime, endTime, activeTime, visibleDuration: noteDuration,
      });
      startTime = endTime;
      if (tailStep.type !== 'hidden') {
        const tickTime = tail.time;
        drawData.drawingHoldTicks.push({
          refID: tailNote.id, center: noteCenter(tailNote),
          visualTime: { min: tickTime - noteDuration, max: tickTime }, visibleDuration: noteDuration,
        });
      }
      head = tail;
    }
  }

  function calculateDrawData(score, noteSpeed) {
    const drawData = {
      noteSpeed, maxTicks: 1,
      drawingNotes: [], drawingLines: [], drawingHoldTicks: [], drawingHoldSegments: [],
    };
    const simultaneous = new Map(); // tick -> {min,max,duration,speedRatio,mismatch}
    const notesDesc = [...score.notes.values()].sort((a, b) => b.tick - a.tick || b.id - a.id);
    for (const note of notesDesc) {
      drawData.maxTicks = Math.max(drawData.maxTicks, note.tick);
      if (note.type === 'holdMid') continue;
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
        if (step && step.type === 'hidden') return '';
      }
      return note.critical ? 'critical_tick' : 'tick';
    }
    if (note.flick !== 'none') return note.critical ? 'critical_flick' : 'flick';
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
      if (hold && hold.startType === 'guide') continue;
      if (note.type === 'hold' && hold && hold.startType === 'hidden') {
        // FrictionHide head: no base note is drawn, but the trace SE sounds.
        events.push({
          time: accumulateDuration(note.tick, score.tempos),
          tick: note.tick, kind: note.critical ? 'critical_friction' : 'friction', noteID: note.id,
          lane: note.lane, width: note.width, critical: note.critical,
          volume: seVolumeAtTick(note.tick, score),
          combo: true, isEnd: false, isStart: true,
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
        combo: true, isEnd: note.type === 'holdEnd', isStart: note.type === 'hold',
      });
    }
    // Auto hold ticks: 1/8-measure grid strictly inside each hold (game model).
    for (const hold of score.holdNotes.values()) {
      if (hold.startType === 'guide') continue;
      const start = score.notes.get(hold.start.id);
      const end = score.notes.get(hold.end);
      if (!start || !end || end.tick <= start.tick) continue;
      const grid = TPB / 2; // half-beat grid (1/8 of a 4-beat measure)
      const critical = start.critical;
      let prevTick = start.tick;
      const joints = [...hold.steps.map((s) => score.notes.get(s.id)), end].filter(Boolean);
      for (const joint of joints) {
        for (let t = Math.floor(prevTick / grid + 1) * grid; t < joint.tick; t += grid) {
          events.push({
            time: accumulateDuration(t, score.tempos), tick: t,
            kind: critical ? 'critical_tick' : 'tick', noteID: -1,
            lane: start.lane, width: start.width, critical, volume: seVolumeAtTick(t, score),
            combo: true, auto: true,
          });
        }
        prevTick = joint.tick;
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
        if (sec <= 0) return table[0];
        const f = sec / step;
        const i = Math.floor(f);
        if (i >= count - 1) return table[count - 1];
        return table[i] + (table[i + 1] - table[i]) * (f - i);
      },
    };
  }

  window.SekaiDraw = {
    calculateDrawData, calculateHitEvents, calculateHudEvents, buildScaledTimeTable,
    getNoteDuration, laneToLeft, noteCenter, easeFn, lerp, unlerp,
  };
})();
