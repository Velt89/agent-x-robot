#!/usr/bin/env node
/*
 * Agent X Robot — art generator.
 * Emits the robot base + 32 part overlay SVGs (8 types x 4 rarities).
 * Every part is a full 1000x1000 canvas aligned with the base, transparent
 * background, so parts stack by simple overlay (see compose.js / README.md).
 * SAME silhouette per type across rarities; rarity changes palette + detail
 * overlays only. No gradients/filters anywhere (flat fills + opacity halos),
 * so files compose without ID clashes.
 */
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const OL = '#10131a'; // outline

const RARITIES = ['uncommon', 'rare', 'epic', 'legendary'];
const PALETTES = {
  uncommon:  { main:'#66788c', light:'#93a7ba', dark:'#43536a', deep:'#2e3a49', accent:'#37e6ff', accentSoft:'#2b93a8', gem:'#bffbff' },
  rare:      { main:'#2456c8', light:'#5b8bf0', dark:'#173a8a', deep:'#102a63', accent:'#ff2a3c', accentSoft:'#ff6b74', gem:'#ffd7da' },
  epic:      { main:'#6d28c9', light:'#9a5cf0', dark:'#45157f', deep:'#2e0d57', accent:'#d08cff', accentSoft:'#e3b8ff', gem:'#f4e6ff' },
  legendary: { main:'#e8a90c', light:'#ffd94d', dark:'#a87400', deep:'#75500a', accent:'#fff3b0', accentSoft:'#ffe066', gem:'#ffffff' },
};
// Base robot palette (slate steel, cyan)
const B = { main:'#66788c', light:'#93a7ba', dark:'#43536a', deep:'#2e3a49', ink:'#232b36', cyan:'#37e6ff', cyanDim:'#1d7f92' };

const svgWrap = (inner, label) =>
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">
<!-- Agent X Robot :: ${label} :: overlay layer, align 1:1 with robot-base.svg -->
${inner}
</svg>
`;
const P = (d, fill, sw = 9, extra = '') => `<path d="${d}" fill="${fill}" ${extra.includes('stroke="') ? '' : `stroke="${OL}" `}stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const R = (x, y, w, h, rx, fill, sw = 9, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${OL}" stroke-width="${sw}" stroke-linejoin="round" ${extra}/>`;
const C = (cx, cy, r, fill, sw = 9, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${OL}" stroke-width="${sw}" ${extra}/>`;
const L = (x1, y1, x2, y2, color, sw, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" ${extra}/>`;
const halo = (cx, cy, r, color, op) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="${op}" stroke="none"/>`;
const rivets = (pts, fill) => pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${fill}" stroke="none"/>`).join('');

/* ============================ BASE ROBOT ============================ */
function baseRobot() {
  const g = [];
  // legs (plain)
  g.push(R(398, 548, 204, 66, 14, B.dark));                       // pelvis
  g.push(R(388, 606, 92, 158, 18, B.main)); g.push(R(520, 606, 92, 158, 18, B.main));   // thighs
  g.push(R(392, 758, 84, 142, 16, B.dark)); g.push(R(524, 758, 84, 142, 16, B.dark));   // shins
  g.push(P('M366,946 L502,946 L502,898 L380,898 Q366,898 366,922 Z', B.deep));          // boot L
  g.push(P('M498,946 L634,946 L634,922 Q634,898 620,898 L498,898 Z', B.deep));          // boot R
  g.push(C(434, 762, 17, B.light, 6)); g.push(C(566, 762, 17, B.light, 6));             // knees
  // arms (plain): shoulders, upper arms, fists
  g.push(C(326, 344, 56, B.dark)); g.push(C(674, 344, 56, B.dark));
  g.push(R(288, 372, 66, 128, 24, B.main)); g.push(R(646, 372, 66, 128, 24, B.main));
  g.push(C(318, 540, 37, B.dark, 8)); g.push(C(682, 540, 37, B.dark, 8));
  // torso
  g.push(P('M352,298 L648,298 L676,468 L642,562 L358,562 L324,468 Z', B.main));
  g.push(P('M352,298 L648,298 L660,380 L340,380 Z', B.light, 6));
  g.push(L(368, 520, 632, 520, B.dark, 7));
  g.push(R(452, 470, 96, 34, 8, B.dark, 6));                        // belt plate
  // core socket (dim; Core part overlays it)
  g.push(halo(500, 425, 92, B.cyan, 0.07));
  g.push(C(500, 425, 80, B.ink)); g.push(C(500, 425, 57, B.deep, 6));
  g.push(`<circle cx="500" cy="425" r="17" fill="${B.cyan}" fill-opacity="0.45" stroke="none"/>`);
  // neck + head
  g.push(R(458, 288, 84, 34, 8, B.dark, 6));
  g.push(R(364, 202, 34, 70, 10, B.dark, 7)); g.push(R(602, 202, 34, 70, 10, B.dark, 7)); // ear pods
  g.push(R(396, 148, 208, 156, 30, B.deep));                        // face plate
  g.push(P('M396,232 L604,232 L604,304 L396,304 Z', B.ink, 6));     // jaw
  g.push(R(430, 212, 140, 26, 13, B.cyanDim, 5));                   // plain eye slit (Visor overlays)
  g.push(`<rect x="438" y="220" width="124" height="10" rx="5" fill="${B.cyan}" fill-opacity="0.5" stroke="none"/>`);
  g.push(L(500, 148, 500, 106, OL, 9)); g.push(C(500, 96, 11, B.cyan, 6)); // antenna
  return svgWrap(g.join('\n'), 'robot-base');
}

/* ============================ PARTS ============================ */
/* Each builder: (p = palette, t = tier 0..3) => inner SVG string.
   Silhouette paths are identical for all tiers; tiers add detail only. */

function helmet(p, t) {
  const g = [];
  if (t >= 1) g.push(halo(500, 150, 130, p.accent, 0.10));
  if (t >= 3) g.push(halo(500, 120, 185, p.accent, 0.12));
  g.push(P('M318,272 L318,208 Q318,86 500,82 Q682,86 682,208 L682,272 L612,272 L612,214 Q612,148 500,144 Q388,148 388,214 L388,272 Z', p.main));
  g.push(P('M388,214 Q388,148 500,144 Q612,148 612,214 L612,238 Q612,178 500,174 Q388,178 388,238 Z', p.light, 5)); // brow shade
  g.push(R(468, 52, 64, 52, 12, p.dark));                            // crest block
  g.push(R(316, 196, 46, 92, 12, p.dark, 8)); g.push(R(638, 196, 46, 92, 12, p.dark, 8)); // side guards
  g.push(L(500, 104, 500, 144, p.dark, 8));                          // center seam
  if (t >= 1) { g.push(L(352, 236, 384, 236, p.accent, 7)); g.push(L(616, 236, 648, 236, p.accent, 7)); g.push(C(500, 124, 10, p.accent, 5)); }
  if (t >= 2) { g.push(P('M430,96 Q500,72 570,96 L570,116 Q500,94 430,116 Z', p.light, 5)); g.push(L(340, 160, 372, 128, p.accent, 6)); g.push(L(660, 160, 628, 128, p.accent, 6)); }
  if (t >= 3) { g.push(C(500, 78, 15, p.gem, 6)); g.push(L(452, 66, 548, 66, p.accent, 5)); g.push(P('M356,120 Q500,60 644,120', 'none', 4, `stroke="${p.dark}" stroke-opacity="0.6"`)); }
  g.push(rivets([[352, 258], [648, 258], [500, 96]], p.deep));
  return g.join('\n');
}

function visor(p, t) {
  const g = [];
  if (t >= 1) g.push(halo(500, 230, 120, p.accent, 0.13));
  if (t >= 3) g.push(halo(500, 230, 165, p.accent, 0.12));
  g.push(R(376, 196, 248, 68, 30, p.dark));                          // frame
  g.push(R(394, 208, 212, 44, 20, '#0d1420', 6));                    // lens
  g.push(C(368, 230, 17, p.main, 7)); g.push(C(632, 230, 17, p.main, 7)); // side pods
  g.push(`<rect x="410" y="222" width="180" height="16" rx="8" fill="${p.accent}" ${t === 0 ? 'fill-opacity="0.55"' : ''} stroke="none"/>`);
  if (t >= 1) g.push(`<rect x="410" y="242" width="120" height="6" rx="3" fill="${p.accentSoft}" stroke="none"/>`);
  if (t >= 2) { g.push(L(420, 204, 580, 204, p.accent, 5)); g.push(C(500, 188, 9, p.accent, 5)); }
  if (t >= 3) { g.push(P('M486,182 L514,182 L500,164 Z', p.gem, 5)); g.push(L(398, 256, 602, 256, p.accent, 4)); }
  return g.join('\n');
}

function core(p, t) {
  const g = [];
  g.push(halo(500, 425, 96 + t * 16, p.accent, t === 0 ? 0.08 : 0.16));
  if (t >= 3) g.push(halo(500, 425, 165, p.accent, 0.13));
  g.push(C(500, 425, 86, p.dark)); g.push(C(500, 425, 71, p.main, 7));
  g.push(C(500, 425, 52, p.accent, 6, t === 0 ? 'fill-opacity="0.75"' : ''));
  g.push(C(500, 425, 22, p.gem, 5));
  g.push(rivets([[446, 371], [554, 371], [446, 479], [554, 479]], p.deep));
  if (t >= 1) g.push(`<path d="M500,344 A81,81 0 0 1 570,375" fill="none" stroke="${p.accent}" stroke-width="7" stroke-linecap="round"/>`);
  if (t >= 2) { g.push(`<path d="M500,506 A81,81 0 0 1 430,475" fill="none" stroke="${p.accent}" stroke-width="7" stroke-linecap="round"/>`); g.push(C(500, 425, 34, p.accentSoft, 4, 'fill-opacity="0.5"')); }
  if (t >= 3) { for (let a = 0; a < 8; a++) { const rad = a * Math.PI / 4, x1 = 500 + 100 * Math.cos(rad), y1 = 425 + 100 * Math.sin(rad), x2 = 500 + 118 * Math.cos(rad), y2 = 425 + 118 * Math.sin(rad); g.push(L(x1.toFixed(0), y1.toFixed(0), x2.toFixed(0), y2.toFixed(0), p.accent, 6)); } g.push(P('M500,398 L516,425 L500,452 L484,425 Z', p.gem, 4)); }
  return g.join('\n');
}

function weapon(p, t) {
  const g = [];
  if (t >= 1) g.push(halo(80, 545, 95, p.accent, 0.14));
  if (t >= 3) g.push(halo(80, 545, 140, p.accent, 0.13));
  g.push(R(150, 476, 152, 28, 10, p.dark, 7));                       // top rail
  g.push(R(84, 498, 252, 94, 20, p.main));                           // barrel body
  g.push(R(48, 486, 44, 118, 12, p.deep));                           // muzzle block
  g.push(`<rect x="58" y="512" width="24" height="66" rx="8" fill="${t === 0 ? p.dark : p.accent}" stroke="none" ${t >= 1 ? '' : 'fill-opacity="0.8"'}/>`);
  g.push(R(180, 592, 120, 26, 10, p.dark, 7));                       // under-grip
  g.push(C(238, 545, 27, p.dark, 7)); g.push(C(238, 545, 15, t === 0 ? p.accentSoft : p.accent, 5)); // power cell
  g.push(L(110, 522, 200, 522, p.light, 6)); g.push(L(110, 568, 200, 568, p.dark, 6));
  if (t >= 1) { g.push(L(120, 545, 330, 545, p.accent, 6)); g.push(`<rect x="258" y="486" width="52" height="10" rx="5" fill="${p.accent}" stroke="none"/>`); }
  if (t >= 2) { g.push(P('M120,506 L176,506 L164,528 L120,528 Z', p.light, 4)); g.push(P('M120,584 L176,584 L164,562 L120,562 Z', p.light, 4)); g.push(L(96, 610, 150, 640, p.accent, 5)); g.push(L(300, 480, 330, 452, p.accent, 5)); }
  if (t >= 3) { g.push(P('M140,516 Q190,500 240,516', 'none', 4, `stroke="${p.dark}" stroke-opacity="0.65"`)); g.push(P('M140,574 Q190,590 240,574', 'none', 4, `stroke="${p.dark}" stroke-opacity="0.65"`)); g.push(C(282, 545, 9, p.gem, 4)); g.push(C(70, 545, 10, p.gem, 4)); }
  return g.join('\n');
}

function arms(p, t) {
  const g = [];
  const one = (flip) => {
    const x = flip ? 648 : 258, cx = flip ? 695 : 305;
    const s = [];
    if (t >= 2) s.push(halo(cx, 520, 95, p.accent, 0.10));
    s.push(R(x, 424, 96, 150, 26, p.main));                          // gauntlet
    s.push(R(x + 8, 440, 80, 44, 14, p.light, 5));                   // plate shade
    s.push(C(cx, 606, 41, p.dark, 8));                               // fist
    s.push(L(x + 16, 512, x + 80, 512, p.dark, 6));
    if (t >= 1) { s.push(L(x + 14, 462, x + 82, 462, p.accent, 6)); s.push(C(cx, 606, 12, p.accent, 5)); }
    if (t >= 2) { s.push(R(x + 20, 528, 56, 26, 8, p.light, 4)); s.push(L(x + 24, 588, x + 72, 588, p.accent, 5)); }
    if (t >= 3) { s.push(C(cx - 18, 592, 8, p.gem, 3)); s.push(C(cx + 18, 592, 8, p.gem, 3)); s.push(P(`M${x + 20},436 Q${cx},420 ${x + 76},436`, 'none', 4, `stroke="${p.dark}" stroke-opacity="0.6"`)); }
    return s.join('\n');
  };
  g.push(one(false), one(true));
  return g.join('\n');
}

function jetpack(p, t) {
  const g = [];
  const tank = (x) => {
    const s = [];
    s.push(R(x, 232, 112, 236, 30, p.main));                         // tank body
    s.push(R(x + 14, 208, 84, 40, 14, p.dark, 7));                   // cap
    s.push(R(x + 16, 300, 80, 26, 10, p.dark, 5));                   // band
    s.push(P(`M${x + 18},468 L${x + 94},468 L${x + 78},516 L${x + 34},516 Z`, p.deep, 7)); // nozzle
    if (t >= 1) { s.push(`<rect x="${x + 44}" y="338" width="24" height="96" rx="12" fill="${p.accent}" stroke="none"/>`); s.push(P(`M${x + 40},516 L${x + 56},566 L${x + 72},516 Z`, p.accent, 5, 'fill-opacity="0.85"')); }
    if (t >= 2) { s.push(C(x + 56, 272, 13, p.accent, 4)); s.push(L(x + 16, 420, x + 96, 420, p.accent, 5)); }
    if (t >= 3) { s.push(L(x + 28, 250, x + 28, 440, p.accentSoft, 4)); s.push(L(x + 84, 250, x + 84, 440, p.accentSoft, 4)); s.push(C(x + 56, 272, 6, p.gem, 3)); }
    return s.join('\n');
  };
  if (t >= 2) { g.push(halo(327, 540, 70, p.accent, 0.12)); g.push(halo(673, 540, 70, p.accent, 0.12)); }
  g.push(tank(271), tank(617));
  g.push(R(452, 250, 96, 60, 14, p.dark, 7));                        // spine plate (mostly behind torso)
  return g.join('\n');
}

function legs(p, t) {
  const g = [];
  const one = (flip) => {
    const tx = flip ? 513 : 378, sx = flip ? 520 : 385, bx = flip ? 495 : 360, knee = flip ? 568 : 432;
    const s = [];
    s.push(R(tx, 598, 109, 168, 22, p.main));                        // thigh plate
    s.push(R(sx, 762, 95, 140, 18, p.dark));                         // shin plate
    s.push(P(`M${bx},950 L${bx + 145},950 L${bx + 145},900 L${bx + 16},900 Q${bx},900 ${bx},924 Z`, p.deep)); // boot
    s.push(C(knee, 766, 26, p.light, 7));                            // knee disc
    s.push(L(tx + 20, 630, tx + 20, 730, p.dark, 6));
    if (t >= 1) { s.push(`<rect x="${sx + 38}" y="776" width="19" height="104" rx="9" fill="${p.accent}" stroke="none"/>`); s.push(L(bx + 14, 934, bx + 131, 934, p.accent, 6)); }
    if (t >= 2) { s.push(R(tx + 58, 620, 34, 120, 10, p.light, 4)); s.push(L(sx + 12, 800, sx + 34, 800, p.accent, 5)); s.push(L(sx + 61, 830, sx + 83, 830, p.accent, 5)); }
    if (t >= 3) { s.push(P(`M${tx + 24},650 Q${tx + 54},690 ${tx + 24},730`, 'none', 4, `stroke="${p.dark}" stroke-opacity="0.6"`)); s.push(C(knee, 766, 10, p.gem, 4)); s.push(`<rect x="${bx + 20}" y="906" width="105" height="10" rx="5" fill="${p.accent}" fill-opacity="0.7" stroke="none"/>`); }
    return s.join('\n');
  };
  g.push(one(false), one(true));
  return g.join('\n');
}

function drone(p, t) {
  const g = [];
  g.push(halo(818, 208, 84 + t * 14, p.accent, t === 0 ? 0.08 : 0.15));
  if (t >= 3) g.push(halo(818, 208, 150, p.accent, 0.12));
  g.push(`<ellipse cx="818" cy="208" rx="94" ry="30" fill="none" stroke="${p.dark}" stroke-width="7"/>`); // orbit ring
  g.push(C(818, 208, 62, p.main));                                   // body
  g.push(P('M770,168 Q818,140 866,168 L866,190 Q818,168 770,190 Z', p.light, 5)); // top shade
  g.push(C(818, 214, 27, p.deep, 6)); g.push(C(818, 214, 14, t === 0 ? p.accentSoft : p.accent, 4)); // eye
  [[742, 148], [894, 148], [742, 268], [894, 268]].forEach(([x, y]) => { g.push(C(x, y, 12, p.dark, 5)); g.push(L(x - 14, y, x + 14, y, p.dark, 5)); });
  g.push(L(818, 146, 818, 118, OL, 7)); g.push(C(818, 108, 9, p.accent, 5)); // antenna
  if (t >= 1) { g.push(L(772, 252, 864, 252, p.accent, 5)); g.push(C(760, 208, 7, p.accent, 3)); g.push(C(876, 208, 7, p.accent, 3)); }
  if (t >= 2) { g.push(C(700, 300, 10, p.accent, 4)); g.push(`<path d="M712,282 A120,120 0 0 1 800,296" fill="none" stroke="${p.accent}" stroke-width="4" stroke-dasharray="8 8"/>`); }
  if (t >= 3) { g.push(P('M804,132 L832,132 L818,112 Z', p.gem, 4)); g.push(C(818, 214, 6, p.gem, 3)); }
  return g.join('\n');
}

const BUILDERS = { helmet, visor, core, weapon, arms, jetpack, legs, drone };

/* ============================ WRITE ============================ */
fs.mkdirSync(path.join(OUT, 'base'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'parts'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'base', 'robot-base.svg'), baseRobot());
let n = 0;
for (const [type, fn] of Object.entries(BUILDERS)) {
  RARITIES.forEach((rarity, t) => {
    const inner = fn(PALETTES[rarity], t);
    fs.writeFileSync(path.join(OUT, 'parts', `${type}-${rarity}.svg`), svgWrap(inner, `${type}-${rarity}`));
    n++;
  });
}
console.log(`base + ${n} part SVGs written`);
