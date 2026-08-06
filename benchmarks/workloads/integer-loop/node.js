import fs from 'node:fs';

let checksum = 0;
for (let index = 0; index < 1_000_000_000; index++) {
    const value = index * 17;
    checksum += value - Math.trunc(value / 251) * 251;
}
fs.writeSync(1, `${checksum}\n`);
