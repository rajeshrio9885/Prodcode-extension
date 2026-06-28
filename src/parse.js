'use strict';
// espree (the parser ESLint uses) — returns an ESTree AST with range + loc, or
// null if the source can't be parsed (we simply skip unparseable buffers so the
// editor never shows spurious diagnostics while you are mid-typing).
const espree = require('espree');

const BASE = {
  ecmaVersion: 'latest',
  range: true,
  loc: true,
  ecmaFeatures: { jsx: true }
};

function parse(code) {
  try {
    return espree.parse(code, { ...BASE, sourceType: 'module' });
  } catch (e1) {
    try {
      return espree.parse(code, { ...BASE, sourceType: 'script' });
    } catch (e2) {
      return null;
    }
  }
}

module.exports = { parse };
