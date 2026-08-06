fn main() {
    let mut checksum: i64 = 0;
    for index in 0_i64..1_000_000_000_i64 {
        let value = std::hint::black_box(index * 17);
        checksum += value - ((value / 251) * 251);
    }
    println!("{}", checksum);
}
