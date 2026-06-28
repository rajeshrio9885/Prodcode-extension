'use strict';
// Node smoke test — runs the rule cores directly (no VS Code needed) so we can
// verify detection in CI / locally before packaging.
const assert = require('assert');
const { analyze: analyzeNull } = require('../src/checks/nullUndefined');
const { analyze: analyzePatterns } = require('../src/checks/patterns');

function rules(violations) {
  return violations.map((v) => v.rule).sort();
}

// null-safety
{
  const code = [
    'function f(req, res) {',
    '  const a = req.body.user.email.trim();', // deep member
    '  const b = (req.body.list || []).map(x => x);', // guarded -> OK
    '  return res.json({ a, b });',
    '}'
  ].join('\n');
  const v = analyzeNull(code);
  assert.strictEqual(v.length, 1, 'expected 1 null-safety hit, got ' + v.length);
  assert.strictEqual(v[0].rule, '#1 null-safety');
  console.log('OK null-safety:', v[0].problem);
}

// patterns
{
  const code = [
    'async function h(req, res) {',
    '  const cfg = JSON.parse(req.body.cfg);', // #19
    '  if (req.body.bad) { res.json({}); }', // #12
    '  items.forEach(async (x) => { await save(x); });', // #10 + #11
    '  for (const it of req.body.list) { use(it); }', // #35
    '  return cfg;',
    '}'
  ].join('\n');
  const got = rules(analyzePatterns(code));
  for (const r of ['#19', '#12', '#10', '#11', '#35']) {
    assert.ok(got.includes(r), 'expected ' + r + ' in ' + JSON.stringify(got));
  }
  console.log('OK patterns:', got.join(' '));
}

// async callback hang
{
  const code = [
    'function g(cb) {',
    '  async.waterfall([',
    '    function step1(next) { compute(); },', // never calls next
    '    function step2(data, next) { next(null, data); }', // OK
    '  ], cb);',
    '}'
  ].join('\n');
  const got = analyzePatterns(code).filter((v) => v.rule === '#5');
  assert.strictEqual(got.length, 1, 'expected 1 async-hang hit, got ' + got.length);
  console.log('OK async-hang:', got[0].problem);
}

// async callback called only on SOME paths (partial-path hang)
{
  const bug = 'async.parallel({ a: function (par_cb) { if (Enterprise) { par_cb(); } } }, done);';
  const okElse = 'async.parallel({ a: function (cb) { if (x) { cb(1); } else { cb(2); } } }, done);';
  const okNested = 'async.parallel({ a: function (cb) { db.find((e, d) => { cb(e, d); }); } }, done);';
  assert.strictEqual(analyzePatterns(bug).filter((v) => v.rule === '#5').length, 1, 'partial-path bug should flag');
  assert.strictEqual(analyzePatterns(okElse).filter((v) => v.rule === '#5').length, 0, 'if/else both-call should not flag');
  assert.strictEqual(analyzePatterns(okNested).filter((v) => v.rule === '#5').length, 0, 'nested-callback should not flag');
  console.log('OK partial-path: flags if-no-else, clears if/else + nested');
}

// #9 forgotten return in array callback
{
  const bug = 'const m = doc?.map((x) => { x.name; });';
  const ok = 'const m = arr.map((x) => x.name);';
  const okForEach = 'arr.forEach((x) => { x.name; });';
  assert.strictEqual(analyzePatterns(bug).filter((v) => v.rule === '#9').length, 1, 'map without return should flag');
  assert.strictEqual(analyzePatterns(ok).filter((v) => v.rule === '#9').length, 0, 'map expression body should not flag');
  assert.strictEqual(analyzePatterns(okForEach).filter((v) => v.rule === '#9').length, 0, 'forEach should not flag');
  console.log('OK array-callback-return: flags map-without-return, clears expr-body + forEach');
}

// #20 missing default case
{
  const bug = 'switch (r) { case 1: break; }';
  const ok = 'switch (r) { case 1: break; default: break; }';
  assert.strictEqual(analyzePatterns(bug).filter((v) => v.rule === '#20').length, 1, 'switch without default should flag');
  assert.strictEqual(analyzePatterns(ok).filter((v) => v.rule === '#20').length, 0, 'switch with default should not flag');
  console.log('OK default-case: flags switch-without-default, clears with-default');
}

// #16/#17/#21/#29 (ESLint-parity rules)
{
  const r = (code, rule) => analyzePatterns(code).filter((v) => v.rule === rule).length;
  assert.strictEqual(r('const c=1; while(c<10){ x=c; }', '#21'), 1, 'unmodified loop var should flag');
  assert.strictEqual(r('let i=0; while(i<10){ i++; }', '#21'), 0, 'i++ loop should not flag');
  assert.strictEqual(r('while(true){ if(x) break; }', '#21'), 0, 'while(true) with break should not flag');
  assert.strictEqual(r('if (a = 1) {}', '#16'), 1, 'assignment in if should flag');
  assert.strictEqual(r('if (a == b) {}', '#17'), 1, 'loose == should flag');
  assert.strictEqual(r('if (a === b) {}', '#17'), 0, 'strict === should not flag');
  assert.strictEqual(r('try{f()}catch(e){}', '#29'), 1, 'empty catch should flag');
  assert.strictEqual(r('try{f()}catch(e){/*ok*/}', '#29'), 0, 'commented catch should not flag');
  assert.strictEqual(r('const f = () => {};', '#29'), 0, 'empty fn body should not flag');
  console.log('OK eslint-parity: #16 #17 #21 #29 flag bugs, clear safe forms');
}

console.log('\nAll smoke tests passed.');
