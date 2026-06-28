'use strict';
// Null/undefined safety — flags the spot where "Cannot read properties of
// undefined (reading 'x')" happens: property/method access whose immediate
// receiver is a multi-level navigation, a possibly-undefined bare variable, or a
// plain function result, unless optional-chained or a known-safe path.
//
// analyze(code) -> [{ line, problem, fix, rule }]
const { parse } = require('../parse');

const RULES = {
  DEEP_MEMBER: true,
  DEPTH1_CALLS: true,
  DEPTH1_READS: false,
  CALL_RESULTS: true,
  FULL_OPTIONAL: true
};

const SAFE_RECEIVERS = new Set([
  'req', 'req.body', 'req.query', 'req.params', 'req.session', 'req.headers',
  'req.cookies', 'req.files', 'req.file', 'req.app', 'res', 'res.locals',
  'this', 'process', 'process.env', 'console', 'JSON', 'Math', 'Object', 'Array',
  'Number', 'String', 'Boolean', 'Date', 'Promise', 'Buffer', 'Symbol', 'Reflect',
  'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Intl', 'URL', 'module',
  'module.exports', 'exports', 'global', 'globalThis', 'require', 'mongoose',
  'router', 'app', 'express', 'Schema', 'next', 'path', 'fs', 'crypto', 'os',
  'util', 'moment', 'dayjs', 'axios', '_', 'lodash', 'logger', 'utils', 'helper',
  'db', 'window', 'window.location', 'document', 'localStorage', 'sessionStorage',
  't', 'dispatch', 'navigate', 'e.target', 'e.currentTarget', 'ev.target',
  'evt.target', 'event.target', 'event.currentTarget', 'this.props', 'this.state',
  'formik.values', 'formik.errors', 'formik.touched'
]);

const SAFE_CALL_METHODS = new Set([
  'find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate',
  'findByIdAndDelete', 'findOneAndDelete', 'findByIdAndRemove', 'where', 'equals',
  'populate', 'select', 'sort', 'limit', 'skip', 'lean', 'exec', 'countDocuments',
  'count', 'distinct', 'aggregate', 'updateOne', 'updateMany', 'deleteOne',
  'deleteMany', 'session', 'setOptions', 'save', 'then', 'catch', 'finally', 'all',
  'allSettled', 'race', 'resolve', 'reject', 'map', 'filter', 'slice', 'concat',
  'splice', 'reverse', 'flat', 'flatMap', 'fill', 'from', 'keys', 'values',
  'entries', 'split', 'replace', 'replaceAll', 'toLowerCase', 'toUpperCase',
  'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'substring', 'substr',
  'repeat', 'normalize', 'toString', 'status', 'set', 'header', 'type', 'cookie',
  'clearCookie', 'location', 'append', 'json', 'assign', 'fromEntries', 'parse',
  'stringify'
]);

const DEPTH1_SKIP_METHODS = new Set([
  'find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate',
  'findByIdAndDelete', 'findOneAndDelete', 'findByIdAndRemove', 'where', 'populate',
  'select', 'lean', 'exec', 'countDocuments', 'count', 'distinct', 'aggregate',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'insertMany', 'create',
  'bulkWrite', 'save', 'remove', 'then', 'catch', 'finally', 'all', 'allSettled',
  'race', 'use', 'get', 'post', 'put', 'delete', 'patch', 'route', 'on', 'once',
  'emit', 'pre', 'listen'
]);

const SAFE_TERMINAL_METHODS = new Set([
  'toString', 'toJSON', 'valueOf', 'toISOString', 'toHexString', 'toObject',
  'toLocaleString'
]);

const ARRAY_METHODS = new Set([
  'map', 'forEach', 'reduce', 'reduceRight', 'filter', 'some', 'every', 'find',
  'findIndex', 'findLast', 'includes', 'indexOf', 'lastIndexOf', 'join', 'push',
  'pop', 'shift', 'unshift', 'splice', 'slice', 'concat', 'flat', 'flatMap',
  'sort', 'reverse', 'fill'
]);

const IGNORE_MARKER = 'safety-ignore';

function srcText(node, code) {
  return code.slice(node.range[0], node.range[1]).replace(/\s+/g, '');
}

function isRequireRooted(node) {
  if (!node) return false;
  if (node.type === 'CallExpression') {
    if (node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      return true;
    }
    return isRequireRooted(node.callee);
  }
  if (node.type === 'MemberExpression') return isRequireRooted(node.object);
  return false;
}

function isSafeCallResult(call) {
  if (isRequireRooted(call)) return true;
  const callee = call.callee;
  if (callee && callee.type === 'MemberExpression' && callee.property && !callee.computed) {
    return SAFE_CALL_METHODS.has(callee.property.name);
  }
  return false;
}

function collectRequireBindings(ast) {
  const safe = new Set();
  (function w(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && isRequireRooted(node.init)) {
      if (node.id.type === 'Identifier') {
        safe.add(node.id.name);
      } else if (node.id.type === 'ObjectPattern') {
        for (const p of node.id.properties) {
          if (p.value && p.value.type === 'Identifier') safe.add(p.value.name);
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (Array.isArray(val)) val.forEach((c) => c && typeof c.type === 'string' && w(c));
      else if (val && typeof val.type === 'string') w(val);
    }
  })(ast);
  return safe;
}

function analyze(code) {
  const ast = parse(code);
  if (!ast) return [];
  const lines = code.split('\n');
  const localSafe = collectRequireBindings(ast);
  const isSafeReceiver = (text) => SAFE_RECEIVERS.has(text) || localSafe.has(text);
  const raw = [];

  walk(ast, null, false);

  function walk(node, parent, inChain) {
    if (!node || typeof node.type !== 'string') return;
    const childInChain = inChain || node.type === 'ChainExpression';
    if (node.type === 'MemberExpression') flag(node, parent, inChain);
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child.type === 'string') walk(child, node, childInChain);
        }
      } else if (val && typeof val.type === 'string') {
        walk(val, node, childInChain);
      }
    }
  }

  function flag(member, parent, inChain) {
    if (parent && parent.type === 'MemberExpression' && parent.object === member) return;
    if (member.optional) return;
    if (!RULES.FULL_OPTIONAL && inChain) return;

    const receiver = member.object;
    if (!receiver) return;
    const isMethodCall = parent && parent.type === 'CallExpression' && parent.callee === member;
    const methodName = member.property && !member.computed ? member.property.name : null;
    if (isMethodCall && SAFE_TERMINAL_METHODS.has(methodName)) return;

    let risky = false;
    let receiverText;

    if (receiver.type === 'MemberExpression') {
      receiverText = srcText(receiver, code);
      if (RULES.DEEP_MEMBER && !isSafeReceiver(receiverText)) risky = true;
    } else if (receiver.type === 'CallExpression') {
      receiverText = srcText(receiver, code);
      if (RULES.CALL_RESULTS && !isSafeCallResult(receiver)) risky = true;
    } else if (receiver.type === 'Identifier') {
      receiverText = receiver.name;
      if (!isSafeReceiver(receiverText)) {
        if (isMethodCall && RULES.DEPTH1_CALLS && !DEPTH1_SKIP_METHODS.has(methodName)) risky = true;
        else if (!isMethodCall && RULES.DEPTH1_READS) risky = true;
      }
    } else {
      return;
    }
    if (!risky) return;

    const line = (member.property.loc || member.loc).start.line;
    if ((lines[line - 1] || '').includes(IGNORE_MARKER)) return;
    raw.push({
      line,
      col: (member.property.loc || member.loc).start.column,
      receiver: receiverText,
      empty: ARRAY_METHODS.has(methodName) ? '[]' : '{}'
    });
  }

  return raw.map((v) => ({
    line: v.line,
    col: v.col,
    problem: `"${v.receiver}" may be undefined/null`,
    fix: `${v.receiver}?.…  OR  (${v.receiver} || ${v.empty}).…  OR  if (${v.receiver}) { … }`,
    rule: '#1 null-safety'
  }));
}

module.exports = { analyze };
