// SUS parser -> MMW-style Score. Ported semantics from Sekai-SUS-Parser
// (SusToJson.cpp) and MikuMikuWorld (Score/Tempo), adapted to plain JS.
// Score = {
//   notes: Map<id, Note>, holdNotes: Map<startId, HoldNote>,
//   tempos: [{tick, bpm}], hiSpeeds: [{tick, speed}], seVolumes: [{tick, volume}],
//   events: [{tick, type:'skill'|'feverBegin'|'feverStart'}],
//   maxTick, musicOffset (sec), title
// }
// Note = { id, type:'tap'|'hold'|'holdMid'|'holdEnd', tick, lane, width,
//          critical, friction, hideBase, skip, flick:'none'|'default'|'left'|'right',
//          parentID, speedRatio }
// HoldNote = { start:{id, ease}, steps:[{id, type:'normal'|'hidden', ease}], end:id,
//              startType:'normal'|'hidden'|'guide', endType:'normal'|'guide' }
(function () {
  'use strict';
  const TPB = 480;

  const susDigit = (c) => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'a' && c <= 'z') return c.charCodeAt(0) - 87; // a=10
    return -1;
  };
  // SUS lane char -> internal lane (0..11); 'f' -> 13 (fever), 'e' -> -2 (skill lane)
  const noteLine = (c) => {
    if (c === 'f') return 13;
    if (c === 'e') return -2;
    const v = susDigit(c);
    return v >= 2 && v <= 13 ? v - 2 : -1;
  };
  const noteWidth = (c) => {
    const v = susDigit(c);
    return v >= 1 ? v : -1;
  };

  function parseSUS(text) {
    const bpmMap = new Map();
    let ticksPerBeat = TPB;
    let musicOffset = 0;
    const barLengthMap = new Map(); // bar -> beats
    const bpmCells = []; // {bar, values[]}
    const til = []; // {bar, tickOffset, value}
    const vol = [];
    const rawNotes = []; // parsed note cells before merging

    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('#')) continue;
      let m;
      if ((m = line.match(/^#BPM([0-9a-zA-Z]{2}):\s*([\d.]+)/))) {
        bpmMap.set(m[1].toUpperCase(), parseFloat(m[2]));
        continue;
      }
      if ((m = line.match(/^#REQUEST\s+"?ticks_per_beat\s+(\d+)/))) {
        ticksPerBeat = parseInt(m[1], 10) || TPB;
        continue;
      }
      if ((m = line.match(/^#WAVEOFFSET\s+(-?[\d.]+)/))) {
        musicOffset = parseFloat(m[1]) || 0;
        continue;
      }
      if (line.startsWith('#TIL00')) {
        parseTimedRatios(line, '#TIL00:', til);
        continue;
      }
      if (line.startsWith('#VOL00')) {
        parseTimedRatios(line, '#VOL00:', vol);
        continue;
      }
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const header = line.slice(1, colon);
      const data = line.slice(colon + 1).replace(/\t/g, '').trim();
      if (!/^\d{3}$/.test(header.slice(0, 3))) continue;
      const bar = parseInt(header.slice(0, 3), 10);

      if (header.length === 5) {
        const type = header.slice(3, 5);
        if (type === '02') {
          const v = parseFloat(data);
          if (isFinite(v) && v > 0) barLengthMap.set(bar, v);
          continue;
        }
        if (type === '08') {
          bpmCells.push({ bar, values: parseValues(data).values });
          continue;
        }
        const laneType = susDigit(type[0]);
        const lane = noteLine(type[1]);
        const parsed = parseValues(data);
        emitCells(rawNotes, bar, laneType, lane, parsed, -1);
      } else if (header.length === 6) {
        const laneType = susDigit(header[3]);
        const lane = noteLine(header[4]);
        const longNo = susDigit(header[5]);
        const parsed = parseValues(data);
        emitCells(rawNotes, bar, laneType, lane, parsed, longNo);
      }
    }

    // ---- bar layout ------------------------------------------------------
    let maxBar = 0;
    for (const b of barLengthMap.keys()) maxBar = Math.max(maxBar, b);
    for (const b of bpmCells) maxBar = Math.max(maxBar, b.bar);
    for (const n of rawNotes) maxBar = Math.max(maxBar, n.bar);
    for (const t of til) maxBar = Math.max(maxBar, t.bar);
    maxBar += 1;
    const barStart = new Array(maxBar + 1).fill(0);
    const barBeats = new Array(maxBar + 1).fill(4);
    for (let b = 0; b <= maxBar; b++) {
      barBeats[b] = barLengthMap.get(b) || (b > 0 ? barBeats[b - 1] : 4);
      if (b > 0) barStart[b] = barStart[b - 1] + Math.round(barBeats[b - 1] * ticksPerBeat);
    }
    const tickOf = (bar, progress) =>
      barStart[bar] + Math.round(progress * barBeats[bar] * ticksPerBeat);

    // ---- tempos ----------------------------------------------------------
    const tempos = [];
    for (const cell of bpmCells) {
      cell.values.forEach((v, i) => {
        if (v === '00') return;
        const bpm = bpmMap.get(v.toUpperCase());
        if (bpm) tempos.push({ tick: tickOf(cell.bar, i / cell.values.length), bpm });
      });
    }
    tempos.sort((a, b) => a.tick - b.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: tempos.length ? tempos[0].bpm : 120 });
    if (tempos[0].tick !== 0) tempos[0] = { tick: 0, bpm: tempos[0].bpm };

    const hiSpeeds = til.map((t) => ({ tick: barStart[t.bar] + t.tickOffset, speed: t.value }))
      .sort((a, b) => a.tick - b.tick);
    const seVolumes = vol.map((t) => ({ tick: barStart[t.bar] + t.tickOffset, volume: t.value }))
      .sort((a, b) => a.tick - b.tick);

    // ---- notes: resolve ticks -------------------------------------------
    const infos = [];
    for (const n of rawNotes) {
      infos.push({ ...n, tick: tickOf(n.bar, n.progress) });
    }

    const notes = new Map();
    const holdNotes = new Map();
    const events = [];
    let nextId = 1;
    const addNote = (note) => { note.id = nextId++; notes.set(note.id, note); return note; };

    // Directional + tap infos merge into slide/guide infos at same tick+lane
    // (Sekai-SUS-Parser AddGuideInfo inheritance). Index base infos first.
    const baseAt = new Map(); // "tick,lane" -> info list (slide/guide)
    for (const info of infos) {
      if (info.kind === 'slide' || info.kind === 'guide') {
        const key = info.tick + ',' + info.lane;
        if (!baseAt.has(key)) baseAt.set(key, []);
        baseAt.get(key).push(info);
      }
    }
    const inheritIndex = new Map(); // "tick,lane" -> tap/directional infos
    for (const info of infos) {
      if (info.kind === 'tap' || info.kind === 'directional') {
        const key = info.tick + ',' + info.lane;
        if (!inheritIndex.has(key)) inheritIndex.set(key, []);
        inheritIndex.get(key).push(info);
      }
    }
    const inherit = (info) => {
      // returns merged attributes from coincident tap/directional infos
      const out = { critical: false, friction: false, hideBase: false, flick: 'none', ease: 'linear' };
      const coincident = inheritIndex.get(info.tick + ',' + info.lane) || [];
      for (const other of coincident) {
        if (other.kind === 'tap') {
          if (other.critical) out.critical = true;
          if (other.cat === 'friction' || other.cat === 'frictionHide') out.friction = true;
          if (other.cat === 'frictionHide') out.hideBase = true;
        } else if (other.kind === 'directional') {
          if (other.flick) out.flick = other.flick;
          if (other.ease) out.ease = other.ease;
        }
      }
      return out;
    };

    // Taps (standalone). A tap coincident with a slide/guide start or end is
    // absorbed as that note's head attributes, not drawn separately.
    const absorbed = new Set();
    for (const info of infos) {
      if (info.kind !== 'tap') continue;
      const key = info.tick + ',' + info.lane;
      const bases = baseAt.get(key);
      if (bases && bases.some((b) => b.cat === 'start' || b.cat === 'end')) absorbed.add(info);
    }

    for (const info of infos) {
      if (info.kind === 'event') { events.push({ tick: info.tick, type: info.eventType }); continue; }
      if (info.kind !== 'tap' || absorbed.has(info)) continue;
      if (info.lane < 0 || info.lane > 11 || info.width < 1 || info.lane + info.width > 12) continue;
      addNote({
        type: 'tap', tick: info.tick, lane: info.lane, width: info.width,
        critical: !!info.critical, friction: info.cat === 'friction' || info.cat === 'frictionHide',
        hideBase: info.cat === 'frictionHide', skip: info.cat === 'skip',
        flick: info.flick || 'none', parentID: -1, speedRatio: info.speedRatio || 1,
      });
    }
    // Directional flicks that target standalone taps:
    const tapIndex = new Map();
    for (const note of notes.values()) {
      const key = note.tick + ',' + note.lane;
      if (!tapIndex.has(key)) tapIndex.set(key, []);
      tapIndex.get(key).push(note);
    }
    for (const info of infos) {
      if (info.kind !== 'directional' || !info.flick) continue;
      const targets = tapIndex.get(info.tick + ',' + info.lane) || [];
      for (const note of targets) note.flick = info.flick;
    }

    // Slide & guide chains
    const chains = new Map(); // "kind:longNo" -> info list
    for (const info of infos) {
      if (info.kind !== 'slide' && info.kind !== 'guide') continue;
      const key = info.kind + ':' + info.longNo;
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key).push(info);
    }
    for (const [key, list] of chains) {
      const isGuide = key.startsWith('guide');
      list.sort((a, b) => a.tick - b.tick || a.lane - b.lane);
      let open = null;
      const closeChain = (endInfo) => {
        if (!open) return;
        const startInh = inherit(open.start);
        const startNote = notes.get(open.startNoteId);
        if (startNote) {
          startNote.critical = startNote.critical || startInh.critical;
          startNote.friction = startNote.friction || startInh.friction;
          if (startInh.hideBase) startNote.hideBase = true;
          if (startInh.flick !== 'none') startNote.flick = startInh.flick;
        }
        let endNote = null;
        if (endInfo) {
          const endInh = inherit(endInfo);
          endNote = addNote({
            type: 'holdEnd', tick: endInfo.tick, lane: endInfo.lane, width: endInfo.width,
            critical: endInh.critical, friction: false, hideBase: false, skip: false,
            flick: endInh.flick !== 'none' ? endInh.flick : 'none',
            parentID: open.startNoteId, speedRatio: endInfo.speedRatio || 1,
          });
          if (startNote && endInh.critical) startNote.critical = true;
        }
        holdNotes.set(open.startNoteId, {
          start: { id: open.startNoteId, ease: open.startEase },
          steps: open.steps,
          end: endNote ? endNote.id : open.startNoteId,
          startType: isGuide ? 'guide' : (startNote && startNote.hideBase ? 'hidden' : 'normal'),
          endType: isGuide ? 'guide' : 'normal',
        });
        open = null;
      };
      for (const info of list) {
        if (info.cat === 'start') {
          if (open) closeChain(null);
          const inh = inherit(info);
          const startNote = addNote({
            type: 'hold', tick: info.tick, lane: info.lane, width: info.width,
            critical: inh.critical, friction: inh.friction, hideBase: inh.hideBase, skip: false,
            flick: 'none', parentID: -1, speedRatio: info.speedRatio || 1,
          });
          open = { start: info, startNoteId: startNote.id, startEase: inh.ease !== 'linear' ? inh.ease : 'linear', steps: [] };
        } else if (info.cat === 'mid' || info.cat === 'midHidden') {
          if (!open) continue;
          const inh = inherit(info);
          const mid = addNote({
            type: 'holdMid', tick: info.tick, lane: info.lane, width: info.width,
            critical: inh.critical, friction: false, hideBase: false, skip: false,
            flick: 'none', parentID: open.startNoteId, speedRatio: info.speedRatio || 1,
          });
          open.steps.push({ id: mid.id, type: info.cat === 'mid' ? 'normal' : 'hidden', ease: inh.ease });
        } else if (info.cat === 'end') {
          if (!open) {
            // Orphan end: treat as a tap so it is not lost.
            const inh = inherit(info);
            addNote({
              type: 'tap', tick: info.tick, lane: info.lane, width: info.width,
              critical: inh.critical, friction: false, hideBase: false, skip: false,
              flick: inh.flick, parentID: -1, speedRatio: info.speedRatio || 1,
            });
            continue;
          }
          closeChain(info);
        }
      }
      if (open) closeChain(null);
    }

    let maxTick = 0;
    for (const n of notes.values()) maxTick = Math.max(maxTick, n.tick);
    events.sort((a, b) => a.tick - b.tick);

    return { notes, holdNotes, tempos, hiSpeeds, seVolumes, events, maxTick, musicOffset, ticksPerBeat };
  }

  function parseTimedRatios(line, prefix, target) {
    const normalized = line.replace(/"/g, '').replace(prefix, '').replace(/,/g, '\r');
    const re = /(\d+)'(\d+):([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\r|$)/g;
    let m;
    while ((m = re.exec(normalized))) {
      target.push({ bar: parseInt(m[1], 10), tickOffset: parseInt(m[2], 10), value: parseFloat(m[3]) });
    }
  }

  // ParseNoteValues port: cells of 2 chars, or "xx,ratio " pairs when commas exist.
  function parseValues(data) {
    const values = [];
    const speedRatios = [];
    if (!data) return { values, speedRatios };
    if (data.includes(',')) {
      const re = /([0-9a-z]{2}),(-*[0-9]+.?[0-9]*) /g;
      let m;
      while ((m = re.exec(data))) {
        values.push(m[1].toLowerCase());
        speedRatios.push(parseFloat(m[2]) || 1);
      }
      return { values, speedRatios };
    }
    const clean = data.replace(/\s/g, '');
    for (let i = 0; i + 1 < clean.length; i += 2) values.push(clean.substr(i, 2).toLowerCase());
    return { values, speedRatios };
  }

  function emitCells(rawNotes, bar, laneType, lane, parsed, longNo) {
    const { values, speedRatios } = parsed;
    values.forEach((value, i) => {
      if (!value || value === '00') return;
      const code = susDigit(value[0]);
      const width = noteWidth(value[1]);
      const progress = i / values.length;
      const speedRatio = i < speedRatios.length ? speedRatios[i] : 1;
      if (lane === 13 && laneType === 1) {
        if (code === 1) rawNotes.push({ kind: 'event', eventType: 'feverBegin', bar, progress, lane, width: 1 });
        else if (code === 2) rawNotes.push({ kind: 'event', eventType: 'feverStart', bar, progress, lane, width: 1 });
        return;
      }
      if (longNo === -1 && laneType === 1) {
        switch (code) {
          case 1: rawNotes.push({ kind: 'tap', cat: 'normal', bar, progress, lane, width, speedRatio }); break;
          case 2: rawNotes.push({ kind: 'tap', cat: 'normal', critical: true, bar, progress, lane, width, speedRatio }); break;
          case 3: rawNotes.push({ kind: 'tap', cat: 'skip', bar, progress, lane, width, speedRatio }); break;
          case 4: rawNotes.push({ kind: 'event', eventType: 'skill', bar, progress, lane, width: 1 }); break;
          case 5: rawNotes.push({ kind: 'tap', cat: 'friction', bar, progress, lane, width, speedRatio }); break;
          case 6: rawNotes.push({ kind: 'tap', cat: 'friction', critical: true, bar, progress, lane, width, speedRatio }); break;
          case 7: rawNotes.push({ kind: 'tap', cat: 'frictionHide', bar, progress, lane, width, speedRatio }); break;
          case 8: rawNotes.push({ kind: 'tap', cat: 'frictionHide', critical: true, bar, progress, lane, width, speedRatio }); break;
        }
      } else if (longNo === -1 && laneType === 5) {
        switch (code) {
          case 1: rawNotes.push({ kind: 'directional', flick: 'default', bar, progress, lane, width, speedRatio }); break;
          case 2: rawNotes.push({ kind: 'directional', ease: 'easeIn', bar, progress, lane, width, speedRatio }); break;
          case 3: rawNotes.push({ kind: 'directional', flick: 'left', bar, progress, lane, width, speedRatio }); break;
          case 4: rawNotes.push({ kind: 'directional', flick: 'right', bar, progress, lane, width, speedRatio }); break;
          case 5: case 6: rawNotes.push({ kind: 'directional', ease: 'easeOut', bar, progress, lane, width, speedRatio }); break;
        }
      } else if (longNo !== -1 && laneType === 3) {
        switch (code) {
          case 1: rawNotes.push({ kind: 'slide', cat: 'start', longNo, bar, progress, lane, width, speedRatio }); break;
          case 2: rawNotes.push({ kind: 'slide', cat: 'end', longNo, bar, progress, lane, width, speedRatio }); break;
          case 3: rawNotes.push({ kind: 'slide', cat: 'mid', longNo, bar, progress, lane, width, speedRatio }); break;
          case 5: rawNotes.push({ kind: 'slide', cat: 'midHidden', longNo, bar, progress, lane, width, speedRatio }); break;
        }
      } else if (longNo !== -1 && laneType === 9) {
        switch (code) {
          case 1: rawNotes.push({ kind: 'guide', cat: 'start', longNo, bar, progress, lane, width, speedRatio }); break;
          case 2: rawNotes.push({ kind: 'guide', cat: 'end', longNo, bar, progress, lane, width, speedRatio }); break;
          case 3: case 5: rawNotes.push({ kind: 'guide', cat: 'midHidden', longNo, bar, progress, lane, width, speedRatio }); break;
        }
      }
    });
  }

  // ---- tempo math (MikuMikuWorld Tempo port) ------------------------------
  const ticksToSec = (ticks, bpm) => ticks * (60 / bpm / TPB);
  function accumulateDuration(tick, tempos) {
    let total = 0, accTicks = 0, last = 0;
    for (let i = 0; i < tempos.length - 1; i++) {
      last = i;
      const seg = tempos[i + 1].tick - tempos[i].tick;
      if (accTicks + seg >= tick) break;
      accTicks += seg;
      total += ticksToSec(seg, tempos[i].bpm);
      last = i + 1;
    }
    total += ticksToSec(tick - tempos[last].tick, tempos[last].bpm);
    return total;
  }
  function accumulateScaledDuration(tick, tempos, hiSpeeds) {
    let prevBpm = 0, prevSpeed = -1, accTicks = 0, total = 0;
    while (accTicks < tick) {
      const nextBpmTick = prevBpm + 1 < tempos.length ? tempos[prevBpm + 1].tick : Infinity;
      const nextSpeedTick = prevSpeed + 1 < hiSpeeds.length ? hiSpeeds[prevSpeed + 1].tick : Infinity;
      const nextTick = Math.min(nextBpmTick, nextSpeedTick, tick);
      const bpm = tempos[prevBpm].bpm;
      const speed = prevSpeed >= 0 ? hiSpeeds[prevSpeed].speed : 1;
      total += ticksToSec(nextTick - accTicks, bpm) * speed;
      if (nextTick === nextBpmTick) prevBpm++;
      if (nextTick === nextSpeedTick) prevSpeed++;
      accTicks = nextTick;
    }
    return total;
  }
  function accumulateTicks(sec, tempos) {
    let total = 0, accSecs = 0, last = 0;
    for (let i = 0; i < tempos.length - 1; i++) {
      last = i;
      const seconds = ticksToSec(tempos[i + 1].tick - tempos[i].tick, tempos[i].bpm);
      if (accSecs + seconds >= sec) break;
      total += Math.floor(seconds / (60 / tempos[i].bpm / TPB));
      accSecs += seconds;
      last = i + 1;
    }
    total += Math.floor((sec - accSecs) / (60 / tempos[last].bpm / TPB));
    return total;
  }

  window.SekaiSUS = { parseSUS, accumulateDuration, accumulateScaledDuration, accumulateTicks, TPB };
})();
