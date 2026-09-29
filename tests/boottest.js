/* THE BOOT SCREEN: the mark, the flight, and the teardown that has to happen
   on every exit from the load.

   THE OVERLAY MUST NEVER BE ABLE TO STAY UP. It is position:fixed over the
   whole page at z-index 200 and it holds .app scaled to nothing. If a path
   through boot() returns without tearing it down, the reader has a permanently
   blank dashboard that still, invisibly, eats every click. There are three such
   paths — the data landed, the server refused, the call failed — and all three
   are checked here by reading the source, because the two that matter are the
   two that are hardest to reach by hand.

   THE FLIGHT HAS TO MEASURE. It lands the mark on the sidebar logo's real
   rect, which means reading both rects at the moment it flies rather than
   assuming either — and reading them AFTER the hiding class comes off, because
   .app.revealing holds the page at scale(.94) and a rect read through that
   transform is 6% out.

   This file replaced a version that asserted the desk figure that briefly
   stood here — its joints, and the CSS pivots they turned about. Those are
   gone with the drawing. What survives is everything that was never about the
   picture. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = page.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = page.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return page.slice(i, j);
}

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

var css = grab('/* ================================ THE BOOT SCREEN',
               '/* the calculation notes');
var teardown = grab('var _bootShown=false, _bootAt=0;', 'function playReveal(){');
var close = teardown.slice(teardown.indexOf('function closeBoot(){'));

console.log('\n=== THE MARK ===\n');

ck('the overlay carries the Recykal mark',
   teardown.indexOf("<img src=\"'+LOGO+'\" alt=\"\"") >= 0, true);
ck('  and the mark is decorative, not announced',
   /id="bootMark" aria-hidden="true"/.test(teardown), true);
ck('  while the sentence IS announced',
   /class="boot-say" role="status"/.test(teardown), true);
ck('the sentence is the one that was asked for',
   teardown.indexOf('Preparing your performance dashboard') >= 0, true);
/* A near-square mark can be spun; a horizontal lockup cannot, and the comment
   is the only place that reasoning survives. */
ck('the reason a spin is safe here is written down',
   css.indexOf('182x163') >= 0, true);
/* The box must be square and bigger than the image, or a full turn clips the
   corners against the box's own edges. */
ck('the box is square',
   /\.boot-mark\{width:min\(96px,26vw\);height:min\(96px,26vw\)/.test(css), true);
/* Not "smaller than the box" — SMALL ENOUGH TO TURN INSIDE IT. What sweeps
   the box is the image's DIAGONAL, not its width, and at 78% that diagonal
   was 1.047 of the box: the corners swung outside it on every quarter turn.
   Asserted as the geometry rather than as the number, so the next person to
   nudge the percentage is told why it is what it is. */
var pct = Number((css.match(/\.boot-mark img\{width:(\d+)%/) || [])[1]);
ck('the image width is a percentage of the box (' + pct + '%)', pct > 0, true);
var diag = (pct / 100) * Math.sqrt(1 + Math.pow(163 / 182, 2));
ck('  and its diagonal fits inside the box: ' + diag.toFixed(3) + ' of the side',
   diag <= 1, true);
ck('the spin is eased, not linear — a mark turning, not a busy-spinner',
   /animation:bootspin 2\.8s cubic-bezier/.test(css), true);
ck('and it is stopped before it flies, or the loop overwrites the flight',
   /\.boot\.done \.boot-mark\{animation:none\}/.test(css), true);

console.log('\n=== THE FLIGHT ===\n');

ck('it reads BOTH rects rather than assuming either',
   /getBoundingClientRect\(\), b=.*getBoundingClientRect\(\)/.test(close), true);
ck('  and targets the sidebar logo', close.indexOf("$('.sb-logo img')") >= 0, true);
/* Order matters, and is the fault this assertion exists for: measured through
   .app.revealing the target rect is 6% small and the mark lands beside the
   logo rather than on it. */
var clearAt = close.indexOf("classList.remove('revealing')");
var measureAt = close.indexOf('getBoundingClientRect');
ck('the hiding class comes off BEFORE the target is measured',
   clearAt >= 0 && measureAt > clearAt, true);
ck('  and the reason is written down', close.indexOf('scale(.94)') >= 0, true);
ck('the spin is frozen before it is stopped',
   /getComputedStyle\(mark\)\.transform/.test(close), true);
ck('  because stopping it otherwise snaps the mark upright',
   close.indexOf('snaps') >= 0, true);
ck('the flight translates and scales',
   close.indexOf("mark.style.transform='translate('+tx+'px,'+ty+'px) scale('+k+')'") >= 0,
   true);
ck('  and applies no rotate() of its own',
   /style\.transform='translate\([^;]*rotate\(/.test(close), false);
/* The mark is handed over, not hidden. Fading it would make the handover
   invisible, which is the same as it simply disappearing. */
ck('the mark is not faded out with the rest of the overlay',
   /\.boot\.gone \.boot-mark\{[^}]*opacity:0/.test(css), false);

console.log('\n=== THE TEARDOWN ===\n');
var bootFn = grab('function boot(quiet){', 'window.__PerfTracker');

ck('the overlay is painted on a page load', /startBoot\(\)/.test(bootFn), true);
/* quiet is a view-as switch. Covering the page for that reads as a fault. */
ck('  and only when the load is not quiet',
   /if\(!quiet\)\{[^}]*startBoot\(\)/.test(bootFn), true);
var exits = (bootFn.match(/finishBoot\(/g) || []).length;
ck('every exit from the load tears it down again: ' + exits + ' calls', exits >= 2, true);
ck('  the refusal path, without waiting out the minimum',
   /finishBoot\(true\);\s*\n\s*S\.denied/.test(bootFn), true);
ck('  and the transport-failure path, likewise',
   /S\.loading=false; finishBoot\(true\);/.test(bootFn), true);
var renderFn = grab('function render(){', 'var _bootShown=false');
ck('  and the success path, from render',
   /if\(S\.reveal\)\{ S\.reveal=false; if\(!finishBoot\(\)\) playReveal\(\); \}/
     .test(renderFn), true);

/* finishBoot owns playReveal when it owns an overlay — the tiles must not
   stagger in behind a cover that is still opaque, or their entrance is spent
   unseen. It reports back so the caller knows which of them is to run it. */
ck('finishBoot says whether it took the job on',
   /return false;[\s\S]*return true;/.test(teardown), true);
ck('  and the reveal is run from the teardown, not before it',
   /closeBoot[\s\S]*playReveal\(\);/.test(teardown), true);
/* Three ways out of closeBoot — no overlay, reduced motion, the full flight.
   The class that hides the page is cleared ONCE, before any of them can
   branch, which is the only arrangement that cannot miss one. */
ck('the hiding class is cleared before closeBoot can branch at all',
   clearAt >= 0 && clearAt < close.indexOf('if(!ov)'), true);
ck('every branch of closeBoot still reveals the page',
   (close.match(/playReveal\(\);/g) || []).length, 3);
ck('and the overlay is removed from the document, not just faded',
   (close.match(/ov\.parentNode\) ov\.remove\(\)/g) || []).length >= 2, true);

console.log('\n=== THE HOLD ===\n');
var min = Number((teardown.match(/BOOT_MIN_MS=(\d+)/) || [])[1]);
ck('there is a minimum hold', min > 0, true);
ck('  short enough not to be felt as a delay (' + min + 'ms)', min <= 2000, true);
/* The one thing that must NOT be here is a ceiling. A timer that lifted the
   cover on its own would show an empty dashboard whenever the load ran long.
   The overlay comes down when the data lands and not before. */
ck('and no ceiling — the cover comes off when the data lands',
   /setTimeout\(closeBoot,\s*BOOT_MIN_MS\)/.test(teardown), false);
ck('the hold is skipped for a reader who asked for less motion',
   /\(now\|\|lessMotion\(\)\)\?0:/.test(teardown), true);

console.log('\n=== IT STAYS OUT OF THE WAY ===\n');
ck('the overlay is fixed and clipped, so it cannot add a scrollbar',
   /\.boot\{position:fixed;inset:0;z-index:200;overflow:hidden;/.test(css), true);
ck('the mark is capped against the viewport, not just in px',
   /width:min\(96px,26vw\)/.test(css), true);
/* Every moving part must stop under reduced motion — including the ones added
   last, which is how this gets forgotten. */
var rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
['boot-mark', 'boot-say', 'boot-dots'].forEach(function (c) {
  ck('  .' + c + ' is stilled under reduced motion', rm.indexOf('.' + c) >= 0, true);
});
ck('  the flight is skipped rather than slowed',
   /if\(lessMotion\(\)\)\{/.test(close), true);
ck('  and the page is never scaled or hidden for them',
   /\.app\.revealing\{transform:none;opacity:1\}/.test(rm), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
