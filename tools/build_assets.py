#!/usr/bin/env python3
"""アトラスJSON生成ツール。

notes_0X.png は「隙間のあるスプライトシート」なので、透明ピクセルの連結成分から
各スプライトの矩形を自動検出し、形・色相・左右対称性から意味名を付ける。
effect.png は Unity 由来の詰め込みシートで成分分離できないため、
fx_*.json の textureSheetAnimation が前提とするタイルグリッドとして定義する。

使い方: python3 tools/build_assets.py   (assets/ に対して冪等に再生成できる)
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(__file__), "..", "assets")

def hue_name(rgb):
    r, g, b = [v / 255.0 for v in rgb]
    mx, mn = max(r, g, b), min(r, g, b)
    if mx - mn < 0.12:
        return "white"
    if mx == r:
        h = (60 * ((g - b) / (mx - mn)) + 360) % 360
    elif mx == g:
        h = 60 * ((b - r) / (mx - mn)) + 120
    else:
        h = 60 * ((r - g) / (mx - mn)) + 240
    if h < 15 or h >= 345: return "pink"      # 赤〜マゼンタ寄りは flick 系として扱う
    if h < 45:  return "gold"
    if h < 75:  return "yellow"
    if h < 165: return "green"
    if h < 200: return "cyan"
    if h < 260: return "purple"
    return "pink"

def detect(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)
    alpha = a[:, :, 3] > 16
    lab, n = ndimage.label(alpha)
    out = []
    for i, s in enumerate(ndimage.find_objects(lab), start=1):
        ys, xs = s
        w, h = xs.stop - xs.start, ys.stop - ys.start
        if w * h < 200:            # ノイズ成分は捨てる
            continue
        mask = lab[s] == i
        px = a[s][mask & (a[s][:, :, 3] > 200)]
        if len(px) == 0:
            continue
        mean = px[:, :3].mean(axis=0)
        # 向き判定：最上行の重心 x が中央なら上向き、左寄りなら斜め（左上）向き
        rows = np.where(mask.any(axis=1))[0]
        top = mask[rows[0]: rows[0] + max(2, h // 20)]
        cols = np.where(top.any(axis=0))[0]
        apex = float(cols.mean() / w) if len(cols) else 0.5
        out.append(dict(x=int(xs.start), y=int(ys.start), w=int(w), h=int(h),
                        fill=float(mask.mean()), hue=hue_name(mean),
                        rgb=[int(v) for v in mean], apex=apex))
    return im.size, out

def classify(comps):
    """components -> {role_name: comp}。role は描画側が引く名前。"""
    roles, chevrons, bars, gems = {}, [], [], []
    for c in comps:
        ar = c["w"] / c["h"]
        if ar > 2.1:
            bars.append(c)
        elif ar < 1.35 and c["fill"] < 0.70 and c["w"] < 200:
            gems.append(c)
        else:
            chevrons.append(c)
    # --- ノーツ本体（帯状バー）：色で種別に割り当て ---
    body_by_hue = {}
    for c in sorted(bars, key=lambda c: -c["w"] * c["h"]):
        body_by_hue.setdefault(c["hue"], []).append(c)
    def take(hue, *names):
        lst = body_by_hue.get(hue, [])
        for i, name in enumerate(names):
            if i < len(lst):
                roles[name] = lst[i]
    take("green", "body_long", "body_long_marked")
    take("yellow", "body_crit", "body_crit_marked")
    take("gold", "body_crit_gold")
    take("pink", "body_flick", "body_tap_light")
    take("purple", "body_tap")
    take("cyan", "body_tap_cyan")
    if "body_tap" not in roles and "body_tap_light" in roles:
        roles["body_tap"] = roles["body_tap_light"]
    # --- 宝石（中継点）：色別に加え、全宝石リストも返す ---
    gem_names = []
    for c in sorted(gems, key=lambda c: -c["w"]):
        base = {"green": "gem_long", "cyan": "gem_long", "gold": "gem_crit",
                "yellow": "gem_crit", "pink": "gem_flick"}.get(c["hue"], "gem_misc")
        name = base
        k = 2
        while name in roles:
            name = f"{base}_{k}"; k += 1
        roles[name] = c
        gem_names.append(name)
    # --- フリック矢印：色×向き。名前は実幅つき（描画側が最も近い幅を選ぶ）。
    #     テクスチャ上の斜め矢印はすべて左上向き。右向きは描画側で左右反転する。 ---
    arrow_names = []
    for c in chevrons:
        orient = "diag" if c["apex"] < 0.42 else "up"
        color = "crit" if c["hue"] in ("yellow", "gold") else "flick"
        name = f"arrow_{color}_{orient}_w{c['w']}"
        roles[name] = c
        arrow_names.append(name)
    return roles, gem_names, arrow_names

def main():
    for skin in ("01", "02"):
        (W, H), comps = detect(os.path.join(ROOT, f"notes_{skin}.png"))
        roles, gem_names, arrow_names = classify(comps)
        frames = {name: {"x": c["x"], "y": c["y"], "w": c["w"], "h": c["h"],
                         "hue": c["hue"], "fill": round(c["fill"], 3)}
                  for name, c in sorted(roles.items())}
        data = {"image": f"notes_{skin}.png", "width": W, "height": H,
                "generatedBy": "tools/build_assets.py (connected-components)",
                "gems": gem_names, "arrows": arrow_names,
                "bodies": sorted(n for n in frames if n.startswith("body_")),
                "frames": frames}
        with open(os.path.join(ROOT, f"notes_{skin}.atlas.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(f"notes_{skin}: {len(comps)} components -> {len(frames)} roles")
        for name in frames: print("   ", name, frames[name])
    # --- エフェクト：タイルグリッド定義（fx の textureSheetAnimation と対応） ---
    eff = {
        "image": "effect.png", "width": 1024, "height": 1024,
        "note": "fx_*.json の textureSheetAnimation(numTilesX x numTilesY, startFrame) を "
                "この画像全体のグリッドとして解釈する。frame は行優先。",
        "defaultGrid": {"tilesX": 8, "tilesY": 8},
        "namedTiles8x8": {
            "diamond_cyan": 13, "diamond_pink": 14, "diamond_gold": 29,
            "diamond_green": 37, "circle_pink": 55, "circle_gold": 62,
            "flare_orange": 63, "sparkle": 9
        }
    }
    with open(os.path.join(ROOT, "effect.atlas.json"), "w", encoding="utf-8") as f:
        json.dump(eff, f, ensure_ascii=False, indent=1)
    print("effect.atlas.json written")

if __name__ == "__main__":
    main()
