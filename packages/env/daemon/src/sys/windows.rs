use super::{OpenMode, ShellConfig, path_exists, synthetic};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::collections::hash_map::RandomState;
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::os::windows::{
    ffi::OsStrExt,
    fs::FileExt,
    io::{AsRawHandle, FromRawHandle},
    process::CommandExt,
};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::UNIX_EPOCH;
use windows_sys::Win32::{
    Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
    Storage::FileSystem::*,
    System::{IO::CancelSynchronousIo, JobObjects::*, Threading::CREATE_NO_WINDOW},
};

pub const PATH_SEPARATOR: &str = "\\";
pub fn os_error_name(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(1) => "EISDIR",
        Some(2 | 3 | 15 | 123 | 126 | 161 | 267 | 4392) => "ENOENT",
        Some(4) => "EMFILE",
        Some(5 | 1314) => "EPERM",
        Some(6) => "EBADF",
        Some(8 | 14) => "ENOMEM",
        Some(17) => "EXDEV",
        Some(19) => "EROFS",
        Some(32 | 33) => "EBUSY",
        Some(39 | 82 | 112) => "ENOSPC",
        Some(50) => "ENOTSUP",
        Some(80 | 183) => "EEXIST",
        Some(13 | 87 | 122 | 131 | 1464) => "EINVAL",
        Some(145) => "ENOTEMPTY",
        Some(206) => "ENAMETOOLONG",
        Some(998) => "EFAULT",
        Some(740 | 1920) => "EACCES",
        Some(1921) => "ELOOP",
        _ => "UNKNOWN",
    }
}
pub fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(bytes, offset)
}
pub fn mtime(meta: &Metadata) -> (i64, i64) {
    match meta.modified().ok().map(|t| t.duration_since(UNIX_EPOCH)) {
        Some(Ok(time)) => (time.as_secs() as i64, time.subsec_nanos() as i64),
        Some(Err(error)) => {
            let time = error.duration();
            if time.subsec_nanos() == 0 {
                (-(time.as_secs() as i64), 0)
            } else {
                (
                    -(time.as_secs() as i64) - 1,
                    1_000_000_000 - time.subsec_nanos() as i64,
                )
            }
        }
        None => (0, 0),
    }
}
pub fn identity(meta: &Metadata) -> (u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (0, meta.creation_time())
}
pub fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}
pub fn tmpdir() -> String {
    let value = |key| std::env::var(key).ok().filter(|v| !v.is_empty());
    let mut path = value("TEMP").or_else(|| value("TMP")).unwrap_or_else(|| {
        format!(
            "{}\\temp",
            value("SystemRoot")
                .or_else(|| value("windir"))
                .unwrap_or_default()
        )
    });
    if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
        path.pop();
    }
    path
}
fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL byte",
        ));
    }
    Ok(OsStr::new(text).encode_wide().chain(Some(0)).collect())
}
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let state = RandomState::new();
    for _ in 0..1000 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(NEXT.fetch_add(1, Ordering::Relaxed));
        let mut random = hasher.finish();
        let mut path = prefix.to_string();
        for _ in 0..6 {
            path.push(LETTERS[(random % LETTERS.len() as u64) as usize] as char);
            random /= LETTERS.len() as u64;
        }
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from_raw_os_error(80))
}
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    if no_follow && std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path));
    }
    if std::fs::metadata(path).is_ok_and(|m| m.is_dir()) {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    File::open(path).map_err(|error| Failure::io(&error, "open", path))
}
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let (access, creation) = match mode {
        OpenMode::Read => (FILE_GENERIC_READ, OPEN_EXISTING),
        OpenMode::Write => (FILE_GENERIC_WRITE, CREATE_ALWAYS),
        OpenMode::Append => (
            (FILE_GENERIC_WRITE & !FILE_WRITE_DATA) | FILE_APPEND_DATA,
            OPEN_ALWAYS,
        ),
        OpenMode::ReadWrite => (FILE_GENERIC_READ | FILE_GENERIC_WRITE, OPEN_EXISTING),
    };
    let name = wide(path)?;
    // All strings are terminated; ownership of a successful handle moves into File.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            creation,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return Err(
            if error.raw_os_error() == Some(80)
                && matches!(mode, OpenMode::Write | OpenMode::Append)
            {
                synthetic("EISDIR")
            } else {
                error
            },
        );
    }
    Ok(unsafe { File::from_raw_handle(handle as _) })
}
pub fn realpath(path: &str) -> io::Result<String> {
    let path = std::fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(if let Some(path) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{path}")
    } else {
        path.strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(path)
    })
}
pub fn rename(from: &str, to: &str) -> io::Result<()> {
    let from = wide(from)?;
    let to = wide(to)?;
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub fn remove_file(path: &str) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink_dir()) {
        return std::fs::remove_dir(path);
    }
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = std::fs::metadata(path)?.permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
            std::fs::remove_file(path)
        }
        result => result,
    }
}
pub trait Pipe: io::Read {}
impl<T: io::Read> Pipe for T {}
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut consume: impl FnMut(&[u8]) -> bool) {
    let mut bytes = vec![0; 65536];
    while !stop.load(Ordering::SeqCst) {
        match pipe.read(&mut bytes) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if !consume(&bytes[..n]) {
                    return;
                }
            }
        }
    }
}
pub fn interrupt_reader(reader: &std::thread::JoinHandle<()>) {
    unsafe {
        CancelSynchronousIo(reader.as_raw_handle() as _);
    }
}
pub fn resolve_program(
    program: &str,
    cwd: &str,
    env: &Map<String, Value>,
) -> Result<String, Failure> {
    let has_extension = Path::new(program).extension().is_some();
    let candidates = |base: &Path| {
        let mut choices = Vec::new();
        if has_extension {
            choices.push(base.to_path_buf());
        }
        for extension in ["com", "exe"] {
            let mut name = base.as_os_str().to_owned();
            name.push(".");
            name.push(extension);
            choices.push(PathBuf::from(name));
        }
        choices
    };
    let found = if program.contains(['\\', '/', ':']) {
        candidates(&Path::new(cwd).join(program))
            .into_iter()
            .find(|path| path.is_file())
    } else {
        let value = env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .and_then(|(_, v)| v.as_str().map(str::to_owned))
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        std::iter::once(PathBuf::from(cwd))
            .chain(std::env::split_paths(&value))
            .flat_map(|p| candidates(&p.join(program)))
            .find(|path| path.is_file())
    };
    let path =
        found.ok_or_else(|| Failure::new("spawn_error", format!("spawn {program} ENOENT")))?;
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        return Err(Failure::new(
            "spawn_error",
            format!("spawn {program} EINVAL"),
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}
fn bash(program: &str) -> ShellConfig {
    let path = program.replace('/', "\\").to_lowercase();
    let legacy = path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && matches!(
            path.get(1..),
            Some(":\\windows\\system32\\bash.exe" | ":\\windows\\sysnative\\bash.exe")
        );
    ShellConfig {
        program: program.into(),
        args: vec![if legacy { "-s" } else { "-c" }.into()],
        command_on_stdin: legacy,
    }
}
pub fn shell_config(configured: Option<&str>) -> Result<ShellConfig, Failure> {
    if let Some(path) = configured {
        if path_exists(path) {
            return Ok(bash(path));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {path}"),
        ));
    }
    let candidates: Vec<String> = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|p| format!("{p}\\Git\\bin\\bash.exe"))
        })
        .collect();
    if let Some(path) = candidates.iter().find(|path| path_exists(path)) {
        return Ok(bash(path));
    }
    if let Ok(output) = Command::new("where")
        .arg("bash.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .trim()
                .lines()
                .next()
                .filter(|path| path_exists(path.trim()))
            {
                return Ok(bash(path.trim()));
            }
        }
    }
    let searched: String = candidates
        .iter()
        .map(|path| format!("  {path}\n"))
        .collect();
    Err(Failure::new(
        "shell_unavailable",
        format!(
            "No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Configure an explicit shellPath\n\nSearched Git Bash in:\n{}",
            searched.trim_end()
        ),
    ))
}
pub fn quote_argument(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".into();
    }
    if !text.contains([' ', '\t', '"']) {
        return text.into();
    }
    if !text.contains(['"', '\\']) {
        return format!("\"{text}\"");
    }
    let mut reversed = Vec::new();
    let mut quote = true;
    for ch in text.chars().rev() {
        reversed.push(ch);
        if quote && ch == '\\' {
            reversed.push('\\');
        } else if ch == '"' {
            quote = true;
            reversed.push('\\');
        } else {
            quote = false;
        }
    }
    let mut result = String::from("\"");
    result.extend(reversed.into_iter().rev());
    result.push('"');
    result
}
fn child_environment(env: &Map<String, Value>, inherit: bool) -> Vec<(String, String)> {
    let mut values: Vec<(String, String)> = Vec::new();
    let mut set = |key: String, value: String| {
        if let Some(entry) = values.iter_mut().find(|(name, _)| *name == key) {
            entry.1 = value;
        } else {
            values.push((key, value));
        }
    };
    if inherit {
        for (key, value) in std::env::vars_os() {
            set(
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            );
        }
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            set(key.clone(), value.into());
        }
    }
    values.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let mut seen = std::collections::HashSet::new();
    values.retain(|(key, _)| seen.insert(key.to_uppercase()));
    for key in [
        "HOMEDRIVE",
        "HOMEPATH",
        "LOGONSERVER",
        "PATH",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
    ] {
        if !values
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(key))
        {
            if let Ok(value) = std::env::var(key) {
                values.push((key.into(), value));
            }
        }
    }
    values
}
pub fn configure(command: &mut Command, args: &[String], env: &Map<String, Value>, inherit: bool) {
    for arg in args {
        command.raw_arg(quote_argument(arg));
    }
    command.env_clear();
    for (key, value) in child_environment(env, inherit) {
        command.env(key, value);
    }
    command.creation_flags(CREATE_NO_WINDOW);
}
fn job() -> Option<isize> {
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    *JOB.get_or_init(|| unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
            | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
        );
        Some(handle as isize)
    })
}
pub fn after_spawn(child: &Child) {
    if let Some(job) = job() {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}
pub fn kill_tree(pid: u32) {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let _ = Command::new(format!("{root}\\System32\\taskkill.exe"))
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(status.code().unwrap_or(1) as u32)
}
pub fn raw_name(_name: &OsStr) -> Option<Vec<u8>> {
    None
}
pub fn drive_cwds() -> Map<String, Value> {
    std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_str()?;
            let b = key.as_bytes();
            if b.len() == 3 && b[0] == b'=' && b[1].is_ascii_alphabetic() && b[2] == b':' {
                Some((
                    key[1..].to_ascii_uppercase(),
                    Value::String(value.to_string_lossy().into_owned()),
                ))
            } else {
                None
            }
        })
        .collect()
}
pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path).map_err(|error| {
        if error.raw_os_error() == Some(267) {
            synthetic("ENOTDIR")
        } else {
            error
        }
    })
}
pub fn path_identity(path: &str, meta: &Metadata, follow: bool) -> (u64, u64) {
    let Ok(name) = wide(path) else {
        return identity(meta);
    };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS
                | if follow {
                    0
                } else {
                    FILE_FLAG_OPEN_REPARSE_POINT
                },
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return identity(meta);
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let found = unsafe { GetFileInformationByHandle(handle, &mut info) } != 0;
    unsafe { CloseHandle(handle) };
    if found {
        (
            info.dwVolumeSerialNumber as u64,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        )
    } else {
        identity(meta)
    }
}
