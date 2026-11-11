// Self-host OCR code and WASM. Only language data is downloaded on first use.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const target=join(process.cwd(),'public/ocr');
await mkdir(target,{recursive:true});
const library=dirname(require.resolve('tesseract.js/package.json'));
await copyFile(join(library,'dist/worker.min.js'),join(target,'worker.min.js'));
const core=dirname(require.resolve('tesseract.js-core/package.json'));
for(const name of await readdir(core))if(/^tesseract-core.*\.(?:js|wasm)$/.test(name))await copyFile(join(core,name),join(target,name));
console.log('Prepared local OCR worker and WASM assets');
