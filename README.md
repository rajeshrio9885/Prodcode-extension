# Guardian JS

Live, in-editor highlighting of **crash-prone JavaScript patterns** — the bugs that throw `TypeError: Cannot read properties of undefined`, hang requests on un-settled promises/callbacks, or send duplicate HTTP responses.

It squiggles **only the lines you have changed** vs the last git commit (`HEAD`), so it focuses on the code you're writing — not the whole legacy file.

## What it flags

| Rule | Pattern | Example |
|---|---|---|
| `#1` | Unguarded null/undefined access | `req.body.user.email.trim()` |
| `#2` | Array index access | `arr[0].name` |
| `#22` | Missing optional chaining | `a.b.c.d` |
| `#24` | String method on possibly-undefined | `value.trim()` |
| `#25` | Array method on possibly-undefined | `users.map(...)` |
| `#35` | `for…of` over a nullable source | `for (const x of arr)` |
| `#19` | `JSON.parse` without try/catch | `JSON.parse(data)` |
| `#26` | Destructuring `null`/`undefined` | `const { x } = null` |
| `#10` | `forEach` with an async callback | `items.forEach(async i => { await … })` |
| `#7` | Promise that never settles | `new Promise((resolve) => { /* never calls resolve */ })` |
| `#11` | `await` without try/catch | `const u = await getUser();` |
| `#12` | Missing `return` after a response | `res.json(x); next();` |
| `#5` | `async` library task that never calls its callback (incl. only-on-some-paths) | `async.parallel({ a: fn(next){ if(x) next() } })` |
| `#9` | Forgotten `return` in `.map`/`.filter`/`.reduce`/… | `arr.map(x => { x.name; })` |
| `#16` | Assignment used as a condition | `if (status = 1)` |
| `#17` | Loose equality | `a == b`, `a != b` |
| `#20` | `switch` without a `default` case | `switch(r){ case 1: }` |
| `#21` | Infinite loop (constant / unmodified condition) | `while(c < 10){ /* c never changes */ }` |
| `#29` | Empty catch / empty block | `catch (e) {}` |

Each diagnostic shows **what's wrong** and **how to fix it** on hover.

## What it deliberately does NOT flag (to avoid noise)

- Optional-chained or guarded access: `a?.b?.c`, `(arr || []).map()`, `if (x) x.trim()`
- Known-safe receivers: `req.body`, `req.session`, `res.json()`, `e.target`, `formik.values`
- `require()` bindings and builder chains: `Model.findOne().lean()`, `arr.filter().map()`
- Terminal converters: `id.toString()`, `doc.toObject()`

## Settings

| Setting | Default | Description |
|---|---|---|
| `runtimeSafety.enable` | `true` | Turn diagnostics on/off |
| `runtimeSafety.severity` | `warning` | `error` \| `warning` \| `information` \| `hint` |
| `runtimeSafety.rules.nullSafety` | `true` | Null/undefined access rules |
| `runtimeSafety.rules.patterns` | `true` | Promise/callback/control-flow patterns |

Suppress a single intentional line by adding `// safety-ignore` to it.

## Requirements

Files must be inside a **git repository** (the changed-lines view diffs against `HEAD`). For untracked/new files, every line is treated as changed.

## License

MIT
