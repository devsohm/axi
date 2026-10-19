use axi_env::{
    errors::Failure,
    exec::{self, Control},
    frame::{self, CANCEL, ERROR, Frame, PING, REQUEST, RESULT},
    fs, list,
    output::Output,
    pty, scan, sys, watch,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    env,
    fs::{File, ReadDir},
    io::{self, BufReader, BufWriter, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Sender},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type Job = Box<dyn FnOnce() + Send>;
#[derive(Default)]
struct Serial {
    queue: VecDeque<Job>,
    running: bool,
}
struct OpenFile {
    file: File,
    path: String,
    failed: AtomicBool,
    serial: Mutex<Serial>,
}
struct OpenDirectory {
    entries: ReadDir,
    path: String,
}
enum Handle {
    File(Arc<OpenFile>),
    Directory(Arc<Mutex<OpenDirectory>>),
}
struct Server {
    output: Arc<Output>,
    tmp: String,
    handles: Mutex<HashMap<u64, Handle>>,
    next: AtomicU64,
    controls: Mutex<HashMap<u32, Arc<Control>>>,
    groups: exec::Groups,
    terminals: pty::Terminals,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    value[key]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing field {key}")))
}
fn number(value: &Value, key: &str) -> Result<u64, Failure> {
    value[key]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", format!("missing or invalid field {key}")))
}
fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
impl Server {
    fn file(&self, value: &Value) -> Result<Arc<OpenFile>, Failure> {
        match self.handles.lock().unwrap().get(&number(value, "handle")?) {
            Some(Handle::File(file)) => Ok(file.clone()),
            Some(Handle::Directory(_)) => Err(Failure::new("EBADF", "not a file handle")),
            None => Err(Failure::new("EBADF", "unknown handle")),
        }
    }
    fn insert(&self, handle: Handle) -> Result<u64, Failure> {
        let mut handles = self.handles.lock().unwrap();
        if handles.len() >= 4096 {
            return Err(Failure::new("EMFILE", "EMFILE: too many open files"));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        handles.insert(id, handle);
        Ok(id)
    }
    fn open_file(&self, file: File, path: &str) -> Result<u64, Failure> {
        self.insert(Handle::File(Arc::new(OpenFile {
            file,
            path: path.into(),
            failed: AtomicBool::new(false),
            serial: Mutex::new(Serial::default()),
        })))
    }
    fn read_directory(&self, value: &Value) -> Result<Value, Failure> {
        let max = number(value, "max")?.max(1) as usize;
        let directory = match self.handles.lock().unwrap().get(&number(value, "handle")?) {
            Some(Handle::Directory(dir)) => dir.clone(),
            _ => return Err(Failure::new("EBADF", "not a directory handle")),
        };
        let mut directory = directory.lock().unwrap();
        let mut entries = Vec::new();
        let mut done = false;
        while entries.len() < max {
            match directory.entries.next() {
                None => {
                    done = true;
                    break;
                }
                Some(Err(error)) => return Err(Failure::io(&error, "readdir", &directory.path)),
                Some(Ok(entry)) => entries.push(fs::dir_entry(&directory.path, &entry.file_name())),
            }
        }
        Ok(json!({"entries":entries,"done":done}))
    }
    fn dispatch(
        &self,
        id: u32,
        value: &Value,
        payload: Vec<u8>,
        control: &Control,
    ) -> Result<(Value, Vec<u8>), Failure> {
        if value.is_null() {
            return Err(Failure::new("EINVAL", "invalid JSON"));
        }
        let op = value["op"].as_str().unwrap_or("");
        let empty = |result: Result<Value, Failure>| result.map(|value| (value, Vec::new()));
        match op {
            "hello" => empty(Ok(
                json!({"protocol":1,"version":env!("AXI_ENV_VERSION"),"os":env::consts::OS,"arch":env::consts::ARCH,"home":sys::home(),"separator":sys::PATH_SEPARATOR,"tmpdir":self.tmp,"cwd":sys::cwd(),"driveCwds":sys::drive_cwds(),"pid":std::process::id(),"features":["listFiles"]}),
            )),
            "lstat" => empty(fs::lstat(text(value, "path")?)),
            "realpath" => empty(fs::realpath(text(value, "path")?)),
            "mkdir" => empty(fs::mkdir(text(value, "path")?, flag(value, "recursive"))),
            "rm" => empty(fs::rm(
                text(value, "path")?,
                flag(value, "recursive"),
                flag(value, "force"),
            )),
            "mkdtemp" => empty(fs::mkdtemp(text(value, "path")?)),
            "truncate" => empty(fs::truncate(text(value, "path")?, number(value, "size")?)),
            "fsync" => empty(fs::fsync(text(value, "path")?)),
            "rename" => empty(fs::rename(text(value, "path")?, text(value, "to")?)),
            "write" => {
                let path = text(value, "path")?;
                let file = fs::write(
                    path,
                    flag(value, "append"),
                    value["parents"].as_bool().unwrap_or(true),
                    &payload,
                )?;
                empty(Ok(if flag(value, "keep") {
                    json!({"handle":self.open_file(file,path)?})
                } else {
                    json!({})
                }))
            }
            "writeChunk" => {
                let handle = self.file(value)?;
                if handle.failed.load(Ordering::SeqCst) {
                    return Err(Failure::new("EBADF", "an earlier write failed"));
                }
                (&handle.file).write_all(&payload).map_err(|error| {
                    handle.failed.store(true, Ordering::SeqCst);
                    Failure::io(&error, "write", &handle.path)
                })?;
                empty(Ok(json!({})))
            }
            "open" => {
                let path = text(value, "path")?;
                if value["mode"].as_str() == Some("read") {
                    let file = sys::open(path, sys::OpenMode::Read)
                        .map_err(|error| Failure::io(&error, "open", path))?;
                    let mut stat = match file.metadata() {
                        Ok(meta) => json!({"stat":fs::info(path,&meta)}),
                        Err(error) => {
                            json!({"statError":Failure::io(&error,"fstat",path).to_json()})
                        }
                    };
                    stat["handle"] = json!(self.open_file(file, path)?);
                    empty(Ok(stat))
                } else {
                    let (file, info) = fs::open_reader(path, flag(value, "noFollow"))?;
                    empty(Ok(json!({"handle":self.open_file(file,path)?,"info":info})))
                }
            }
            "pread" => {
                let handle = self.file(value)?;
                let length = (number(value, "length")? as usize).min(frame::MAX_PAYLOAD);
                let payload = if let Some(offset) = value["offset"].as_u64() {
                    fs::pread(&handle.file, &handle.path, offset, length)?
                } else {
                    fs::read(&handle.file, &handle.path, length)?
                };
                Ok((json!({}), payload))
            }
            "fstat" => {
                let handle = self.file(value)?;
                let meta = handle
                    .file
                    .metadata()
                    .map_err(|error| Failure::io(&error, "fstat", &handle.path))?;
                empty(Ok(fs::info(&handle.path, &meta)))
            }
            "scanLines" => {
                let handle = self.file(value)?;
                let from = number(value, "startLine")?;
                let to = value["endLine"].as_u64();
                if to.is_some_and(|to| to <= from) {
                    return Err(Failure::new("EINVAL", "Invalid line range"));
                }
                let mut scanner = scan::LineScanner::new(from, to);
                let mut bytes = vec![0; 65536];
                let mut offset = 0;
                loop {
                    if control.aborted.load(Ordering::SeqCst) {
                        return Err(Failure::new("aborted", "aborted"));
                    }
                    let n = sys::read_at(&handle.file, &mut bytes, offset)
                        .map_err(|error| Failure::io(&error, "read", &handle.path))?;
                    if n == 0 {
                        break;
                    }
                    scanner.push(&bytes[..n]);
                    offset += n as u64;
                }
                empty(Ok(scanner.finish()))
            }
            "opendir" => {
                let path = text(value, "path")?;
                let entries =
                    sys::read_dir(path).map_err(|error| Failure::io(&error, "opendir", path))?;
                empty(Ok(
                    json!({"handle":self.insert(Handle::Directory(Arc::new(Mutex::new(OpenDirectory{entries,path:path.into()}))))?}),
                ))
            }
            "readdir" => empty(self.read_directory(value)),
            "close" => {
                self.handles
                    .lock()
                    .unwrap()
                    .remove(&number(value, "handle")?);
                empty(Ok(json!({})))
            }
            "listFiles" => list::run(value, &|| control.aborted.load(Ordering::SeqCst)),
            "exec" => empty(exec::run(
                id,
                exec::ExecRequest::from_json(value)?,
                &self.tmp,
                &self.output,
                control,
                &self.groups,
            )),
            "watch" => empty(watch::run(id, value, &self.output, control)),
            "pty" => empty(pty::run(
                id,
                pty::PtyRequest::from_json(value)?,
                &self.output,
                control,
                &self.groups,
                &self.terminals,
            )),
            _ => Err(Failure::new("EINVAL", format!("unknown operation {op}"))),
        }
    }
    fn respond(&self, request: Frame, control: Arc<Control>) {
        let id = request.id;
        let command = matches!(request.json["op"].as_str(), Some("exec" | "pty"));
        let reply = match self.dispatch(id, &request.json, request.payload, &control) {
            Ok((json, payload)) => Frame::with_payload(RESULT, id, json, payload),
            Err(failure) => Frame::new(ERROR, id, failure.to_json()),
        };
        self.controls.lock().unwrap().remove(&id);
        if command || reply.payload.len() > 65536 {
            self.output.bulk(reply, None);
        } else {
            self.output.control(reply);
        }
    }
}
fn workers() -> Sender<Job> {
    let (sender, receiver) = mpsc::channel::<Job>();
    let receiver = Arc::new(Mutex::new(receiver));
    for _ in 0..16 {
        let receiver = receiver.clone();
        thread::spawn(move || {
            loop {
                let job = receiver.lock().unwrap().recv();
                match job {
                    Ok(job) => job(),
                    Err(_) => return,
                }
            }
        });
    }
    sender
}
fn ordered(pool: &Sender<Job>, file: Arc<OpenFile>, job: Job) {
    let mut serial = file.serial.lock().unwrap();
    serial.queue.push_back(job);
    if serial.running {
        return;
    }
    serial.running = true;
    drop(serial);
    let _ = pool.send(Box::new(move || {
        loop {
            let next = {
                let mut serial = file.serial.lock().unwrap();
                let next = serial.queue.pop_front();
                if next.is_none() {
                    serial.running = false;
                }
                next
            };
            match next {
                Some(job) => job(),
                None => return,
            }
        }
    }));
}
fn receive(server: &Arc<Server>, input: &mut impl Read) -> io::Result<()> {
    let pool = workers();
    while let Some(request) = frame::read_frame(input)? {
        match request.kind {
            REQUEST => {
                let op = request.json["op"].as_str().unwrap_or("");
                if matches!(op, "ptyWrite" | "ptyResize" | "ptyForeground") {
                    let result = match op {
                        "ptyWrite" => pty::write(&server.terminals, &request.json, request.payload),
                        "ptyResize" => pty::resize(&server.terminals, &request.json),
                        _ => pty::foreground(&server.terminals, &request.json),
                    };
                    server.output.control(match result {
                        Ok(value) => Frame::new(RESULT, request.id, value),
                        Err(error) => Frame::new(ERROR, request.id, error.to_json()),
                    });
                    continue;
                }
                let id = request.id;
                let control = Arc::new(Control::default());
                server.controls.lock().unwrap().insert(id, control.clone());
                let worker = server.clone();
                if matches!(op, "exec" | "watch" | "pty") {
                    if let Err(error) = thread::Builder::new()
                        .stack_size(16 * 1024 * 1024)
                        .spawn(move || worker.respond(request, control))
                    {
                        server.controls.lock().unwrap().remove(&id);
                        server.output.bulk(
                            Frame::new(
                                ERROR,
                                id,
                                Failure::new("spawn_error", error.to_string()).to_json(),
                            ),
                            None,
                        );
                    }
                } else {
                    let serial = if op == "writeChunk" {
                        server.file(&request.json).ok()
                    } else {
                        None
                    };
                    let job: Job = Box::new(move || worker.respond(request, control));
                    if let Some(file) = serial {
                        ordered(&pool, file, job);
                    } else {
                        let _ = pool.send(job);
                    }
                }
            }
            CANCEL => {
                let control = server.controls.lock().unwrap().get(&request.id).cloned();
                if let Some(control) = control {
                    control.cancel(request.json["mode"].as_str() == Some("kill"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Activity<R> {
    reader: R,
    last: Arc<AtomicU64>,
}
impl<R: Read> Read for Activity<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.reader.read(bytes)?;
        if count > 0 {
            self.last.store(now(), Ordering::Relaxed);
        }
        Ok(count)
    }
}
fn kill_all(groups: &exec::Groups) {
    for pid in groups.lock().unwrap().iter() {
        exec::kill_group(*pid);
    }
}
fn serve(token: &str) -> io::Result<()> {
    {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "AXI-ENV {token}")?;
        stdout.flush()?;
    }
    let output = Arc::new(Output::default());
    let writer = {
        let output = output.clone();
        thread::spawn(move || {
            output.run(&mut BufWriter::with_capacity(1048576, io::stdout().lock()))
        })
    };
    let server = Arc::new(Server {
        output: output.clone(),
        tmp: sys::tmpdir(),
        handles: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        controls: Mutex::new(HashMap::new()),
        groups: Arc::new(Mutex::new(Default::default())),
        terminals: Arc::new(Mutex::new(HashMap::new())),
    });
    let last = Arc::new(AtomicU64::new(now()));
    {
        let last = last.clone();
        let output = output.clone();
        let groups = server.groups.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(5));
                output.control(Frame::new(PING, 0, json!({})));
                if now().saturating_sub(last.load(Ordering::Relaxed)) > 30000 {
                    kill_all(&groups);
                    std::process::exit(0);
                }
            }
        });
    }
    let result = receive(
        &server,
        &mut BufReader::with_capacity(
            1048576,
            Activity {
                reader: io::stdin().lock(),
                last,
            },
        ),
    );
    kill_all(&server.groups);
    output.close();
    let _ = writer.join();
    result
}
fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") => println!("axi-env {}", env!("AXI_ENV_VERSION")),
        Some("serve") => {
            let token = args
                .iter()
                .position(|arg| arg == "--token")
                .and_then(|at| args.get(at + 1));
            let Some(token) = token else {
                eprintln!("usage: axi-env serve --token <hex>");
                std::process::exit(2);
            };
            if let Err(error) = serve(token) {
                eprintln!("axi-env: {error}");
                std::process::exit(1);
            }
            std::process::exit(0);
        }
        _ => {
            eprintln!("usage: axi-env serve --token <hex>");
            std::process::exit(2);
        }
    }
}
