trait Operation { fn apply(&self, value: i64) -> i64; }
trait Virtual { fn apply(&self, value: i64) -> i64; }
struct Base;
struct Child;
impl Base { fn apply(&self, value: i64) -> i64 { value + 1 } }
impl Virtual for Child { fn apply(&self, value: i64) -> i64 { value + 2 } }
impl Operation for Child { fn apply(&self, value: i64) -> i64 { value + 2 } }

fn main() {
    let base = Base;
    let child = Child;
    let virtual_value: &dyn Virtual = &child;
    let contract: &dyn Operation = &child;
    let mut checksum: i64 = 1;
    for index in 0..50_000_000i64 {
        checksum = (checksum + base.apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + virtual_value.apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + contract.apply((index ^ checksum) & 2147483647)) & 2147483647;
    }
    println!("{checksum}");
}
