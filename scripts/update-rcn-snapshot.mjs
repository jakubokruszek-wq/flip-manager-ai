import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]||'.rcn-proof/downloads');
function run(command,args){const result=spawnSync(command,args,{stdio:'inherit',env:process.env});if(result.status!==0)throw Error(command+' failed');}
run(process.execPath,['scripts/download-rcn-bulk.mjs',directory]);
const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
run('python3',['scripts/parse-rcn-bulk.py',...manifest.files.map(file=>path.join(directory,file.filename)),'--output',path.join(directory,'rows.json')]);
run(process.execPath,['scripts/build-rcn-snapshot.mjs',path.join(directory,'rows.json'),'scripts/data/lodz-districts.geojson',path.join(directory,'manifest.json')]);
await fs.rm(path.join(directory,'rows.json'),{force:true});
