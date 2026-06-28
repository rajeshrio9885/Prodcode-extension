'use strict';
// Computes the set of line numbers in the CURRENT editor buffer that differ from
// the file's committed version (git HEAD). Works on unsaved edits because we diff
// HEAD's blob against the live text the editor passes in — no need to save first.
//
// Returns:
//   Set<number>  → 1-based line numbers that are new/changed vs HEAD
//   'ALL'        → file is untracked / not in a git repo → treat every line as changed
const { execFileSync } = require('child_process');
const path = require('path');
const Diff = require('diff');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
}

function normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

function getChangedLines(fsPath, currentText) {
  const dir = path.dirname(fsPath);

  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], dir).trim();
  } catch (e) {
    return 'ALL'; // not inside a git repo
  }

  const rel = path.relative(root, fsPath).split(path.sep).join('/');

  let headText;
  try {
    headText = git(['show', `HEAD:${rel}`], root);
  } catch (e) {
    return 'ALL'; // new / untracked file — everything is "changed"
  }

  const changed = new Set();
  const patch = Diff.structuredPatch('a', 'b', normalize(headText), normalize(currentText), '', '', {
    context: 0
  });
  for (const hunk of patch.hunks) {
    let newLine = hunk.newStart;
    for (const ln of hunk.lines) {
      if (ln.startsWith('+')) {
        changed.add(newLine);
        newLine++;
      } else if (ln.startsWith('-')) {
        // removed line — does not exist in the new file
      } else {
        newLine++;
      }
    }
  }
  return changed;
}

module.exports = { getChangedLines };
