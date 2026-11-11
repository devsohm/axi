use crate::{
    errors::Failure,
    exec::{self, Control, Groups, Message},
    frame::{EVENT, Frame},
    output::{Output, ReaderGate},
    sys,
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};

enum Input {
    Bytes(Vec<u8>),
    Close,
}
pub struct Process {
    input: Sender<Input>,
}
pub type Processes = Arc<Mutex<HashMap<u32, Process>>>;
pub struct ProcessRequest {
    argv: Vec<String>,
    cwd: String,
    env: Map<String, Value>,
    inherit: bool,
}
impl ProcessRequest {
    pub fn from_json(value: &Value) -> Result<Self, Failure> {
        let argv =
            exec::arguments(value)?.ok_or_else(|| Failure::new("EINVAL", "process needs argv"))?;
        let cwd = value["cwd"]
            .as_str()
            .ok_or_else(|| Failure::new("EINVAL", "process needs cwd"))?
            .into();
        Ok(Self {
            argv,
            cwd,
            env: value["env"].as_object().cloned().unwrap_or_default(),
            inherit: value["inheritEnv"].as_bool().unwrap_or(true),
        })
    }
}
fn input(processes: &Processes, value: &Value, input: Input) -> Result<Value, Failure> {
    let target = value["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))? as u32;
    let entries = processes.lock().unwrap();
    let program = entries
        .get(&target)
        .ok_or_else(|| Failure::new("EBADF", "no running process with this id"))?;
    program
        .input
        .send(input)
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}
pub fn write(processes: &Processes, value: &Value, bytes: Vec<u8>) -> Result<Value, Failure> {
    input(processes, value, Input::Bytes(bytes))
}
pub fn close_stdin(processes: &Processes, value: &Value) -> Result<Value, Failure> {
    input(processes, value, Input::Close)
}

pub fn run(
    id: u32,
    request: ProcessRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    processes: &Processes,
) -> Result<Value, Failure> {
    let (send, receive) = mpsc::channel();
    control.attach(send.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    let program = sys::resolve_program(&request.argv[0], &request.cwd, &request.env)?;
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let mut command = Command::new(program);
    command
        .current_dir(&request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::configure(
        &mut command,
        &request.argv[1..],
        &request.env,
        request.inherit,
    );
    let mut child = command
        .spawn()
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    sys::after_spawn(&child);
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let stop = Arc::new(AtomicBool::new(false));
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        exec::kill_group(pid);
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    let group = match sys::process_group(&child) {
        Ok(group) => group,
        Err(error) => return Err(abandon(child, error)),
    };
    let gate = ReaderGate::new(output);
    if let Err(error) = exec::read_pipe(
        0,
        child.stdout.take().unwrap(),
        send.clone(),
        stop.clone(),
        Some(gate.clone()),
    ) {
        return Err(abandon(child, error));
    }
    if let Err(error) = exec::read_pipe(
        1,
        child.stderr.take().unwrap(),
        send.clone(),
        stop.clone(),
        Some(gate.clone()),
    ) {
        return Err(abandon(child, error));
    }
    let (input, inputs) = mpsc::channel();
    let mut stdin = child.stdin.take().unwrap();
    let writer_stop = stop.clone();
    if let Err(error) = thread::Builder::new().spawn(move || {
        for item in inputs {
            match item {
                Input::Bytes(bytes) => {
                    if !sys::write_process_input(&mut stdin, &bytes, &writer_stop) {
                        break;
                    }
                }
                Input::Close => break,
            }
        }
    }) {
        return Err(abandon(child, error));
    }
    let (give, take) = mpsc::channel::<Child>();
    let waiter_send = send.clone();
    let waiter_groups = groups.clone();
    if let Err(error) = thread::Builder::new().spawn(move || {
        let Ok(mut child) = take.recv() else {
            return;
        };
        let waited = sys::wait_process(&mut child);
        // Remove this PID before reaping it so later cleanup cannot target a reused PID.
        let mut active = waiter_groups.lock().unwrap();
        group.terminate();
        active.remove(&pid);
        let status = child.wait();
        drop(active);
        let result = waited.and(status);
        let _ = waiter_send.send(match result {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    }) {
        return Err(abandon(child, error));
    }
    let _ = give.send(child);
    drop(send);
    processes.lock().unwrap().insert(id, Process { input });
    output.control(Frame::new(EVENT, id, json!({"kind":"started", "pid":pid})));
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut eof = [false; 2];
    let mut idle: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            let active = groups.lock().unwrap();
            if active.contains(&pid) {
                exec::kill_group(pid);
            }
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        if status.is_some() && eof.iter().all(|value| *value) {
            break;
        }
        let wait = if let Some(deadline) = idle {
            let now = Instant::now();
            if now < deadline {
                deadline - now
            } else if gate.pending() {
                idle = Some(now + Duration::from_millis(100));
                Duration::from_millis(100)
            } else {
                break;
            }
        } else {
            Duration::from_secs(3600)
        };
        match receive.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                output.bulk(Frame::with_payload(EVENT, id, json!({"kind":"output", "stream":if stream == 0 {"stdout"} else {"stderr"}}), bytes), None);
                if status.is_some() {
                    idle = Some(Instant::now() + Duration::from_millis(100));
                }
            }
            Ok(Message::Eof(stream)) => eof[stream] = true,
            Ok(Message::Exit(exit)) => {
                killed = true;
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
    processes.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
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
