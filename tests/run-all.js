/* Runs every suite and exits non-zero if any assertion failed.
     node tests/run-all.js
   Each suite eval()s the REAL functions out of Code.gs / Index.html with only
   the sheet layer stubbed, so they test the shipped code rather than a copy. */
var cp = require('child_process'), path = require('path');
var SUITES = ["authtest","scopetest","uattest","permtest","ytdtest","derivedtest","targettest","importtest","plantest","joincheck","poctest","reloadtest","scaletest","shapetest","cardtest","tattest","diagtest","boottest","omptest"];
var totalP = 0, totalF = 0, broken = [];
SUITES.forEach(function (name) {
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, name + '.js')],
                       { encoding: 'utf8' });
  var out = (r.stdout || '') + (r.stderr || '');
  var m = out.match(/(\d+) passed, (\d+) failed/);
  if (!m) {
    broken.push(name);
    console.log(pad(name) + 'DID NOT REPORT — the suite itself crashed');
    console.log(out.split('\n').slice(-12).join('\n'));
    return;
  }
  var p = Number(m[1]), f = Number(m[2]);
  totalP += p; totalF += f;
  console.log(pad(name) + p + ' passed, ' + f + ' failed' + (f ? '   <<<<' : ''));
  if (f) console.log(out.split('\n').filter(function (l) {
    return l.indexOf('FAIL') === 0; }).join('\n'));
});
function pad(s) { while (s.length < 14) s += ' '; return s; }
console.log('');
console.log(totalP + ' passed, ' + totalF + ' failed across ' + SUITES.length + ' suites');
/* a suite that crashed reported nothing, which must not read as success */
if (broken.length) console.log('!! did not report: ' + broken.join(', '));
process.exit(totalF || broken.length ? 1 : 0);
