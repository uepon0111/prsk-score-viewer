# test10-main MMW renewed viewer

Personal-use renewed dynamic chart viewer based on the original `test10-main/index.html`.

## Run
Open `index.html` from this folder. Keep the `assets/` folder beside it. If opened as a single HTML without assets, the player falls back to the previous Canvas 2D game view and also tries the public MMW raw asset URL.

## Dynamic viewer changes
- MMW note-speed duration curve and approach function.
- WebGL2 textured-quad renderer using MMW c246 atlases.
- GPU perspective correction through clip-space w.
- Notes 01/02 skin switching.
- Stage/default background, background brightness, stage cover.
- Simultaneous lines from precomputed groups.
- Long/guide ribbons with MMW easing and active-head redraw at the judgment line.
- Hit particles and MMW sound-effect scheduling.
- Auto HUD: score rank, score, combo, PERFECT, LIFE, AUTO LIVE, skill/fever popup.
- Playback speed up to 2x, A-B loop, manual latency ms and automatic latency estimate.
- Flat SVG view remains available.

## Verification performed
- JavaScript syntax check with Node: OK.
- Headless Chrome test with a sample SUS: player opened, WebGL game view rendered, seek/play worked, skin switch worked, background/cover settings worked, A-B loop returned playback, flat view switch worked.
- Screenshots are in `docs/verification/`.

## Known limits
- This is not a byte-identical WebSekai clone. WebSekai HUD/result internals, manual/keyboard judgment, MP4 export, CHUNITHM/UMIGURI assets, and the closed Maker JSON adapter are not reproduced.
- Particle behavior is MMW-inspired and uses MMW particle textures, but it is not a full `.pte` particle-definition replay.
- Game-derived assets are for personal use; MMW/prsk code licenses do not cover Project SEKAI assets.
