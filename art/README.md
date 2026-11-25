# Agent X Robot — Art Asset System

Flat-vector, hand-authored SVG. One robot base + 32 part overlays (8 types × 4 rarities).
Every file is a **1000×1000 canvas, viewBox `0 0 1000 1000`, transparent background**, drawn in the
same coordinate space — parts stack onto the base by plain overlay, no transforms needed.

## Files

```
art/
  generate.js          # generator: emits base + all 32 parts from shared silhouettes + palette maps
  compose.js           # loadout composer (SVG stacker, optional PNG via ffmpeg/librsvg)
  base/robot-base.svg  # the robot (slate steel, cyan visor slit + dim core socket)
  parts/<type>-<rarity>.svg   # 32 overlays, e.g. weapon-legendary.svg
  demos/               # demo-starter / demo-mid / demo-legendary (.svg + .png)
```

Regenerate everything after editing palettes/silhouettes in `generate.js`:

```
node generate.js
node compose.js --parts weapon:legendary,core:epic --out demos/custom.svg --png
node compose.js --parts all:legendary --out demos/demo-legendary.svg --png
```

## Layer order (back → front)

1. `jetpack` (behind the body — tanks/nozzles peek out at the sides)
2. `base` (robot-base.svg)
3. `legs`
4. `arms`
5. `core`
6. `weapon` (covers the left gauntlet/fist — the cannon *is* the left hand)
7. `helmet`
8. `visor`
9. `drone` (front, floating top-right)

## Equip anchor zones (1000×1000 canvas)

| Part   | Stat | Anchor zone (x, y, w×h approx)        | Centre / notes                       |
|--------|------|----------------------------------------|--------------------------------------|
| Helmet | DEF  | x 316–684, y 52–288                    | Dome over head, face opening y 144–272 |
| Visor  | ACC  | x 359–641, y 164–264                   | Lens band centre (500, 230)          |
| Core   | HP   | circle centre (500, 425), r ≤ 118      | Chest socket; rays reach r 118 (Legendary) |
| Weapon | ATK  | x 48–336, y 452–640                    | Arm cannon, viewer's left; muzzle at x 48 |
| Arms   | CRIT | gauntlets x 258–354 & 648–744, y 424–647 | Fists at (305, 606) & (695, 606)   |
| Jetpack| EVA  | tanks x 271–383 & 617–729, y 208–575   | Behind base; flames to y 575 (Rare+) |
| Legs   | SPD  | x 360–645, y 598–950                   | Knees at (432, 766) & (568, 766)     |
| Drone  | LUCK | centre (818, 208), orbit ring rx 94    | Floating top-right, rotors at ±76/±60 |

## Rarity palettes

Outline for everything: `#10131a` (stroke 4–9, round joins). No gradients, no filters —
glow is faked with concentric `fill-opacity` halo circles, so files compose with zero ID clashes.

| Role        | Uncommon (slate) | Rare (blue + RED) | Epic (purple) | Legendary (gold) |
|-------------|------------------|-------------------|---------------|------------------|
| main        | `#66788c`        | `#2456c8`         | `#6d28c9`     | `#e8a90c`        |
| light       | `#93a7ba`        | `#5b8bf0`         | `#9a5cf0`     | `#ffd94d`        |
| dark        | `#43536a`        | `#173a8a`         | `#45157f`     | `#a87400`        |
| deep        | `#2e3a49`        | `#102a63`         | `#2e0d57`     | `#75500a`        |
| accent/glow | `#37e6ff` (faint)| `#ff2a3c` **red** | `#d08cff`     | `#fff3b0`        |
| accent soft | `#2b93a8`        | `#ff6b74`         | `#e3b8ff`     | `#ffe066`        |
| gem         | `#bffbff`        | `#ffd7da`         | `#f4e6ff`     | `#ffffff`        |

Base robot: slate palette above + ink `#232b36`, face `#2e3a49`, cyan `#37e6ff`, dim cyan `#1d7f92`.

**Tier detail ladder** (silhouette never changes): Uncommon = flat plates + one faint accent mark →
Rare = accent energy lines + first glow halo → Epic = extra shade plates, energy arcs, accent crystals →
Legendary = engraved line work, gems, radiant halos/rays.

## How the frontend / metadata should use these

- **Robot token image** = composed loadout: stack the robot's currently equipped parts over
  `robot-base.svg` in the layer order above (server-side with `compose.js`, or client-side by
  inlining the SVGs into one `<svg>` — the files are small and ID-free). Re-compose on every
  equip/unequip. Serve the SVG directly as the token image, or rasterise to PNG with ffmpeg
  (`ffmpeg -i in.svg out.png`, librsvg) as `compose.js --png` does.
- **Part token image** = the part's own SVG. Parts are *position overlays* (mostly empty canvas by
  design, so they align with the base). For marketplace cards, render the part file over the
  standard dark card background `#0d1117`; optionally ghost the base robot at ~12% opacity
  underneath so buyers see where the part sits.
- **Backgrounds**: all files are transparent. Demos were rendered on transparency (appears black
  in most previews). The site should present robots on a dark arena background; glow halos are
  tuned for dark backgrounds.
- **Champion Edition Legendaries** (the 50 prize-vault items): same Legendary files; the
  "Champion Edition" distinction is a metadata trait + name/serial, not separate art. If a visual
  marker is wanted later, add a small gold serial badge group in the part's corner — do not fork
  the silhouette.
- **New parts / re-skins**: add a builder function + palette entry in `generate.js`, re-run it.
  Never hand-edit the emitted SVGs — they are build output.
