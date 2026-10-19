use super::{OpenMode, ShellConfig, path_exists};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::{
    ffi::OsStrExt,
    fs::{FileExt, MetadataExt, OpenOptionsExt},
    process::{CommandExt, ExitStatusExt},
};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

pub const PATH_SEPARATOR: &str = "/";
pub fn os_error_name(error: &io::Error) -> &'static str {
    let Some(code) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match code {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}
pub fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(bytes, offset)
}
pub fn mtime(meta: &Metadata) -> (i64, i64) {
    (meta.mtime(), meta.mtime_nsec())
}
pub fn identity(meta: &Metadata) -> (u64, u64) {
    (meta.dev(), meta.ino())
}
pub fn path_identity(_path: &str, meta: &Metadata, _follow: bool) -> (u64, u64) {
    identity(meta)
}
pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
pub fn tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    let mut text = CString::new(template)
        .map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?
        .into_bytes_with_nul();
    // The writable CString buffer includes its final NUL.
    let created = unsafe { libc::mkdtemp(text.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    text.pop();
    Ok(OsStr::from_bytes(&text).to_string_lossy().into_owned())
}
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | if no_follow { libc::O_NOFOLLOW } else { 0 })
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Read => {
            options.read(true);
        }
        OpenMode::Write => {
            options.write(true).create(true).truncate(true);
        }
        OpenMode::Append => {
            options.append(true).create(true);
        }
        OpenMode::ReadWrite => {
            options.read(true).write(true);
        }
    }
    options.open(path)
}
pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|p| p.to_string_lossy().into_owned())
}
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}
pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}
pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path)
}
pub fn raw_name(name: &OsStr) -> Option<Vec<u8>> {
    Some(name.as_bytes().to_vec())
}
pub fn drive_cwds() -> Map<String, Value> {
    Map::new()
}
pub trait Pipe: io::Read + std::os::fd::AsRawFd {}
impl<T: io::Read + std::os::fd::AsRawFd> Pipe for T {}
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut consume: impl FnMut(&[u8]) -> bool) {
    let fd = pipe.as_raw_fd();
    // This thread owns the pipe and its file status flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut bytes = vec![0; 65536];
    while !stop.load(Ordering::SeqCst) {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // One initialized poll descriptor remains alive throughout the call.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready == 0 {
            continue;
        }
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        match pipe.read(&mut bytes) {
            Ok(0) => return,
            Ok(n) => {
                if !consume(&bytes[..n]) {
                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}
pub fn interrupt_reader(_thread: &std::thread::JoinHandle<()>) {}
pub fn resolve_program(
    program: &str,
    _cwd: &str,
    _env: &Map<String, Value>,
) -> Result<String, Failure> {
    Ok(program.into())
}
pub fn shell_config(configured: Option<&str>) -> Result<ShellConfig, Failure> {
    let program = if let Some(path) = configured {
        if !path_exists(path) {
            return Err(Failure::new(
                "shell_unavailable",
                format!("Custom shell path not found: {path}"),
            ));
        }
        path.into()
    } else if path_exists("/bin/bash") {
        "/bin/bash".into()
    } else {
        Command::new("which")
            .arg("bash")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .lines()
                    .next()
                    .map(str::to_owned)
            })
            .filter(|path| path_exists(path))
            .unwrap_or_else(|| "sh".into())
    };
    Ok(ShellConfig {
        program,
        args: vec!["-c".into()],
        command_on_stdin: false,
    })
}
pub fn configure(
    command: &mut Command,
    args: &[String],
    variables: &Map<String, Value>,
    inherit: bool,
) {
    command.args(args);
    if !inherit {
        command.env_clear();
    }
    for (key, value) in variables {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // Only signal and session syscalls run between fork and exec.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}
pub fn after_spawn(_child: &Child) {}
pub fn kill_tree(pid: u32) {
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) != 0 {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}
