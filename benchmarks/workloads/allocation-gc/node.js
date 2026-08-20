import fs from 'node:fs';
class BoxValue{constructor(value){this.value=value;}}let c=1;for(let i=0;i<500000;i++){const b=new BoxValue((i^c)&2147483647);c=(c+b.value)&2147483647;}fs.writeSync(1,`${c}\n`);
