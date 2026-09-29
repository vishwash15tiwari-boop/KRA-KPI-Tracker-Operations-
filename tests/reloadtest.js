/* Exercises the REAL reload() out of Index.html with google.script.run stubbed,
   so the responses can be made to arrive OUT OF ORDER on purpose.

   The bug this guards: every month change fired another apiModel and the last
   reply to arrive won, not the reply for the month actually selected. Pick July
   then August quickly, July's slower reply lands second, and the page shows
   July's numbers under August's heading. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8').replace(/\r\n/g, '\n');
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

/* --- the page's collaborators, stubbed --------------------------------- */
var S = { period: null, periodBusy: false, model: null };
var renders = 0, indexes = 0, toasts = [];
function render() { renders++; }
function index() { indexes++; }
function toast(msg, kind) { toasts.push((kind || 'ok') + ': ' + msg); }

/* a queue of pending calls, so the test decides when each one replies */
var pending = [];
var Api = {
  live: function () { return true; },
  call: function (fn, args, ok, bad) { pending.push({ fn: fn, args: args, ok: ok, bad: bad }); }
};
function serverCalls() { return pending.length; }
function reply(i, model) {
  pending[i].ok({ ok: true, model: model });
}
function replyError(i, msg) { pending[i].ok({ ok: false, error: msg }); }

eval(grab('var _modelCache={}, _reloadSeq=0;', 'function boot(quiet)'));

function model(id) { return { period_id: id, tag: 'model for ' + id }; }
function pick(id) { S.period = id; reload(); }
/* each section starts from a cold cache, or an earlier section's cached
   month silently turns a round trip into a cache hit and the test measures
   the wrong thing — which is exactly what it did on the first run */
function fresh() { invalidateModelCache(); pending = []; renders = 0; indexes = 0; toasts = []; }

console.log('--- one change, one round trip ---');
pick('per_2026-08');
ck('a server call was made', serverCalls(), 1);
ck('it asked for the month picked', pending[0].args[0], 'per_2026-08');
ck('it is apiModel', pending[0].fn, 'apiModel');
ck('busy while in flight', S.periodBusy, true);
ck('  and it re-rendered so the marker can show', renders > 0, true);
reply(0, model('per_2026-08'));
ck('model landed', S.model.tag, 'model for per_2026-08');
ck('no longer busy', S.periodBusy, false);
ck('indexes rebuilt', indexes, 1);

console.log('\n--- THE RACE: replies arrive out of order ---');
fresh();
pick('per_2026-07');
pick('per_2026-08');           /* changed mind before July answered */
ck('two calls in flight', serverCalls(), 2);
reply(1, model('per_2026-08')); /* August answers first */
ck('August is showing', S.model.tag, 'model for per_2026-08');
reply(0, model('per_2026-07')); /* July's slower reply arrives LAST */
ck('July did NOT overwrite August', S.model.tag, 'model for per_2026-08');
ck('  and the stale reply did not re-index', indexes, 1);
ck('  and did not leave the page stuck busy', S.periodBusy, false);

console.log('\n--- three rapid changes: only the last one counts ---');
fresh();
pick('per_2026-06'); pick('per_2026-07'); pick('per_2026-08');
ck('three calls', serverCalls(), 3);
reply(2, model('per_2026-08'));
reply(0, model('per_2026-06'));
reply(1, model('per_2026-07'));
ck('still August', S.model.tag, 'model for per_2026-08');
ck('exactly one index rebuild', indexes, 1);

console.log('\n--- the cache: a month already seen costs no round trip ---');
pending = []; indexes = 0; renders = 0;
pick('per_2026-08');
ck('no server call', serverCalls(), 0);
ck('model served from cache', S.model.tag, 'model for per_2026-08');
ck('  still rendered', renders > 0, true);
ck('  and never left busy on the cache path', S.periodBusy, false);
pick('per_2026-07');
ck('July was cached by its stale reply? no — it must refetch', serverCalls(), 1);

console.log('\n--- a write must invalidate every cached month ---');
fresh();
/* warm two months */
pick('per_2026-07'); reply(0, model('per_2026-07'));
pending = [];
pick('per_2026-08'); reply(0, model('per_2026-08'));
pending = [];
pick('per_2026-07');
ck('July from cache', serverCalls(), 0);
pick('per_2026-08');
ck('August from cache', serverCalls(), 0);
/* what write() does after a save lands */
invalidateModelCache();
pick('per_2026-07');
ck('after invalidation July refetches', serverCalls(), 1);
reply(0, model('per_2026-07'));
pending = [];
pick('per_2026-08');
ck('  and August was invalidated too, not just the saved month', serverCalls(), 1);

console.log('\n--- a failed load reports and clears busy ---');
fresh();
pick('per_2026-09');
replyError(0, 'Year to date is read-only');
ck('not left busy', S.periodBusy, false);
ck('the error was surfaced', /Year to date is read-only/.test(toasts.join('|')), true);
ck('  and nothing was cached for it', (function () {
  pending = []; pick('per_2026-09'); return serverCalls(); })(), 1);

console.log('\n--- a transport failure is handled the same way ---');
fresh();
pick('per_2026-04');
pending[0].bad({ message: 'Could not reach the server.' });
ck('not left busy', S.periodBusy, false);
ck('reported', /Could not reach the server/.test(toasts.join('|')), true);

console.log('\n--- a stale FAILURE must not clear a newer request\'s busy state ---');
fresh();
pick('per_2026-05');
pick('per_2026-06');
pending[0].bad({ message: 'slow one died' });
ck('still busy for the newer month', S.periodBusy, true);
ck('  and the stale failure was not shown', toasts.length, 0);
reply(1, model('per_2026-06'));
ck('newer month lands', S.model.tag, 'model for per_2026-06');
ck('  now not busy', S.periodBusy, false);

console.log('\n--- changing the month must NOT trigger the entrance animation ---');
/* The reveal belongs to a page LOAD. Replaying it on every filter click is
   noise, and it delays numbers somebody is actively comparing. */
fresh();
S.reveal = false;
pick('per_2026-03');
ck('not requested while loading', S.reveal, false);
reply(0, model('per_2026-03'));
ck('  nor when the month lands', S.reveal, false);
pending = [];
pick('per_2026-03');
ck('  nor on a cached month', S.reveal, false);
ck('and no fade state survives anywhere', String(S.fx), 'undefined');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
