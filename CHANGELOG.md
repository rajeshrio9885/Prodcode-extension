# Changelog

## 0.1.0

- Initial release.
- Live diagnostics on changed lines (vs git `HEAD`) for `.js` / `.jsx`.
- Null/undefined safety rules (#1, #2, #22, #24, #25).
- Correctness patterns: `JSON.parse` without try/catch (#19), destructure null (#26),
  `forEach(async)` (#10), promise-never-settles (#7), `await` without try/catch (#11),
  missing `return` after response (#12), `for…of` over nullable (#35),
  `async`-library callback never called (#5).
- `// safety-ignore` per-line suppression.
- Configurable severity and per-group rule toggles.
