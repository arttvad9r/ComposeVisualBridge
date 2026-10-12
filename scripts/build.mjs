import { build } from 'esbuild';
await build({ entryPoints: ['public/entry.mjs', 'public/app.mjs', 'public/lab.mjs', 'public/native.mjs'], outdir: 'public/build', bundle: true, format: 'esm', minify: true, sourcemap: true, target: 'es2022', legalComments: 'linked', metafile: false });
