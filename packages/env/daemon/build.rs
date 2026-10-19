fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    let manifest =
        std::fs::read_to_string("../package.json").expect("environment package manifest");
    let version = manifest
        .split("\"version\"")
        .nth(1)
        .and_then(|tail| tail.split('"').nth(1))
        .expect("environment package version");
    println!("cargo:rustc-env=AXI_ENV_VERSION={version}");
}
