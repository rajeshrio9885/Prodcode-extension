'use strict';
const vscode = require('vscode');
const { analyze: analyzeNull } = require('./checks/nullUndefined');
const { analyze: analyzePatterns } = require('./checks/patterns');
const { getChangedLines } = require('./changedLines');

let collection;
const timers = new Map();

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint
};

function isSupported(doc) {
  return (
    doc &&
    (doc.languageId === 'javascript' || doc.languageId === 'javascriptreact') &&
    doc.uri.scheme === 'file'
  );
}

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection('runtimeSafety');
  context.subscriptions.push(collection);

  if (vscode.window.activeTextEditor) schedule(vscode.window.activeTextEditor.document);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => schedule(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => schedule(doc)),
    vscode.window.onDidChangeActiveTextEditor((ed) => ed && schedule(ed.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('runtimeSafety') && vscode.window.activeTextEditor) {
        schedule(vscode.window.activeTextEditor.document);
      }
    })
  );
}

function schedule(doc) {
  if (!isSupported(doc)) return;
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      run(doc);
    }, 350)
  );
}

function run(doc) {
  const cfg = vscode.workspace.getConfiguration('runtimeSafety');
  if (!cfg.get('enable', true)) {
    collection.delete(doc.uri);
    return;
  }
  const text = doc.getText();

  let violations = [];
  try {
    if (cfg.get('rules.nullSafety', true)) violations = violations.concat(analyzeNull(text));
    if (cfg.get('rules.patterns', true)) violations = violations.concat(analyzePatterns(text));
  } catch (e) {
    collection.delete(doc.uri);
    return;
  }

  // Only the lines you have changed vs the last commit (HEAD).
  let changed;
  try {
    changed = getChangedLines(doc.uri.fsPath, text);
  } catch (e) {
    changed = 'ALL';
  }

  const severity = SEVERITY[cfg.get('severity', 'warning')] || vscode.DiagnosticSeverity.Warning;
  const diags = [];
  for (const v of violations) {
    if (changed !== 'ALL' && !changed.has(v.line)) continue;
    const idx = v.line - 1;
    if (idx < 0 || idx >= doc.lineCount) continue;
    const lineInfo = doc.lineAt(idx);
    const start = lineInfo.firstNonWhitespaceCharacterIndex;
    const end = lineInfo.range.end.character;
    const range = new vscode.Range(idx, Math.min(start, end), idx, end);
    const d = new vscode.Diagnostic(range, `${v.problem}\nFix: ${v.fix}`, severity);
    d.code = v.rule;
    d.source = 'Runtime Safety';
    diags.push(d);
  }
  collection.set(doc.uri, diags);
}

function deactivate() {
  if (collection) collection.dispose();
}

module.exports = { activate, deactivate };
