import fs from'node:fs';const b=fs.readFileSync(process.argv[2]);let s=0;for(const x of b)s+=x;fs.writeSync(1,`${s}\n`);
