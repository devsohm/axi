#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub command_on_stdin: bool,
}
#[derive(Clone, Copy)]
pub enum OpenMode {
    Read,
    Write,
    Append,
    ReadWrite,
}
#[derive(Debug)]
struct Synthetic(&'static str);
impl std::fmt::Display for Synthetic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Synthetic {}
pub fn synthetic(code: &'static str) -> std::io::Error {
    std::io::Error::other(Synthetic(code))
}
pub fn error_name(error: &std::io::Error) -> &'static str {
    error
        .get_ref()
        .and_then(|e| e.downcast_ref::<Synthetic>())
        .map_or_else(|| os_error_name(error), |code| code.0)
}
pub fn path_exists(path: &str) -> bool {
    std::path::Path::new(path).metadata().is_ok()
}
pub fn cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}
pub fn random_bytes() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let state = std::collections::hash_map::RandomState::new();
    let mut result = [0; 16];
    for chunk in result.chunks_mut(8) {
        let mut hash = state.build_hasher();
        hash.write_u64(NEXT.fetch_add(1, Ordering::Relaxed));
        hash.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        );
        chunk.copy_from_slice(&hash.finish().to_le_bytes());
    }
    result
}
