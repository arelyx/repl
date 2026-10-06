fn main() {
    println!("Hello, Rust!");
    let squares: Vec<u32> = (1..=5).map(|x| x * x).collect();
    println!("squares: {:?}", squares);
}
