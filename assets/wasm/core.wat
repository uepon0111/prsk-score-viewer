;; prsk-score-viewer v2 — WASM コア
;; 役割: フレーム毎のホットループを担当する。
;;   1) project_points : (レーン位置, スクロール距離) 群を画面座標へ一括投影し、
;;      各点の reciprocalW (=1/w) を返す。描画側はこれをクアッド頂点属性として
;;      GPU に渡し、フラグメント側で uv = (uv*recipW補間値)/(recipW補間値) の
;;      透視補正を行う。
;;   2) p_update / p_pack : パーティクルの物理更新（発生は JS 側がメモリへ直接
;;      書き込む）と、描画用インスタンスデータへの詰め替え（投影込み）。
;;
;; メモリレイアウト (byte offset):
;;   0        : パーティクル SoA 兼 AoS。CAP 個 × STRIDE(20) f32。
;;              [0]x(レーン座標 0..12) [1]up(判定線からの高さ,レーン単位)
;;              [2]z(奥行き 0=判定線,1=最奥) [3]vx [4]vy [5]vz
;;              [6]life(残り秒) [7]maxLife [8]size(レーン単位) [9]rot [10]vrot
;;              [11]alpha [12]frame(タイル番号) [13]gravity [14]drag
;;              [15]grow(size/秒) [16]r [17]g [18]b [19]fadePow
;;   1048576  : project 入力  (lane, rel) × N f32
;;   1572864  : project 出力  (sx, sy, s, recipW) × N f32
;;   2097152  : pack 出力     (cx, cy, sizePx, rot, alpha, frame, r, g, b, recipW) × N f32
(module
  (memory (export "memory") 64) ;; 4MiB
  (global $CAP i32 (i32.const 4096))
  (global $PIN  i32 (i32.const 1048576))
  (global $POUT i32 (i32.const 1572864))
  (global $PACK i32 (i32.const 2097152))

  ;; ---- exp(x): x = n*ln2 + r, 0<=r<ln2 の範囲縮小 + Taylor 8 項 + 2^n のビット合成 ----
  (func $exp (param $x f32) (result f32)
    (local $n i32) (local $r f32) (local $sum f32) (local $term f32) (local $i i32)
    (local.set $n (i32.trunc_f32_s (f32.floor (f32.mul (local.get $x) (f32.const 1.4426950408889634)))))
    (local.set $r (f32.sub (local.get $x) (f32.mul (f32.convert_i32_s (local.get $n)) (f32.const 0.6931471805599453))))
    (local.set $sum (f32.const 1)) (local.set $term (f32.const 1)) (local.set $i (i32.const 1))
    (block $done (loop $lp
      (br_if $done (i32.gt_s (local.get $i) (i32.const 9)))
      (local.set $term (f32.div (f32.mul (local.get $term) (local.get $r)) (f32.convert_i32_s (local.get $i))))
      (local.set $sum (f32.add (local.get $sum) (local.get $term)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (f32.mul (local.get $sum)
      (f32.reinterpret_i32 (i32.shl (i32.add (local.get $n) (i32.const 127)) (i32.const 23)))))

  ;; ---- 投影: mode 0=ゲーム画面(透視) / 1=フラット ----
  ;; game: rel(秒相当のスクロール距離) -> z = clamp(rel/lead,0,1), s = exp(-kap*z)
  ;;       sx = cx + (lane-6)*unit*s ; sy = yV + (yJ-yV)*s ; recipW = s
  ;; flat: sx = left + lane*unit ; sy = yJ - rel*pps ; s = 1 ; recipW = 1
  (func (export "project_points")
    (param $count i32) (param $mode i32)
    (param $cx f32) (param $yJ f32) (param $yV f32) (param $unit f32)
    (param $kap f32) (param $lead f32) (param $left f32) (param $pps f32)
    (local $i i32) (local $in i32) (local $out i32)
    (local $lane f32) (local $rel f32) (local $s f32) (local $sx f32) (local $sy f32)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_s (local.get $i) (local.get $count)))
      (local.set $in (i32.add (global.get $PIN) (i32.mul (local.get $i) (i32.const 8))))
      (local.set $out (i32.add (global.get $POUT) (i32.mul (local.get $i) (i32.const 16))))
      (local.set $lane (f32.load (local.get $in)))
      (local.set $rel (f32.load (i32.add (local.get $in) (i32.const 4))))
      (if (i32.eqz (local.get $mode)) (then
        (local.set $s (call $exp (f32.mul (f32.const -1)
          (f32.mul (local.get $kap)
            (f32.max (f32.const 0) (f32.min (f32.const 1)
              (f32.div (local.get $rel) (local.get $lead))))))))
        (local.set $sx (f32.add (local.get $cx)
          (f32.mul (f32.sub (local.get $lane) (f32.const 6)) (f32.mul (local.get $unit) (local.get $s)))))
        (local.set $sy (f32.add (local.get $yV)
          (f32.mul (f32.sub (local.get $yJ) (local.get $yV)) (local.get $s)))))
      (else
        (local.set $s (f32.const 1))
        (local.set $sx (f32.add (local.get $left) (f32.mul (local.get $lane) (local.get $unit))))
        (local.set $sy (f32.sub (local.get $yJ) (f32.mul (local.get $rel) (local.get $pps))))))
      (f32.store (local.get $out) (local.get $sx))
      (f32.store (i32.add (local.get $out) (i32.const 4)) (local.get $sy))
      (f32.store (i32.add (local.get $out) (i32.const 8)) (local.get $s))
      (f32.store (i32.add (local.get $out) (i32.const 12)) (local.get $s)) ;; recipW = 1/w = s
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ---- パーティクル物理更新: v += g*dt, drag, pos += v*dt, life -= dt, rot += vrot*dt, size += grow*dt ----
  (func (export "p_update") (param $dt f32)
    (local $i i32) (local $b i32) (local $life f32) (local $dr f32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $lp
        (br_if $done (i32.ge_s (local.get $i) (global.get $CAP)))
        (local.set $b (i32.mul (local.get $i) (i32.const 80)))
        (block $next
          (local.set $life (f32.load (i32.add (local.get $b) (i32.const 24))))
          (br_if $next (f32.le (local.get $life) (f32.const 0)))
          (local.set $life (f32.sub (local.get $life) (local.get $dt)))
          (f32.store (i32.add (local.get $b) (i32.const 24)) (local.get $life))
          (br_if $next (f32.le (local.get $life) (f32.const 0)))
          (local.set $dr (f32.max (f32.const 0)
            (f32.sub (f32.const 1) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 56))) (local.get $dt)))))
          (f32.store (i32.add (local.get $b) (i32.const 12))
            (f32.mul (f32.load (i32.add (local.get $b) (i32.const 12))) (local.get $dr)))
          (f32.store (i32.add (local.get $b) (i32.const 20))
            (f32.mul (f32.load (i32.add (local.get $b) (i32.const 20))) (local.get $dr)))
          (f32.store (i32.add (local.get $b) (i32.const 16))
            (f32.add (f32.load (i32.add (local.get $b) (i32.const 16)))
              (f32.mul (f32.load (i32.add (local.get $b) (i32.const 52))) (local.get $dt))))
          (f32.store (local.get $b)
            (f32.add (f32.load (local.get $b)) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 12))) (local.get $dt))))
          (f32.store (i32.add (local.get $b) (i32.const 4))
            (f32.add (f32.load (i32.add (local.get $b) (i32.const 4))) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 16))) (local.get $dt))))
          (f32.store (i32.add (local.get $b) (i32.const 8))
            (f32.add (f32.load (i32.add (local.get $b) (i32.const 8))) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 20))) (local.get $dt))))
          (f32.store (i32.add (local.get $b) (i32.const 36))
            (f32.add (f32.load (i32.add (local.get $b) (i32.const 36))) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 40))) (local.get $dt))))
          (f32.store (i32.add (local.get $b) (i32.const 32))
            (f32.add (f32.load (i32.add (local.get $b) (i32.const 32))) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 60))) (local.get $dt)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp))))

  ;; ---- 生存パーティクルを描画インスタンスへ詰め替え（投影込み）。戻り値 = 件数 ----
  ;; alpha = alpha0 * (life/maxLife)^fadePow
  (func (export "p_pack")
    (param $mode i32)
    (param $cx f32) (param $yJ f32) (param $yV f32) (param $unit f32)
    (param $kap f32) (param $left f32)
    (result i32)
    (local $i i32) (local $b i32) (local $o i32) (local $n i32)
    (local $life f32) (local $max f32) (local $s f32) (local $x f32) (local $y f32) (local $a f32) (local $t f32)
    (local.set $i (i32.const 0)) (local.set $n (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_s (local.get $i) (global.get $CAP)))
      (local.set $b (i32.mul (local.get $i) (i32.const 80)))
      (local.set $life (f32.load (i32.add (local.get $b) (i32.const 24))))
      (local.set $max (f32.load (i32.add (local.get $b) (i32.const 28))))
      (if (i32.and (f32.gt (local.get $life) (f32.const 0)) (f32.gt (local.get $max) (f32.const 0))) (then
        (local.set $t (f32.div (local.get $life) (local.get $max)))
        ;; alpha = alpha0 * t^fadePow （fadePow は 0/1/2 のみ想定し分岐で処理）
        (local.set $a (f32.load (i32.add (local.get $b) (i32.const 44))))
        (if (f32.eq (f32.load (i32.add (local.get $b) (i32.const 76))) (f32.const 1))
          (then (local.set $a (f32.mul (local.get $a) (local.get $t)))))
        (if (f32.eq (f32.load (i32.add (local.get $b) (i32.const 76))) (f32.const 2))
          (then (local.set $a (f32.mul (local.get $a) (f32.mul (local.get $t) (local.get $t))))))
        ;; フェードイン包絡: 経過率 (1-t) の最初の 8% で 0->1（colorOverLifetime の立ち上がりの近似）
        (local.set $a (f32.mul (local.get $a)
          (f32.min (f32.const 1) (f32.div (f32.sub (f32.const 1) (local.get $t)) (f32.const 0.08)))))
        (if (i32.eqz (local.get $mode)) (then
          (local.set $s (call $exp (f32.mul (f32.const -1)
            (f32.mul (local.get $kap) (f32.max (f32.const 0) (f32.min (f32.const 1) (f32.load (i32.add (local.get $b) (i32.const 8)))))))))
          (local.set $x (f32.add (local.get $cx)
            (f32.mul (f32.sub (f32.load (local.get $b)) (f32.const 6)) (f32.mul (local.get $unit) (local.get $s)))))
          (local.set $y (f32.sub
            (f32.add (local.get $yV) (f32.mul (f32.sub (local.get $yJ) (local.get $yV)) (local.get $s)))
            (f32.mul (f32.load (i32.add (local.get $b) (i32.const 4))) (f32.mul (local.get $unit) (local.get $s))))))
        (else
          (local.set $s (f32.const 1))
          (local.set $x (f32.add (local.get $left) (f32.mul (f32.load (local.get $b)) (local.get $unit))))
          (local.set $y (f32.sub (local.get $yJ) (f32.mul (f32.load (i32.add (local.get $b) (i32.const 4))) (local.get $unit))))))
        (local.set $o (i32.add (global.get $PACK) (i32.mul (local.get $n) (i32.const 40))))
        (f32.store (local.get $o) (local.get $x))
        (f32.store (i32.add (local.get $o) (i32.const 4)) (local.get $y))
        (f32.store (i32.add (local.get $o) (i32.const 8))
          (f32.mul (f32.load (i32.add (local.get $b) (i32.const 32))) (f32.mul (local.get $unit) (local.get $s))))
        (f32.store (i32.add (local.get $o) (i32.const 12)) (f32.load (i32.add (local.get $b) (i32.const 36))))
        (f32.store (i32.add (local.get $o) (i32.const 16)) (local.get $a))
        (f32.store (i32.add (local.get $o) (i32.const 20)) (f32.load (i32.add (local.get $b) (i32.const 48))))
        (f32.store (i32.add (local.get $o) (i32.const 24)) (f32.load (i32.add (local.get $b) (i32.const 64))))
        (f32.store (i32.add (local.get $o) (i32.const 28)) (f32.load (i32.add (local.get $b) (i32.const 68))))
        (f32.store (i32.add (local.get $o) (i32.const 32)) (f32.load (i32.add (local.get $b) (i32.const 72))))
        (f32.store (i32.add (local.get $o) (i32.const 36)) (local.get $s))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $n))
)
