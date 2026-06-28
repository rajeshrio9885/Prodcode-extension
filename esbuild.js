'use strict';
// Bundles src/extension.js (and its deps espree + diff) into dist/extension.js.
// `vscode` is provided by the host at runtime and must stay external.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.js'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching…');
  } else {
    await esbuild.build(options);
    console.log('esbuild: build complete');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
