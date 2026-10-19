use crate::{
    errors::Failure,
    exec::Control,
    frame::{EVENT, Frame},
    output::Output,
    sys,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata},
    hash::{DefaultHasher, Hasher},
    io,
    path::Path,
    sync::{
        atomic::Ordering,
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant, SystemTime},
};

struct Target {
    path: String,
    recursive: bool,
    hidden: bool,
    names: HashSet<String>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Symlink,
    Other,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Native,
    Polling,
}
impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Polling => "polling",
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Entry {
    kind: Kind,
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    hash: Option<u64>,
}
type Snapshot = HashMap<String, Entry>;
struct Scan {
    snapshot: Snapshot,
    linked: HashSet<String>,
    directories: HashSet<String>,
    visited: HashSet<(usize, String)>,
    listed: HashMap<String, Kind>,
}
struct Installed {
    dev: u64,
    ino: u64,
    canonical: Option<String>,
}
enum ScanError {
    Budget(usize),
    Io(io::Error, &'static str, String),
}
impl ScanError {
    fn failure(&self) -> Failure {
        match self {
            Self::Budget(limit) => Failure::new(
                "EINVAL",
                format!("Watched paths exceed {limit} directories"),
            ),
            Self::Io(error, call, path) => Failure::io(error, call, path),
        }
    }
    fn code(&self) -> &'static str {
        match self {
            Self::Io(error, ..) if error.kind() == io::ErrorKind::PermissionDenied => {
                "permission_denied"
            }
            _ => "invalid",
        }
    }
}
fn kind(meta: &Metadata) -> Kind {
    if meta.is_file() {
        Kind::File
    } else if meta.is_dir() {
        Kind::Directory
    } else if meta.file_type().is_symlink() {
        Kind::Symlink
    } else {
        Kind::Other
    }
}
fn ancestors(path: &str) -> Vec<String> {
    Path::new(path)
        .ancestors()
        .skip(1)
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}
fn prefix(path: &str) -> String {
    if path.ends_with(sys::PATH_SEPARATOR) {
        path.into()
    } else {
        format!("{path}{}", sys::PATH_SEPARATOR)
    }
}
fn contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&prefix(parent))
}
fn excluded(target: &Target, name: &str) -> bool {
    (target.hidden && name.starts_with('.')) || target.names.contains(name)
}
fn record(scan: &mut Scan, path: &str, meta: &Metadata, follow: bool, polling: bool) {
    let directory = meta.is_dir();
    let recent = meta
        .modified()
        .map(|modified| {
            SystemTime::now()
                .duration_since(modified)
                .map_or(true, |age| age < Duration::from_secs(5))
        })
        .unwrap_or(false);
    let hash = if polling && meta.is_file() && meta.len() <= 262144 && recent {
        fs::read(path).ok().map(|bytes| {
            let mut hash = DefaultHasher::new();
            hash.write(&bytes);
            hash.finish()
        })
    } else {
        None
    };
    let (dev, ino) = sys::path_identity(path, meta, follow);
    scan.snapshot.insert(
        path.into(),
        Entry {
            kind: kind(meta),
            dev,
            ino,
            size: if directory { 0 } else { meta.len() },
            mtime: if directory { (0, 0) } else { sys::mtime(meta) },
            hash,
        },
    );
}
fn count(scan: &mut Scan, path: &str, max: usize) -> Result<(), ScanError> {
    scan.directories.insert(path.into());
    if scan.directories.len() > max {
        Err(ScanError::Budget(max))
    } else {
        Ok(())
    }
}
fn walk(
    scan: &mut Scan,
    targets: &[Target],
    index: usize,
    path: &str,
    polling: bool,
    max: usize,
) -> Result<(), ScanError> {
    if !scan.visited.insert((index, path.into())) {
        return Ok(());
    }
    let target = &targets[index];
    let read = || -> io::Result<Vec<String>> {
        fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect()
    };
    let names = match read() {
        Ok(names) => names,
        Err(error) => {
            let denied = error.kind() == io::ErrorKind::PermissionDenied;
            if (path == target.path && denied)
                || !matches!(
                    error.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::NotADirectory
                )
            {
                return Err(ScanError::Io(error, "scandir", path.into()));
            }
            return Ok(());
        }
    };
    let prefix = prefix(path);
    for name in names {
        if excluded(target, &name) {
            continue;
        }
        let path = format!("{prefix}{name}");
        let kind = if let Some(kind) = scan.listed.get(&path) {
            *kind
        } else {
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            let kind = kind(&meta);
            scan.listed.insert(path.clone(), kind);
            if !scan.snapshot.contains_key(&path) {
                record(scan, &path, &meta, false, polling);
            }
            kind
        };
        if target.recursive && kind == Kind::Directory {
            count(scan, &path, max)?;
            walk(scan, targets, index, &path, polling, max)?;
        }
    }
    Ok(())
}
fn scan(targets: &[Target], polling: bool, max: usize) -> Result<Scan, ScanError> {
    let mut scan = Scan {
        snapshot: Snapshot::new(),
        linked: HashSet::new(),
        directories: HashSet::new(),
        visited: HashSet::new(),
        listed: HashMap::new(),
    };
    for (index, target) in targets.iter().enumerate() {
        for path in ancestors(&target.path) {
            if scan.snapshot.contains_key(&path) {
                continue;
            }
            if let Ok(meta) = fs::symlink_metadata(&path) {
                record(&mut scan, &path, &meta, false, false);
                let entry = scan.snapshot.get_mut(&path).unwrap();
                entry.size = 0;
                entry.mtime = (0, 0);
            }
        }
        let meta = match fs::metadata(&target.path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(ScanError::Io(error, "stat", target.path.clone()));
            }
            Err(_) => continue,
        };
        record(&mut scan, &target.path, &meta, true, polling);
        if meta.is_file()
            && fs::symlink_metadata(&target.path).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            scan.linked.insert(target.path.clone());
        }
        if meta.is_dir() {
            count(&mut scan, &target.path, max)?;
            walk(&mut scan, targets, index, &target.path, polling, max)?;
        }
    }
    Ok(scan)
}
#[cfg(any(target_os = "linux", target_os = "android"))]
fn unreliable(targets: &[Target]) -> bool {
    for target in targets {
        for path in std::iter::once(target.path.clone()).chain(ancestors(&target.path)) {
            let Ok(path) = std::ffi::CString::new(path) else {
                break;
            };
            let mut info: libc::statfs = unsafe { std::mem::zeroed() };
            if unsafe { libc::statfs(path.as_ptr(), &mut info) } != 0 {
                continue;
            }
            let code = (info.f_type as u64) & 0xffffffff;
            if [
                0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997, 0x0bd00bd0,
                0x47504653, 0x00c36400, 0x5346414f, 0x6b414653, 0x5dca2df5,
            ]
            .contains(&code)
            {
                return true;
            }
            break;
        }
    }
    false
}
#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn unreliable(_targets: &[Target]) -> bool {
    false
}
struct Session<'a> {
    id: u32,
    output: &'a Output,
    control: &'a Control,
    targets: Vec<Target>,
    mode: Mode,
    interval: Duration,
    max: usize,
    snapshot: Snapshot,
    native: Option<RecommendedWatcher>,
    sender: Sender<notify::Result<Event>>,
    installed: HashMap<String, Installed>,
    events: HashSet<String>,
    settle: Option<Instant>,
}
impl Session<'_> {
    fn send(&self, value: Value) {
        self.output.control(Frame::new(EVENT, self.id, value));
    }
    fn cancelled(&self) -> bool {
        self.control.aborted.load(Ordering::SeqCst)
    }
    fn reported(&self, path: &str) -> String {
        if self
            .targets
            .iter()
            .any(|target| contains(&target.path, path))
        {
            path.into()
        } else {
            self.targets
                .iter()
                .find(|target| contains(path, &target.path))
                .map_or_else(|| path.into(), |target| target.path.clone())
        }
    }
    fn sync(&mut self, mut report: bool) -> Result<HashSet<String>, ScanError> {
        let mut changes = HashSet::new();
        for _ in 0..10 {
            if self.cancelled() {
                break;
            }
            let next = scan(&self.targets, self.mode == Mode::Polling, self.max)?;
            if report {
                for (path, entry) in &next.snapshot {
                    if self.snapshot.get(path) != Some(entry) {
                        changes.insert(self.reported(path));
                    }
                }
                for path in self.snapshot.keys() {
                    if !next.snapshot.contains_key(path) {
                        changes.insert(self.reported(path));
                    }
                }
            }
            self.snapshot = next.snapshot;
            if self.mode == Mode::Polling || !self.reconcile(&next.linked) {
                break;
            }
            if cfg!(target_os = "macos") {
                self.settle = Some(Instant::now() + Duration::from_millis(500));
            }
            report = true;
        }
        Ok(changes)
    }
    fn fallback(&mut self) {
        if self.mode != Mode::Polling {
            self.mode = Mode::Polling;
            self.native = None;
            self.installed.clear();
            self.send(json!({"kind":"change","overflow":true,"mode":"polling"}));
        }
    }
    fn reconcile(&mut self, linked: &HashSet<String>) -> bool {
        let per_directory = cfg!(any(target_os = "linux", target_os = "android"));
        let mut desired: HashMap<String, bool> =
            linked.iter().map(|p| (p.clone(), false)).collect();
        for target in &self.targets {
            for path in ancestors(&target.path) {
                if self
                    .snapshot
                    .get(&path)
                    .is_some_and(|entry| entry.kind == Kind::Directory)
                {
                    desired.entry(path).or_insert(false);
                }
            }
            if self
                .snapshot
                .get(&target.path)
                .is_none_or(|entry| entry.kind != Kind::Directory)
            {
                continue;
            }
            desired.insert(target.path.clone(), target.recursive && !per_directory);
            if target.recursive && per_directory {
                for (path, entry) in &self.snapshot {
                    if entry.kind == Kind::Directory
                        && *path != target.path
                        && contains(&target.path, path)
                    {
                        desired.insert(path.clone(), false);
                    }
                }
            }
        }
        let stale: Vec<String> = self
            .installed
            .iter()
            .filter(|(path, installed)| {
                !desired.contains_key(*path)
                    || self.snapshot.get(*path).is_none_or(|entry| {
                        entry.dev != installed.dev || entry.ino != installed.ino
                    })
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in stale {
            self.installed.remove(&path);
            if let Some(watcher) = &mut self.native {
                let _ = watcher.unwatch(Path::new(&path));
            }
        }
        let mut added = false;
        for (path, recursive) in desired {
            let Some(entry) = self.snapshot.get(&path) else {
                continue;
            };
            if self.installed.contains_key(&path) {
                continue;
            }
            let (dev, ino) = (entry.dev, entry.ino);
            if self.native.is_none() {
                let sender = self.sender.clone();
                match RecommendedWatcher::new(
                    move |event| {
                        let _ = sender.send(event);
                    },
                    notify::Config::default(),
                ) {
                    Ok(watcher) => self.native = Some(watcher),
                    Err(_) => {
                        self.fallback();
                        return false;
                    }
                }
            }
            let result = self.native.as_mut().unwrap().watch(
                Path::new(&path),
                if recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                },
            );
            match result {
                Ok(()) => {
                    let canonical = fs::canonicalize(&path)
                        .ok()
                        .map(|p| p.to_string_lossy().into_owned())
                        .filter(|canonical| *canonical != path);
                    self.installed.insert(
                        path,
                        Installed {
                            dev,
                            ino,
                            canonical,
                        },
                    );
                    added = true;
                }
                Err(error) => {
                    let gone = matches!(&error.kind, notify::ErrorKind::PathNotFound)
                        || matches!(&error.kind,notify::ErrorKind::Io(e)if matches!(e.kind(),io::ErrorKind::NotFound|io::ErrorKind::PermissionDenied));
                    if !gone {
                        self.fallback();
                        return false;
                    }
                }
            }
        }
        added
    }
    fn in_scope(&self, path: &str) -> bool {
        self.targets.iter().any(|target| {
            if contains(path, &target.path) {
                return true;
            }
            if path == target.path || !contains(&target.path, path) {
                return false;
            }
            let parts: Vec<_> = path[prefix(&target.path).len()..]
                .split(sys::PATH_SEPARATOR)
                .collect();
            (target.recursive || parts.len() <= 1)
                && !parts.iter().any(|name| excluded(target, name))
        })
    }
    fn event(&mut self, event: notify::Result<Event>) -> bool {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                for path in error.paths {
                    self.installed.remove(path.to_string_lossy().as_ref());
                }
                return true;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        if event.need_rescan() || event.paths.is_empty() {
            return true;
        }
        let mut dirty = false;
        for path in event.paths {
            let path = path.to_string_lossy();
            let mut canonical: Option<(&str, &str)> = None;
            for (watched, entry) in &self.installed {
                if let Some(base) = &entry.canonical
                    && contains(base, &path)
                    && canonical.is_none_or(|(_, longest)| base.len() > longest.len())
                {
                    canonical = Some((watched, base));
                }
            }
            let path = match canonical {
                Some((watched, base)) => format!("{watched}{}", &path[base.len()..]),
                None => path.into_owned(),
            };
            if self.in_scope(&path) {
                self.events.insert(self.reported(&path));
                dirty = true;
            }
        }
        dirty
    }
    fn flush(&mut self) -> bool {
        let events = std::mem::take(&mut self.events);
        match self.sync(true) {
            Ok(mut changed) => {
                changed.extend(events);
                if !changed.is_empty() && !self.cancelled() {
                    let mut paths: Vec<_> = changed.into_iter().collect();
                    paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                    self.send(json!({"kind":"change","paths":paths}));
                }
                true
            }
            Err(error) => {
                self.send(
                    json!({"kind":"error","code":error.code(),"message":error.failure().message}),
                );
                false
            }
        }
    }
}
pub fn run(id: u32, value: &Value, output: &Output, control: &Control) -> Result<Value, Failure> {
    let invalid = || Failure::new("EINVAL", "watch needs targets");
    let targets = value["targets"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|value| {
            Ok(Target {
                path: value["path"].as_str().ok_or_else(invalid)?.into(),
                recursive: value["recursive"].as_bool().unwrap_or(false),
                hidden: value["exclude"]["hidden"].as_bool().unwrap_or(false),
                names: value["exclude"]["names"]
                    .as_array()
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(|name| name.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let mode = match value["mode"].as_str() {
        Some("native") => Mode::Native,
        Some("polling") => Mode::Polling,
        _ if cfg!(windows) || unreliable(&targets) => Mode::Polling,
        _ => Mode::Native,
    };
    let (sender, receiver) = mpsc::channel();
    let mut session = Session {
        id,
        output,
        control,
        targets,
        mode,
        interval: Duration::from_millis(value["pollIntervalMs"].as_u64().unwrap_or(2000)),
        max: value["maxDirectories"].as_u64().unwrap_or(10000) as usize,
        snapshot: Snapshot::new(),
        native: None,
        sender,
        installed: HashMap::new(),
        events: HashSet::new(),
        settle: None,
    };
    session.sync(false).map_err(|error| error.failure())?;
    session.send(json!({"kind":"ready","mode":session.mode.name()}));
    let mut flush: Option<Instant> = None;
    let mut poll = Instant::now() + session.interval;
    loop {
        if session.cancelled() {
            return Ok(json!({}));
        }
        let now = Instant::now();
        let mut wake = now + Duration::from_millis(100);
        for at in [flush, session.settle].into_iter().flatten() {
            wake = wake.min(at);
        }
        if session.mode == Mode::Polling {
            wake = wake.min(poll);
        }
        match receiver.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(event) => {
                if session.event(event) && flush.is_none() && session.mode == Mode::Native {
                    flush = Some(Instant::now() + Duration::from_millis(50));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => unreachable!(),
        }
        let now = Instant::now();
        let due = |at: Option<Instant>| at.is_some_and(|at| at <= now);
        let poll_due = session.mode == Mode::Polling && poll <= now;
        if due(flush) || due(session.settle) || poll_due {
            if due(flush) {
                flush = None;
            }
            if due(session.settle) {
                session.settle = None;
            }
            if !session.flush() {
                return Ok(json!({}));
            }
            if poll_due {
                poll = Instant::now() + session.interval;
            }
        }
    }
}
