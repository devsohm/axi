use crate::{
    decode::StreamDecoder,
    errors::Failure,
    frame::{EVENT, Frame},
    output::Output,
    sys,
    window::{Pending, Window},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};

pub type Groups = Arc<Mutex<HashSet<u32>>>;
pub enum Message {
    Data(usize, Vec<u8>),
    Eof(usize),
    Exit(ExitStatus),
    WaitFailed(String),
    Cancel,
    Kill,
}
#[derive(Default)]
pub struct Control {
    pub aborted: AtomicBool,
    pub killed: AtomicBool,
    sender: Mutex<Option<Sender<Message>>>,
}
impl Control {
    pub fn cancel(&self, kill: bool) {
        let sender = self.sender.lock().unwrap();
        if kill {
            self.killed.store(true, Ordering::SeqCst);
        } else {
            self.aborted.store(true, Ordering::SeqCst);
        }
        if let Some(sender) = &*sender {
            let _ = sender.send(if kill { Message::Kill } else { Message::Cancel });
        }
    }
    pub fn attach(&self, sender: Sender<Message>) {
        *self.sender.lock().unwrap() = Some(sender);
    }
}
pub fn kill_group(pid: u32) {
    sys::kill_tree(pid);
}
pub struct ExecRequest {
    pub command: Option<String>,
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    pub env: Map<String, Value>,
    pub inherit_env: bool,
    pub shell_path: Option<String>,
    pub timeout: Option<Duration>,
    pub spill: Option<(u64, u64)>,
    pub window: Option<Window>,
}
impl ExecRequest {
    pub fn from_json(value: &Value) -> Result<Self, Failure> {
        Ok(Self {
            command: value["command"].as_str().map(str::to_owned),
            argv: value["argv"].as_array().and_then(|items| {
                items
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect()
            }),
            cwd: value["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "exec needs cwd"))?
                .into(),
            env: value["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: value["inheritEnv"].as_bool().unwrap_or(true),
            shell_path: value["shellPath"].as_str().map(str::to_owned),
            timeout: value["timeoutMs"]
                .as_f64()
                .map(|ms| Duration::from_secs_f64(ms / 1000.0)),
            spill: value["spill"].as_object().and_then(|o| {
                Some((
                    o.get("afterBytes")?.as_u64()?,
                    o.get("afterLines")?.as_u64()?,
                ))
            }),
            window: Window::from_json(&value["window"]),
        })
    }
}
struct Spill {
    limits: (u64, u64),
    bytes: u64,
    newlines: u64,
    held: Vec<Vec<u8>>,
    file: Option<File>,
    path: Option<String>,
    failure: Option<String>,
}
impl Spill {
    fn new(limits: (u64, u64)) -> Self {
        Self {
            limits,
            bytes: 0,
            newlines: 0,
            held: Vec::new(),
            file: None,
            path: None,
            failure: None,
        }
    }
    fn push(&mut self, bytes: &[u8], tmp: &str) {
        if self.failure.is_some() || bytes.is_empty() {
            return;
        }
        if let Err(error) = self.write(bytes, tmp) {
            self.failure = Some(error);
        }
    }
    fn write(&mut self, bytes: &[u8], tmp: &str) -> Result<(), String> {
        if self.file.is_none() {
            self.bytes += bytes.len() as u64;
            self.newlines += bytes.iter().filter(|&&b| b == 10).count() as u64;
            let lines = self.newlines + u64::from(bytes.last() != Some(&10));
            if self.bytes <= self.limits.0 && lines <= self.limits.1 {
                self.held.push(bytes.to_vec());
                return Ok(());
            }
            let dir = sys::mkdtemp(&Path::new(tmp).join("tmp-").to_string_lossy())
                .map_err(|e| e.to_string())?;
            let mut uuid = sys::random_bytes();
            uuid[6] = (uuid[6] & 15) | 64;
            uuid[8] = (uuid[8] & 63) | 128;
            let hex: String = uuid.iter().map(|b| format!("{b:02x}")).collect();
            let uuid = format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            );
            let path = Path::new(&dir)
                .join(format!("axi-output-{uuid}.log"))
                .to_string_lossy()
                .into_owned();
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            for part in self.held.drain(..) {
                file.write_all(&part).map_err(|e| e.to_string())?;
            }
            self.file = Some(file);
            self.path = Some(path);
        }
        self.file
            .as_mut()
            .unwrap()
            .write_all(bytes)
            .map_err(|e| e.to_string())
    }
}
fn frame(id: u32, stream: &str, text: String, skipped: Option<Value>) -> Frame {
    let mut fields = json!({"kind":"output","stream":stream});
    if let Some(skipped) = skipped {
        fields["skipped"] = skipped;
    }
    Frame::with_payload(EVENT, id, fields, text.into_bytes())
}
fn emit(id: u32, output: &Output, pending: &mut Option<Pending>, stream: usize, text: String) {
    if text.is_empty() {
        return;
    }
    let name = if stream == 0 { "stdout" } else { "stderr" };
    if let Some(pending) = pending {
        pending.push(name, text);
    } else {
        output.bulk(frame(id, name, text, None), None);
    }
}
fn deliver(id: u32, output: &Output, pending: &mut Pending, unsent: &Arc<AtomicUsize>) {
    for event in pending.take() {
        output.bulk(
            frame(id, event.stream, event.text, event.skipped),
            Some(unsent.clone()),
        );
    }
}
pub fn run(
    id: u32,
    request: ExecRequest,
    tmp: &str,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
) -> Result<Value, Failure> {
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    let (program, args, stdin) = if let Some(text) = &request.command {
        let shell = sys::shell_config(request.shell_path.as_deref())?;
        let mut args = shell.args;
        let stdin = if shell.command_on_stdin {
            Some(text.clone())
        } else {
            args.push(text.clone());
            None
        };
        (shell.program, args, stdin)
    } else if let Some(argv) = &request.argv {
        let Some((program, args)) = argv.split_first() else {
            return Err(Failure::new("spawn_error", "Empty argv: no program to run"));
        };
        (
            sys::resolve_program(program, &request.cwd, &request.env)?,
            args.to_vec(),
            None,
        )
    } else {
        return Err(Failure::new("EINVAL", "exec needs command or argv"));
    };
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!(
                "Working directory does not exist: {}\nCannot execute bash commands.",
                request.cwd
            ),
        ));
    }
    let mut command = Command::new(&program);
    command
        .current_dir(&request.cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::configure(&mut command, &args, &request.env, request.inherit_env);
    let mut child = command
        .spawn()
        .map_err(|e| Failure::new("spawn_error", e.to_string()))?;
    sys::after_spawn(&child);
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let _ = pipe.write_all(text.as_bytes());
    }
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let deadline = request.timeout.map(|t| Instant::now() + t);
    let stop = Arc::new(AtomicBool::new(false));
    let reader = |index, pipe| {
        read_pipe(
            index,
            pipe,
            sender.clone(),
            stop.clone(),
            if request.window.is_none() {
                Some(output.clone())
            } else {
                None
            },
        )
    };
    let first = reader(0, child.stdout.take().unwrap());
    let second = read_pipe(
        1,
        child.stderr.take().unwrap(),
        sender.clone(),
        stop.clone(),
        if request.window.is_none() {
            Some(output.clone())
        } else {
            None
        },
    );
    let waiter = sender.clone();
    thread::spawn(move || {
        let _ = waiter.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(e) => Message::WaitFailed(e.to_string()),
        });
    });
    drop(sender);
    let mut decoders = [StreamDecoder::new(), StreamDecoder::new()];
    let mut spill = request.spill.map(Spill::new);
    let mut pending = request.window.map(Pending::new);
    let unsent = Arc::new(AtomicUsize::new(0));
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut ended = [false, false];
    let mut idle: Option<Instant> = None;
    let mut timed_out = false;
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
        let now = Instant::now();
        if !timed_out && deadline.is_some_and(|at| now >= at) {
            timed_out = true;
            kill(&mut killed);
        }
        if (status.is_some() && ended.iter().all(|e| *e)) || idle.is_some_and(|at| now >= at) {
            break;
        }
        if let Some(buffer) = &mut pending {
            if !buffer.is_empty() && now >= buffer.next_send() && unsent.load(Ordering::SeqCst) == 0
            {
                deliver(id, output, buffer, &unsent);
            }
        }
        let mut wait = Duration::from_secs(3600);
        if let Some(at) = deadline.filter(|_| !timed_out) {
            wait = wait.min(at.saturating_duration_since(now));
        }
        if let Some(at) = idle {
            wait = wait.min(at.saturating_duration_since(now));
        }
        if let Some(buffer) = pending.as_ref().filter(|b| !b.is_empty()) {
            wait = wait.min(if unsent.load(Ordering::SeqCst) > 0 {
                Duration::from_millis(20)
            } else {
                buffer.next_send().saturating_duration_since(now)
            });
        }
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                emit(
                    id,
                    output,
                    &mut pending,
                    stream,
                    decoders[stream].decode(&bytes, false),
                );
                if let Some(spill) = &mut spill {
                    spill.push(&bytes, tmp);
                    if spill.failure.is_some() {
                        kill(&mut killed);
                    }
                }
                if status.is_some() {
                    idle = Some(Instant::now() + Duration::from_millis(100));
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
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
    sys::interrupt_reader(&first);
    sys::interrupt_reader(&second);
    groups.lock().unwrap().remove(&pid);
    for (stream, decoder) in decoders.iter_mut().enumerate() {
        emit(id, output, &mut pending, stream, decoder.decode(&[], true));
    }
    if let Some(pending) = &mut pending {
        if !pending.is_empty() {
            deliver(id, output, pending, &unsent);
        }
    }
    let path = spill.as_ref().and_then(|s| s.path.clone());
    let failure = |code, message| {
        let error = Failure::new(code, message);
        if let Some(path) = &path {
            error.extra(json!({"spillPath":path}))
        } else {
            error
        }
    };
    if timed_out {
        return Err(failure("timeout", "timeout"));
    }
    if aborted {
        return Err(failure("aborted", "aborted"));
    }
    if let Some(message) = spill.as_ref().and_then(|s| s.failure.as_ref()) {
        return Err(Failure::new(
            "unknown",
            format!("Failed to preserve complete shell output: {message}"),
        ));
    }
    let status = status
        .ok_or_else(|| Failure::new("spawn_error", "process did not report its exit"))?
        .map_err(|message| Failure::new("spawn_error", message))?;
    let mut result = json!({"exitCode":sys::exit_code(status)});
    if let Some(path) = path {
        result["spillPath"] = json!(path);
    }
    Ok(result)
}
fn read_pipe(
    index: usize,
    pipe: impl sys::Pipe + Send + 'static,
    sender: Sender<Message>,
    stop: Arc<AtomicBool>,
    output: Option<Arc<Output>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        sys::read_pipe(pipe, &stop, |bytes| {
            let live = sender.send(Message::Data(index, bytes.to_vec())).is_ok();
            if let Some(output) = &output {
                output.wait_for_room(&stop);
            }
            live
        });
        let _ = sender.send(Message::Eof(index));
    })
}
