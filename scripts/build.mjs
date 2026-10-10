import { build } from 'esbuild';
await build({ entryPoints: ['public/app.mjs', 'public/lab.mjs'], outdir: 'public/build', bundle: true, format: 'esm', minify: true, sourcemap: true, target: 'es2022', legalComments: 'linked', metafile: false });
