/**
 * Regenerates dist/quickdeploy/{Code.gs,Index.html,appsscript.json} from
 * src/. Not part of the app; run by hand after a source change:
 *   node scripts/generate-quickdeploy.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'src', 'server');
const CLIENT_DIR = path.join(ROOT, 'src', 'client');
const OUT_DIR = path.join(ROOT, 'dist', 'quickdeploy');

// -- Code.gs -----------------------------------------------------------------
const serverFiles = fs.readdirSync(SERVER_DIR).filter(f => f.endsWith('.gs')).sort();
const header = `/**
 * Code.gs — OMP Operations KRA/KPI Tracker
 *
 * Single-file server build. This is a straight concatenation of the modular
 * source in src/server/ (00_Config.gs .. 16_Code.gs), in the same load order,
 * for projects that prefer one Code.gs over ${serverFiles.length} files in the Apps
 * Script editor. Behaviour is identical either way. The section markers below
 * name the original file each block came from.
 */
`;
const blocks = serverFiles.map(f =>
  `// ============================================================================\n` +
  `// ${f}\n` +
  `// ============================================================================\n\n` +
  fs.readFileSync(path.join(SERVER_DIR, f), 'utf8').replace(/\s+$/, '')
);
fs.writeFileSync(path.join(OUT_DIR, 'Code.gs'), header + '\n' + blocks.join('\n\n') + '\n');

// -- Index.html ----------------------------------------------------------
let indexSrc = fs.readFileSync(path.join(CLIENT_DIR, 'Index.html'), 'utf8');
indexSrc = indexSrc.replace(/<\?!= include\('([^']+)'\); \?>/g, (m, name) =>
  fs.readFileSync(path.join(CLIENT_DIR, name + '.html'), 'utf8').replace(/\s+$/, ''));
const indexHeader = `<!--
  Index.html — single-file client build.

  Straight concatenation of src/client/ (Styles + ClientCore + ClientComponents
  + the 9 view modules + ClientBoot) into one file, for projects that prefer
  one HTML file over thirteen in the Apps Script editor. Behaviour is
  identical either way. Regenerate from src/client/ rather than hand-editing
  this file after a source change.
-->
`;
fs.writeFileSync(path.join(OUT_DIR, 'Index.html'), indexHeader + indexSrc);

// -- appsscript.json -------------------------------------------------------
fs.copyFileSync(path.join(ROOT, 'src', 'appsscript.json'), path.join(OUT_DIR, 'appsscript.json'));

console.log('Regenerated dist/quickdeploy from src/ —', serverFiles.length, 'server files.');
