import {readFileSync} from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function extract(name){
  const i = script.indexOf('function '+name+'(');
  if(i<0) throw new Error('not found '+name);
  let j = script.indexOf('{', i), d=0, k=j;
  for(; k<script.length; k++){ if(script[k]==='{')d++; else if(script[k]==='}'){ d--; if(!d) break; } }
  return script.slice(i, k+1);
}
function extractConst(name){ // const name=...; (arrow or value, up to first ; at depth 0 — handle simple ones)
  const i = script.indexOf('const '+name+'=');
  if(i<0) throw new Error('const not found '+name);
  let d=0,k=i;
  for(; k<script.length; k++){ const c=script[k]; if('([{'.includes(c))d++; else if(')]}'.includes(c))d--; else if(c===';'&&d===0) break; }
  return script.slice(i, k+1);
}
const parts = [];
for(const f of ['parseSUS','scorePairs','buildPlay']) parts.push(extract(f));
for(const c of ['stripBOM','gcd','b36','crit','trend','none','isPath','nextSlidePathNode','directionTypeOf','flickAngleOf','cubicPoint']) { try{ parts.push(extractConst(c)) }catch(e){ parts.push(extract(c)) } }
const code = parts.join('\n') + '\n;({parseSUS, buildPlay});';
const {parseSUS, buildPlay} = eval(code);
// --- テスト譜面: BPM120, 4/4. 小節1: 同時押し2つ+単体, 小節2: ロング(スライド), 小節3: フリック ---
const sus = [
'#TITLE "test"',
'#BPM01: 120',
'#00008: 01',
'#00112: 12000000',
'#00116: 12000000',
'#00114: 00002200',
'#002331: 13000000',
'#002331: 00000030',
'#003331: 23000000',
'#00318: 00003300',
].join('\n');
const S = parseSUS(sus);
console.log('notes(active):', S.notes.length, 'ev:', S.ev.length);
const D = buildPlay(S);
let fail=0; const ok=(c,m)=>{ console.log((c?'ok ':'NG ')+m); if(!c) fail=1 };
ok(D.v===2,'DrawData v2');
ok(D.nodes.length>=3,'nodes exist: '+D.nodes.length);
ok(D.nodes.every(n=>Number.isFinite(n.t)&&Number.isFinite(n.q)),'all nodes have precomputed t & q (visualTime)');
ok(Math.abs(D.nodes[0].t-0)<0.01 || D.nodes[0].t>0,'first node time sane: '+D.nodes[0].t);
ok(D.simLines.length>=1,'simultaneous line precomputed: '+JSON.stringify(D.simLines));
ok(D.chains.length>=1,'chain exists');
if(D.chains.length){
  const c=D.chains[0];
  ok(c.band.length>=4*9 && c.band.length%4===0,'band polygon pre-split: '+(c.band.length/4)+' samples');
  ok(c.ticks.length>=1,'hold ticks precomputed: '+c.ticks.length);
  ok(c.ticks.every(t=>Number.isFinite(t.cx)),'tick centers computed');
}
ok(D.duration>D.chartEnd,'duration = chartEnd + tail');
ok(D.beats.length>=8,'beats precomputed: '+D.beats.length);
ok(D.hitTimes.length>=3,'hitTimes: '+D.hitTimes.length);
ok(Array.isArray(D.barTimes)&&D.barTimes.length>=4,'barTimes for engine state');
console.log(fail?'FAILED':'ALL DRAWDATA TESTS PASSED');
process.exit(fail);
