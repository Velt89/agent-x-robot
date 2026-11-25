#!/usr/bin/env node
/*
 * Agent X Robot — loadout composer.
 * Stacks part overlay SVGs onto the robot base in the canonical layer order
 * and writes one combined SVG (and a PNG via ffmpeg if --png is passed).
 *
 * Usage:
 *   node compose.js --parts weapon:legendary,core:epic,helmet:rare --out demos/demo.svg [--png] [--size 1000]
 *   node compose.js --parts all:legendary --out demos/demo-legendary.svg --png
 * Part tokens: <type>:<rarity> | <type>-<rarity> | all:<rarity>
 * Types: helmet visor core weapon arms jetpack legs drone
 * Rarities: uncommon rare epic legendary
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ART = __dirname;
const LAYER_ORDER = ['jetpack', 'BASE', 'legs', 'arms', 'core', 'weapon', 'helmet', 'visor', 'drone'];
const TYPES = ['helmet', 'visor', 'core', 'weapon', 'arms', 'jetpack', 'legs', 'drone'];
const RARITIES = ['uncommon', 'rare', 'epic', 'legendary'];

function innerOf(svg) {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) throw new Error('not an svg file');
  return m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
}

function parseParts(spec) {
  const chosen = {}; // type -> rarity
  for (const tok of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const [type, rarity] = tok.split(/[:\-]/);
    if (type === 'all') {
      if (!RARITIES.includes(rarity)) throw new Error(`bad rarity in ${tok}`);
      for (const t of TYPES) chosen[t] = rarity;
    } else {
      if (!TYPES.includes(type)) throw new Error(`bad type in ${tok}`);
      if (!RARITIES.includes(rarity)) throw new Error(`bad rarity in ${tok}`);
      chosen[type] = rarity;
    }
  }
  return chosen;
}

function compose(chosen) {
  const groups = [];
  for (const layer of LAYER_ORDER) {
    if (layer === 'BASE') {
      const base = fs.readFileSync(path.join(ART, 'base', 'robot-base.svg'), 'utf8');
      groups.push(`<g id="layer-base">\n${innerOf(base)}\n</g>`);
    } else if (chosen[layer]) {
      const f = path.join(ART, 'parts', `${layer}-${chosen[layer]}.svg`);
      const inner = innerOf(fs.readFileSync(f, 'utf8'));
      groups.push(`<g id="layer-${layer}-${chosen[layer]}">\n${inner}\n</g>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">\n<!-- Agent X Robot loadout: ${Object.entries(chosen).map(([k, v]) => `${k}=${v}`).join(' ') || 'bare base'} -->\n${groups.join('\n')}\n</svg>\n`;
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const spec = get('--parts') || '';
  const out = get('--out');
  if (!out) { console.error('need --out <file.svg>'); process.exit(1); }
  const size = get('--size') || '1000';
  const chosen = parseParts(spec);
  const svg = compose(chosen);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, svg);
  console.log(`wrote ${out}`);
  if (args.includes('--png')) {
    const png = out.replace(/\.svg$/i, '.png');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', out, '-vf', `scale=${size}:${size}`, png]);
    console.log(`wrote ${png}`);
  }
}

if (require.main === module) main();
module.exports = { compose, parseParts, LAYER_ORDER };
