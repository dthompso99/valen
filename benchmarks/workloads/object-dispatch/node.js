class Base { apply(value) { return value + 1; } }
class Child extends Base { apply(value) { return value + 2; } }

const base = new Base();
const child = new Child();
const virtualValue = child;
const contract = child;
let checksum = 1;
for (let index = 0; index < 50000000; ++index) {
    checksum = (checksum + base.apply((index ^ checksum) & 2147483647)) & 2147483647;
    checksum = (checksum + virtualValue.apply((index ^ checksum) & 2147483647)) & 2147483647;
    checksum = (checksum + contract.apply((index ^ checksum) & 2147483647)) & 2147483647;
}
fs.writeSync(1, `${checksum}\n`);
import fs from 'node:fs';
