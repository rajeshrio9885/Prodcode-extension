'use strict';
// Correctness patterns. analyze(code) -> [{ line, problem, fix, rule }]
//   #19 JSON.parse without try/catch
//   #26 destructuring null/undefined
//   #10 forEach with async callback
//   #7  Promise executor that never settles
//   #12 missing return after a response
//   #11 await without try/catch
//   #35 for...of over a nullable source
//   #5  async-library task whose callback is never called (hangs the request)
const { parse } = require('../parse');

const PATTERN_RULES = {
  JSON_PARSE: true,
  DESTRUCTURE_NULL: true,
  FOREACH_ASYNC: true,
  PROMISE_NEVER_SETTLES: true,
  MISSING_RETURN_AFTER_RES: true,
  AWAIT_WITHOUT_TRY: true,
  FOR_OF_NULLABLE: true,
  ASYNC_CALLBACK_NEVER_CALLED: true,
  ARRAY_CALLBACK_RETURN: true, // #9
  MISSING_DEFAULT_CASE: true, // #20
  COND_ASSIGN: true, // #16
  LOOSE_EQUALITY: true, // #17
  INFINITE_LOOP: true, // #21
  EMPTY_BLOCK: true // #29
};

const RES_METHODS = new Set(['send', 'json', 'jsonp', 'end', 'redirect', 'sendStatus', 'sendFile', 'render']);
const SAFE_FOROF_ROOTS = new Set(['Object', 'Array', 'JSON', 'process', 'require']);
// Array methods whose callback MUST return a value (forEach is intentionally NOT here).
const RETURN_REQUIRED_METHODS = new Set([
  'map', 'filter', 'reduce', 'reduceRight', 'every', 'some', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort'
]);

// True if the block contains a `return <value>` on its own level (not inside a
// nested function). Used to detect callbacks that forget to return.
function hasReturnValue(node) {
  let found = false;
  (function w(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration') {
      return; // do not descend into nested functions
    }
    if (n.type === 'ReturnStatement' && n.argument) {
      found = true;
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c));
      else if (v && typeof v.type === 'string') w(v);
    }
  })(node);
  return found;
}

// --- #21 infinite-loop helpers ---------------------------------------------
// A constant, always-true loop condition (while(true), while(1), …).
function isConstantTruthy(test) {
  return !!(test && test.type === 'Literal' && test.value);
}

// Simple identifiers referenced in the loop condition. Returns null if the test
// involves a call or member access (too dynamic to reason about → skip).
function loopTestVars(test) {
  const vars = new Set();
  let simple = true;
  (function w(n) {
    if (!n || typeof n.type !== 'string' || !simple) return;
    if (n.type === 'CallExpression' || n.type === 'MemberExpression') {
      simple = false;
      return;
    }
    if (n.type === 'Identifier') vars.add(n.name);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c));
      else if (v && typeof v.type === 'string') w(v);
    }
  })(test);
  return simple ? vars : null;
}

// Identifiers that could change in `node`: assigned, ++/--'d, or passed to a call.
function collectModified(node) {
  const mod = new Set();
  (function w(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') mod.add(n.left.name);
    if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier') mod.add(n.argument.name);
    if (n.type === 'CallExpression') {
      for (const a of n.arguments) if (a.type === 'Identifier') mod.add(a.name);
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c));
      else if (v && typeof v.type === 'string') w(v);
    }
  })(node);
  return mod;
}

// A break / return / throw that would let the loop terminate (ignores bodies of
// nested functions, where a break would belong to a different construct).
function hasLoopEscape(node) {
  let found = false;
  (function w(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration') {
      return;
    }
    if (n.type === 'BreakStatement' || n.type === 'ReturnStatement' || n.type === 'ThrowStatement') {
      found = true;
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c));
      else if (v && typeof v.type === 'string') w(v);
    }
  })(node);
  return found;
}

const ASYNC_TASK_COLLECTION = new Set(['waterfall', 'series', 'parallel', 'parallelLimit', 'race', 'tryEach']);
const ASYNC_ITERATEE_ARG = {
  each: 1, eachSeries: 1, forEachOf: 1, eachOf: 1, eachOfSeries: 1, map: 1, mapSeries: 1,
  mapValues: 1, filter: 1, filterSeries: 1, reject: 1, rejectSeries: 1, concat: 1,
  concatSeries: 1, some: 1, every: 1, detect: 1, sortBy: 1, groupBy: 1, times: 1,
  eachLimit: 2, eachOfLimit: 2, mapLimit: 2, mapValuesLimit: 2, filterLimit: 2,
  rejectLimit: 2, concatLimit: 2, someLimit: 2, everyLimit: 2, detectLimit: 2
};
const IGNORE_MARKER = 'safety-ignore';

function isMemberCall(node, objName, propName) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    (objName === null ||
      (node.callee.object.type === 'Identifier' && node.callee.object.name === objName)) &&
    node.callee.property.name === propName
  );
}

function inTryBlock(ancestors, node) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type === 'TryStatement') {
      const child = i + 1 < ancestors.length ? ancestors[i + 1] : node;
      if (ancestors[i].block === child) return true;
    }
  }
  return false;
}

function endsWithCatch(arg) {
  return (
    arg && arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression' &&
    !arg.callee.computed && arg.callee.property.name === 'catch'
  );
}

function isResResponse(expr) {
  return (
    expr && expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression' &&
    !expr.callee.computed && expr.callee.object.type === 'Identifier' &&
    (expr.callee.object.name === 'res' || expr.callee.object.name === 'response') &&
    RES_METHODS.has(expr.callee.property.name)
  );
}

function isFn(n) {
  return n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

function collectTaskFns(arg, fns) {
  if (!arg) return;
  if (arg.type === 'ArrayExpression') {
    for (const el of arg.elements) {
      if (isFn(el)) fns.push(el);
      else if (el && el.type === 'ArrayExpression' && el.elements.length) {
        const last = el.elements[el.elements.length - 1];
        if (isFn(last)) fns.push(last);
      }
    }
  } else if (arg.type === 'ObjectExpression') {
    for (const prop of arg.properties) {
      if (prop.type !== 'Property') continue;
      if (isFn(prop.value)) fns.push(prop.value);
      else if (prop.value.type === 'ArrayExpression' && prop.value.elements.length) {
        const last = prop.value.elements[prop.value.elements.length - 1];
        if (isFn(last)) fns.push(last);
      }
    }
  }
}

function countCallbackUse(body, name) {
  let count = 0;
  (function w(n, parent) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier' && n.name === name) {
      const isProp = parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed;
      const isKey = parent && parent.type === 'Property' && parent.key === n && !parent.computed;
      if (!isProp && !isKey) count++;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c, n));
      else if (v && typeof v.type === 'string') w(v, n);
    }
  })(body, null);
  return count;
}

// Classify references to the callback so we only run the strict "every path"
// analysis when the callback is used ONLY as a direct synchronous call at the
// task's own level. If it is passed as a value (`setTimeout(cb)`) or referenced
// inside a nested function (a DB/query callback), we assume it is wired up
// asynchronously and DON'T flag — that keeps false positives out.
function classifyCbRefs(body, name) {
  let directCalls = 0;
  let nestedOrValue = 0;
  (function w(n, parent, nested) {
    if (!n || typeof n.type !== 'string') return;
    const innerNested =
      nested ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'FunctionDeclaration';
    if (n.type === 'Identifier' && n.name === name) {
      const isProp = parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed;
      const isKey = parent && parent.type === 'Property' && parent.key === n && !parent.computed;
      if (!isProp && !isKey) {
        const isDirectCall = parent && parent.type === 'CallExpression' && parent.callee === n;
        if (nested || !isDirectCall) nestedOrValue++;
        else directCalls++;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && w(c, n, innerNested));
      else if (v && typeof v.type === 'string') w(v, n, innerNested);
    }
  })(body, null, false);
  return { directCalls, nestedOrValue };
}

function callsCb(expr, name) {
  return expr && expr.type === 'CallExpression' && expr.callee.type === 'Identifier' && expr.callee.name === name;
}

// True when EVERY control path through `node` synchronously calls the callback
// (or throws / returns the callback call). A conservative approximation: an
// `if` with no `else`, a loop body, or a plain fall-through does NOT settle.
function settles(node, name) {
  if (!node) return false;
  switch (node.type) {
    case 'ExpressionStatement':
      return callsCb(node.expression, name);
    case 'ReturnStatement':
      return callsCb(node.argument, name);
    case 'ThrowStatement':
      return true;
    case 'BlockStatement':
      return settlesSeq(node.body, name);
    case 'IfStatement':
      return node.alternate ? settles(node.consequent, name) && settles(node.alternate, name) : false;
    case 'TryStatement': {
      if (node.finalizer && settles(node.finalizer, name)) return true;
      const blockOk = settles(node.block, name);
      const handlerOk = !node.handler || settles(node.handler.body, name);
      return blockOk && handlerOk;
    }
    case 'SwitchStatement': {
      let hasDefault = false;
      let allOk = true;
      for (const c of node.cases) {
        if (!c.test) hasDefault = true;
        if (c.consequent.length && !settlesSeq(c.consequent, name)) allOk = false;
      }
      return hasDefault && allOk;
    }
    default:
      return false;
  }
}

function settlesSeq(stmts, name) {
  for (const s of stmts) if (settles(s, name)) return true;
  return false;
}

function bodySettles(fn, name) {
  return fn.body.type === 'BlockStatement'
    ? settlesSeq(fn.body.body, name)
    : callsCb(fn.body, name);
}

function analyze(code) {
  const ast = parse(code);
  if (!ast) return [];
  const lines = code.split('\n');
  const out = [];

  function add(line, problem, fix, rule) {
    if ((lines[line - 1] || '').includes(IGNORE_MARKER)) return;
    out.push({ line, problem, fix, rule });
  }
  function srcOf(node) {
    return code.slice(node.range[0], node.range[1]).replace(/\s+/g, '');
  }

  walk(ast, []);

  function walk(node, ancestors) {
    if (!node || typeof node.type !== 'string') return;
    detect(node, ancestors);
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c.type === 'string') walk(c, ancestors);
      } else if (val && typeof val.type === 'string') {
        walk(val, ancestors);
      }
    }
    ancestors.pop();
  }

  function detect(node, ancestors) {
    const line = node.loc.start.line;

    if (PATTERN_RULES.JSON_PARSE && isMemberCall(node, 'JSON', 'parse') && !inTryBlock(ancestors, node)) {
      add(node.callee.property.loc.start.line, 'JSON.parse() is not inside try/catch — invalid JSON throws', 'wrap it in try { } catch { }', '#19');
    }

    if (
      PATTERN_RULES.DESTRUCTURE_NULL && node.type === 'VariableDeclarator' &&
      (node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern') && node.init &&
      ((node.init.type === 'Literal' && node.init.value === null) ||
        (node.init.type === 'Identifier' && node.init.name === 'undefined'))
    ) {
      add(line, 'destructuring null/undefined throws at runtime', 'default the source (e.g. = src || {}) or guard first', '#26');
    }

    if (
      PATTERN_RULES.FOREACH_ASYNC && node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' && !node.callee.computed &&
      node.callee.property.name === 'forEach'
    ) {
      const cb = node.arguments[0];
      if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && cb.async) {
        add(node.callee.property.loc.start.line, 'forEach with an async callback does NOT await each iteration', 'use for...of, or await Promise.all(arr.map(async ...))', '#10');
      }
    }

    if (
      PATTERN_RULES.PROMISE_NEVER_SETTLES && node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' && node.callee.name === 'Promise'
    ) {
      const ex = node.arguments[0];
      if (ex && (ex.type === 'ArrowFunctionExpression' || ex.type === 'FunctionExpression') && ex.body) {
        const names = (ex.params || []).filter((p) => p.type === 'Identifier').map((p) => p.name);
        if (names.length > 0) {
          const body = code.slice(ex.body.range[0], ex.body.range[1]);
          const used = names.some((n) => new RegExp('\\b' + n + '\\b').test(body));
          if (!used) add(line, 'Promise executor never calls resolve or reject — the promise will hang forever', 'call resolve(...) or reject(...) on every path', '#7');
        }
      }
    }

    if (PATTERN_RULES.MISSING_RETURN_AFTER_RES && node.type === 'ExpressionStatement' && isResResponse(node.expression)) {
      const block = ancestors[ancestors.length - 1];
      if (block && block.type === 'BlockStatement') {
        const idx = block.body.indexOf(node);
        const next = block.body[idx + 1];
        const method = node.expression.callee.property.name;
        if (next && next.type !== 'ReturnStatement') {
          add(line, 'response sent but code keeps running after it (duplicate response / headers-sent risk)', 'add `return` before res.' + method + '(...)', '#12');
        } else if (!next) {
          const ifStmt = ancestors[ancestors.length - 2];
          const outer = ancestors[ancestors.length - 3];
          if (
            ifStmt && ifStmt.type === 'IfStatement' &&
            (ifStmt.consequent === block || ifStmt.alternate === block) &&
            outer && outer.type === 'BlockStatement'
          ) {
            const ii = outer.body.indexOf(ifStmt);
            const afterIf = outer.body[ii + 1];
            if (afterIf && afterIf.type !== 'ReturnStatement') {
              add(line, 'response sent inside if, but execution falls through to code after the if', 'add `return` before res.' + method + '(...)', '#12');
            }
          }
        }
      }
    }

    if (PATTERN_RULES.AWAIT_WITHOUT_TRY && node.type === 'AwaitExpression') {
      if (!inTryBlock(ancestors, node) && !endsWithCatch(node.argument)) {
        add(line, 'await is not inside try/catch and the promise has no .catch() — unhandled rejection risk', 'wrap in try { } catch { }, or add .catch(...) to the awaited call', '#11');
      }
    }

    if (PATTERN_RULES.FOR_OF_NULLABLE && node.type === 'ForOfStatement') {
      const r = node.right;
      let risky = false;
      if (r.type === 'Identifier' && !SAFE_FOROF_ROOTS.has(r.name)) risky = true;
      else if (r.type === 'MemberExpression' && !r.optional) risky = true;
      if (risky) {
        add(r.loc.start.line, 'for...of over "' + srcOf(r) + '" which may be null/undefined', 'use for (const x of (' + srcOf(r) + ' || []))', '#35');
      }
    }

    // #9 forgotten return in a .map()/.filter()/.reduce()/... callback
    if (
      PATTERN_RULES.ARRAY_CALLBACK_RETURN && node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' && !node.callee.computed &&
      RETURN_REQUIRED_METHODS.has(node.callee.property.name)
    ) {
      const cb = node.arguments[0];
      if (
        cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') &&
        cb.body.type === 'BlockStatement' && !hasReturnValue(cb.body)
      ) {
        const m = node.callee.property.name;
        add(node.callee.property.loc.start.line, '.' + m + '() callback never returns a value — ' + m + ' will see undefined for every element', 'return a value from the callback (e.g. return x.name)', '#9');
      }
    }

    // #20 switch without a default case
    if (PATTERN_RULES.MISSING_DEFAULT_CASE && node.type === 'SwitchStatement') {
      const hasDefault = node.cases.some((c) => c.test === null);
      if (!hasDefault) {
        add(node.loc.start.line, 'switch has no default case — unhandled values fall through silently', 'add a `default:` case (or `// safety-ignore` if intentional)', '#20');
      }
    }

    // #16 assignment used as a condition: if (x = 1)
    if (PATTERN_RULES.COND_ASSIGN) {
      const condHolders = ['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'];
      if (condHolders.includes(node.type) && node.test && node.test.type === 'AssignmentExpression') {
        add(node.test.loc.start.line, 'assignment (=) used as a condition — did you mean === ?', 'use === for comparison, or wrap an intentional assignment in extra ( )', '#16');
      }
    }

    // #17 loose equality
    if (
      PATTERN_RULES.LOOSE_EQUALITY && node.type === 'BinaryExpression' &&
      (node.operator === '==' || node.operator === '!=')
    ) {
      add(node.loc.start.line, 'loose equality "' + node.operator + '" coerces types (0 == false, "" == 0)', 'use "' + (node.operator === '==' ? '===' : '!==') + '" instead', '#17');
    }

    // #21 infinite loop
    if (PATTERN_RULES.INFINITE_LOOP && (node.type === 'WhileStatement' || node.type === 'DoWhileStatement')) {
      if (isConstantTruthy(node.test) && !hasLoopEscape(node.body)) {
        add(node.loc.start.line, 'loop condition is always true and the body has no break/return — infinite loop', 'use a real exit condition, or add a break', '#21');
      } else {
        const vars = loopTestVars(node.test);
        if (vars && vars.size > 0) {
          const modified = collectModified(node.body);
          const noneChange = [...vars].every((v) => !modified.has(v));
          if (noneChange) {
            add(node.loc.start.line, 'loop condition variable(s) [' + [...vars].join(', ') + '] are never changed in the loop — infinite loop', 'update the variable inside the loop (e.g. i++) or add a break', '#21');
          }
        }
      }
    }

    // #29 empty catch / empty block (a block with a comment inside is allowed)
    if (PATTERN_RULES.EMPTY_BLOCK && node.type === 'BlockStatement' && node.body.length === 0) {
      const parent = ancestors[ancestors.length - 1];
      const SKIP = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock']);
      if (parent && !SKIP.has(parent.type)) {
        const inner = code.slice(node.range[0] + 1, node.range[1] - 1);
        if (!/\S/.test(inner)) {
          if (parent.type === 'CatchClause') {
            add(node.loc.start.line, 'empty catch block silently swallows the error', 'log or handle the error (or add `// safety-ignore` if truly intentional)', '#29');
          } else {
            add(node.loc.start.line, 'empty block', 'remove it or add a comment explaining why it is intentionally empty', '#29');
          }
        }
      }
    }

    if (
      PATTERN_RULES.ASYNC_CALLBACK_NEVER_CALLED && node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' && !node.callee.computed &&
      node.callee.object.type === 'Identifier' && node.callee.object.name === 'async'
    ) {
      const method = node.callee.property.name;
      const fns = [];
      if (ASYNC_TASK_COLLECTION.has(method) || method === 'auto') {
        collectTaskFns(node.arguments[0], fns);
      } else if (ASYNC_ITERATEE_ARG[method] !== undefined) {
        const f = node.arguments[ASYNC_ITERATEE_ARG[method]];
        if (isFn(f)) fns.push(f);
      }
      for (const fn of fns) {
        const params = fn.params || [];
        if (params.length === 0) {
          add(fn.loc.start.line, 'async.' + method + ' task has no completion callback parameter — it can never finish; the request will hang', 'add a callback as the last parameter and call it on every path', '#5');
          continue;
        }
        const cb = params[params.length - 1];
        if (cb.type !== 'Identifier') continue;

        const total = countCallbackUse(fn.body, cb.name);
        if (total === 0) {
          add(fn.loc.start.line, 'async.' + method + ' task never calls its callback "' + cb.name + '" — the chain and the request will hang', 'call ' + cb.name + '(err) or ' + cb.name + '(null, result) on every path', '#5');
          continue;
        }
        // Strict "every path" check only when the callback is used solely as a
        // direct synchronous call (not passed as a value, not inside a nested
        // async callback) — otherwise we can't prove a missed path.
        const refs = classifyCbRefs(fn.body, cb.name);
        if (refs.nestedOrValue === 0 && !bodySettles(fn, cb.name)) {
          add(fn.loc.start.line, 'async.' + method + ' task only calls "' + cb.name + '" on some paths (e.g. an if with no else) — when that branch is skipped the chain and request hang', 'call ' + cb.name + '(...) on EVERY path (add an else / a trailing call / return ' + cb.name + '(...))', '#5');
        }
      }
    }
  }

  return out;
}

module.exports = { analyze };
