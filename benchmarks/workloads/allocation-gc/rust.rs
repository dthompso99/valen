struct BoxValue{value:i64}
fn main(){let mut c=1i64;for i in 0..500_000i64{let b=Box::new(BoxValue{value:(i^c)&2147483647});c=(c+b.value)&2147483647;}println!("{c}");}
