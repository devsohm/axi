use crate::{
    errors::Failure,
    exec::{Control, Groups},
    output::Output,
};
#[cfg(unix)]
use crate::{
    exec::{Message, kill_group},
    frame::{EVENT, Frame},
    sys,
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, mpsc::Sender},
};
#[cfg(unix)]
use std::{fs::File, sync::atomic::Ordering};

pub struct Terminal {
    input: Sender<Vec<u8>>,
    #[cfg(unix)]
    master: Arc<File>,
    #[cfg(unix)]
    pid: u32,
}
pub type Terminals = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;
pub struct PtyRequest {
    argv: Option<Vec<String>>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
    cols: u16,
    rows: u16,
}
fn cells(value: &Value, key: &str) -> Result<u16, Failure> {
    value[key]
        .as_u64()
        .filter(|v| (1..=4096).contains(v))
        .map(|v| v as u16)
        .ok_or_else(|| Failure::new("EINVAL", format!("{key} must be between 1 and 4096")))
}
impl PtyRequest {
    pub fn from_json(value: &Value) -> Result<Self, Failure> {
        let argv = if value["argv"].is_null() {
            None
        } else {
            Some(
                value["argv"]
                    .as_array()
                    .and_then(|items| {
                        items
                            .iter()
                            .map(|v| v.as_str().map(str::to_owned))
                            .collect::<Option<Vec<_>>>()
                    })
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| {
                        Failure::new("EINVAL", "argv must be a non-empty array of strings")
                    })?,
            )
        };
        Ok(Self {
            argv,
            cwd: value["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "pty needs cwd"))?
                .into(),
            env: value["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: value["inheritEnv"].as_bool().unwrap_or(true),
            cols: cells(value, "cols")?,
            rows: cells(value, "rows")?,
        })
    }
}
fn find(terminals: &Terminals, value: &Value) -> Result<Arc<Terminal>, Failure> {
    let id = value["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))?;
    terminals
        .lock()
        .unwrap()
        .get(&(id as u32))
        .cloned()
        .ok_or_else(|| Failure::new("EBADF", "no running terminal with this id"))
}
pub fn write(terminals: &Terminals, value: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    find(terminals, value)?
        .input
        .send(payload)
        .map_err(|_| Failure::new("EBADF", "the terminal has ended"))?;
    Ok(json!({}))
}
pub fn resize(terminals: &Terminals, value: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, value)?;
    let (cols, rows) = (cells(value, "cols")?, cells(value, "rows")?);
    #[cfg(unix)]
    unix::resize(&terminal.master, cols, rows)
        .map_err(|error| Failure::io(&error, "ioctl", "pty"))?;
    #[cfg(not(unix))]
    let _ = (terminal, cols, rows);
    Ok(json!({}))
}
pub fn foreground(terminals: &Terminals, value: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, value)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let pid = unsafe { libc::tcgetpgrp(terminal.master.as_raw_fd()) };
        if pid < 0 {
            return Err(Failure::io(
                &std::io::Error::last_os_error(),
                "tcgetpgrp",
                "pty",
            ));
        }
        if pid == 0 || pid as u32 == terminal.pid {
            return Ok(json!({"foreground":null}));
        }
        Ok(json!({"foreground":{"pid":pid,"name":unix::name(pid)}}))
    }
    #[cfg(not(unix))]
    {
        let _ = terminal;
        Ok(json!({"foreground":null}))
    }
}
#[cfg(not(unix))]
pub fn run(
    _id: u32,
    _request: PtyRequest,
    _output: &Arc<Output>,
    _control: &Control,
    _groups: &Groups,
    _terminals: &Terminals,
) -> Result<Value, Failure> {
    Err(Failure::new(
        "ENOTSUP",
        "Terminals are not supported on this system yet",
    ))
}
#[cfg(unix)]
pub fn run(
    id: u32,
    request: PtyRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    terminals: &Terminals,
) -> Result<Value, Failure> {
    use std::{
        sync::{
            atomic::AtomicBool,
            mpsc::{self, RecvTimeoutError},
        },
        thread,
        time::{Duration, Instant},
    };
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    if !std::path::Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let (master, mut child) =
        unix::spawn(&request).map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let master = Arc::new(master);
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let (input, inputs) = mpsc::channel();
    terminals.lock().unwrap().insert(
        id,
        Arc::new(Terminal {
            input,
            master: master.clone(),
            pid,
        }),
    );
    output.control(Frame::new(EVENT, id, json!({"kind":"started","pid":pid})));
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let master = master.clone();
        let sender = sender.clone();
        let stop = stop.clone();
        let output = output.clone();
        thread::spawn(move || {
            unix::read(&master, &stop, |bytes| {
                let live = sender.send(Message::Data(0, bytes.to_vec())).is_ok();
                output.wait_for_room(&stop);
                live
            });
            let _ = sender.send(Message::Eof(0));
        })
    };
    {
        let master = master.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            for bytes in inputs {
                if !unix::write(&master, &stop, &bytes) {
                    return;
                }
            }
        });
    }
    let waiter = sender.clone();
    thread::spawn(move || {
        let _ = waiter.send(match child.wait() {
            Ok(exit) => Message::Exit(exit),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    drop(sender);
    let mut status = None;
    let mut ended = false;
    let mut idle: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        if status.is_some() && ended {
            break;
        }
        let wait = if let Some(at) = idle {
            let now = Instant::now();
            if now >= at {
                break;
            }
            at - now
        } else {
            Duration::from_secs(3600)
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(_, bytes)) => {
                output.bulk(
                    Frame::with_payload(EVENT, id, json!({"kind":"output"}), bytes),
                    None,
                );
                if status.is_some() {
                    idle = Some(Instant::now() + Duration::from_millis(100));
                }
            }
            Ok(Message::Eof(_)) => ended = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle = Some(Instant::now() + Duration::from_millis(100));
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    stop.store(true, Ordering::SeqCst);
    terminals.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    let _ = reader.join();
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(exit)) => Ok(json!({"exitCode":sys::exit_code(exit)})),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}
#[cfg(unix)]
mod unix {
    use super::PtyRequest;
    use std::{
        fs::File,
        io::{self, Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::process::CommandExt,
        },
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicBool, Ordering},
    };
    fn check(n: libc::c_int) -> io::Result<libc::c_int> {
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n)
        }
    }
    fn dimensions(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }
    pub fn resize(master: &File, cols: u16, rows: u16) -> io::Result<()> {
        let size = dimensions(cols, rows);
        check(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) })?;
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn name(pid: libc::pid_t) -> Option<String> {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|v| v.trim_end().to_owned())
            .filter(|v| !v.is_empty())
    }
    #[cfg(target_vendor = "apple")]
    pub fn name(pid: libc::pid_t) -> Option<String> {
        let mut bytes = [0; 256];
        let n = unsafe { libc::proc_name(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
        (n > 0).then(|| String::from_utf8_lossy(&bytes[..n as usize]).into_owned())
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    pub fn name(_pid: libc::pid_t) -> Option<String> {
        None
    }
    pub fn spawn(request: &PtyRequest) -> io::Result<(File, Child)> {
        let (mut master, mut slave) = (-1, -1);
        let mut size = dimensions(request.cols, request.rows);
        // openpty fills two owned descriptors; termios and the device name are omitted.
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        })?;
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
            unsafe {
                let flags = check(libc::fcntl(fd, libc::F_GETFD))?;
                check(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
            }
        }
        let slave = File::from(slave);
        let mut command = if let Some(argv) = &request.argv {
            let mut command = Command::new(&argv[0]);
            command.args(&argv[1..]);
            command
        } else {
            let shell = request
                .env
                .get("SHELL")
                .and_then(|v| v.as_str().map(str::to_owned))
                .or_else(|| std::env::var("SHELL").ok())
                .filter(|v| !v.is_empty() && crate::sys::path_exists(v))
                .unwrap_or_else(|| "/bin/sh".into());
            let mut command = Command::new(&shell);
            command.arg0(format!("-{}", shell.rsplit('/').next().unwrap_or("sh")));
            command
        };
        command
            .current_dir(&request.cwd)
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        if !request.inherit_env {
            command.env_clear();
        }
        for (key, value) in &request.env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
        // The child gets a new session and controlling terminal before exec.
        unsafe {
            command.pre_exec(|| {
                check(libc::setsid())?;
                check(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
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
        let child = command.spawn()?;
        drop(slave);
        let master = File::from(master);
        unsafe {
            let flags = check(libc::fcntl(master.as_raw_fd(), libc::F_GETFL))?;
            check(libc::fcntl(
                master.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            ))?;
        }
        Ok((master, child))
    }
    fn poll(fd: libc::c_int, events: libc::c_short) -> io::Result<bool> {
        let mut p = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut p, 1, 100) };
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            }
        } else {
            Ok(n > 0)
        }
    }
    pub fn read(master: &File, stop: &AtomicBool, mut consume: impl FnMut(&[u8]) -> bool) {
        let mut bytes = vec![0; 65536];
        while !stop.load(Ordering::SeqCst) {
            match poll(master.as_raw_fd(), libc::POLLIN) {
                Ok(false) => continue,
                Err(_) => return,
                _ => {}
            }
            match (&*master).read(&mut bytes) {
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
    pub fn write(master: &File, stop: &AtomicBool, mut bytes: &[u8]) -> bool {
        while !bytes.is_empty() {
            if stop.load(Ordering::SeqCst) {
                return false;
            }
            match (&*master).write(bytes) {
                Ok(0) => return false,
                Ok(n) => bytes = &bytes[n..],
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if poll(master.as_raw_fd(), libc::POLLOUT).is_err() {
                        return false;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        true
    }
}
