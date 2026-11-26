import {readFileSync} from 'node:fs';
const buf = readFileSync(new URL('../assets/wasm/core.wasm', import.meta.url));
const {instance} = await WebAssembly.instantiate(buf, {});
const W = instance.exports, mem = new Float32Array(W.memory.buffer);
let fail = 0;
const eq = (a,b,tol,msg)=>{ if(Math.abs(a-b)>tol){ console.error('NG',msg,a,b); fail=1 } else console.log('ok',msg,a.toFixed?.(4) ?? a) };
// --- project_points (game) vs JS reference ---
const PIN=1048576/4, POUT=1572864/4;
const KAP=45*Math.log(1.06), cx=960, yJ=793, yV=62, unit=126, lead=2.8;
const pts=[[6,0],[0,1.4],[12,2.8],[3.5,0.7],[9,2.1]];
pts.forEach((p,i)=>{ mem[PIN+i*2]=p[0]; mem[PIN+i*2+1]=p[1] });
W.project_points(pts.length,0,cx,yJ,yV,unit,KAP,lead,0,300);
pts.forEach((p,i)=>{
  const s=Math.exp(-KAP*Math.min(1,Math.max(0,p[1]/lead)));
  eq(mem[POUT+i*4], cx+(p[0]-6)*unit*s, 0.6, `proj x lane${p[0]}`);
  eq(mem[POUT+i*4+1], yV+(yJ-yV)*s, 0.6, `proj y rel${p[1]}`);
  eq(mem[POUT+i*4+3], s, 0.01, `recipW rel${p[1]}`);
});
// flat
W.project_points(1,1,0,900,0,20,KAP,lead,100,250);
mem[PIN]=2; mem[PIN+1]=1.2; W.project_points(1,1,0,900,0,20,KAP,lead,100,250);
eq(mem[POUT],140,0.01,'flat x'); eq(mem[POUT+1],600,0.01,'flat y'); eq(mem[POUT+3],1,0.001,'flat recipW');
// --- particles: spawn 1, update, pack ---
const S=20, b=0; // particle 0 base (float idx)
mem.fill(0,0,4096*S);
Object.entries({0:6,1:0,2:0,3:1,4:2,5:0,6:1,7:1,8:0.5,9:0,10:0.5,11:0.8,12:3,13:-4,14:0,15:0,16:1,17:0.5,18:0.25,19:1}).forEach(([k,v])=>mem[b+ +k]=v);
W.p_update(0.25);
// x=6+1*.25, up=0+ (2 + -4*.25)*.25 = 0.25, life=.75, rot=.125
eq(mem[b+0],6.25,1e-4,'p x'); eq(mem[b+1],0.25,1e-4,'p up'); eq(mem[b+6],0.75,1e-4,'p life'); eq(mem[b+9],0.125,1e-4,'p rot');
const n=W.p_pack(0,cx,yJ,yV,unit,KAP,0);
eq(n,1,0,'pack count');
const PK=2097152/4;
eq(mem[PK], cx+(6.25-6)*unit*1, 0.6,'pack x'); eq(mem[PK+4], 0.8*0.75, 1e-3,'pack alpha (fadePow=1)');
eq(mem[PK+5],3,0,'pack frame');
W.p_update(1); const n2=W.p_pack(0,cx,yJ,yV,unit,KAP,0); eq(n2,0,0,'pack after death');
console.log(fail?'FAILED':'ALL WASM TESTS PASSED'); process.exit(fail);
