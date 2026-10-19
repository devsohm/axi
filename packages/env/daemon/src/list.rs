use crate::{errors::Failure, frame::MAX_PAYLOAD};
use ignore::WalkBuilder;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path},
    time::{Duration, Instant},
};

pub struct Options {
    pub hidden: bool,
    pub gitignore: bool,
    pub exclude: Vec<OsString>,
    pub max_entries: u64,
    pub max_bytes: u64,
    pub timeout: Duration,
}
impl Options {
    pub fn from_json(value: &Value) -> Result<Self, Failure> {
        let count = |key: &str, default: u64| match &value[key] {
            Value::Null => Ok(default),
            item => item
                .as_u64()
                .ok_or_else(|| Failure::new("EINVAL", format!("invalid field {key}"))),
        };
        let exclude = if value["exclude"].is_null() {
            Vec::new()
        } else {
            value["exclude"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().map(OsString::from))
                        .collect()
                })
                .ok_or_else(|| Failure::new("EINVAL", "invalid field exclude"))?
        };
        Ok(Self {
            hidden: value["hidden"].as_bool().unwrap_or(true),
            gitignore: value["gitignore"].as_bool().unwrap_or(true),
            exclude,
            max_entries: count("maxEntries", 50000)?,
            max_bytes: count("maxBytes", 4194304)?.min(MAX_PAYLOAD as u64),
            timeout: Duration::from_millis(count("timeoutMs", 10000)?),
        })
    }
}
pub struct Listing {
    pub payload: Vec<u8>,
    pub count: u64,
    pub truncated: bool,
}
pub fn list(root: &str, options: &Options, aborted: &dyn Fn() -> bool) -> Result<Listing, Failure> {
    let meta = fs::metadata(root).map_err(|error| Failure::io(&error, "scandir", root))?;
    if !meta.is_dir() {
        return Err(Failure::new(
            "ENOTDIR",
            format!("ENOTDIR: not a directory, scandir '{root}'"),
        )
        .path(root));
    }
    let path = Path::new(root);
    let exclude = options.exclude.clone();
    let walk = WalkBuilder::new(path)
        .hidden(!options.hidden)
        .ignore(false)
        .parents(options.gitignore)
        .git_ignore(options.gitignore)
        .git_exclude(options.gitignore)
        .git_global(options.gitignore)
        .require_git(true)
        .follow_links(false)
        .current_dir(path)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            let name = entry.file_name();
            name != ".git" && !exclude.iter().any(|excluded| excluded == name)
        })
        .build();
    let started = Instant::now();
    let mut result = Listing {
        payload: Vec::new(),
        count: 0,
        truncated: false,
    };
    'entries: for entry in walk {
        if aborted() {
            return Err(Failure::new("aborted", "aborted"));
        }
        let Ok(entry) = entry else {
            continue;
        };
        if entry.depth() == 0 {
            continue;
        }
        let Some(kind) = entry.file_type() else {
            continue;
        };
        let kind = if kind.is_symlink() {
            b'l'
        } else if kind.is_dir() {
            b'd'
        } else if kind.is_file() {
            b'f'
        } else {
            continue;
        };
        let Ok(rest) = entry.path().strip_prefix(path) else {
            continue;
        };
        let mut relative = String::new();
        for component in rest.components() {
            let Component::Normal(name) = component else {
                continue 'entries;
            };
            if !relative.is_empty() {
                relative.push('/');
            }
            relative.push_str(&name.to_string_lossy());
        }
        if relative.is_empty() {
            continue;
        }
        if result.count >= options.max_entries
            || result.payload.len() as u64 + relative.len() as u64 + 2 > options.max_bytes
            || started.elapsed() > options.timeout
        {
            result.truncated = true;
            break;
        }
        result.payload.push(kind);
        result.payload.extend_from_slice(relative.as_bytes());
        result.payload.push(0);
        result.count += 1;
    }
    Ok(result)
}
pub fn run(value: &Value, aborted: &dyn Fn() -> bool) -> Result<(Value, Vec<u8>), Failure> {
    let root = value["path"]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", "missing field path"))?;
    let listing = list(root, &Options::from_json(value)?, aborted)?;
    Ok((
        json!({"count":listing.count,"truncated":listing.truncated}),
        listing.payload,
    ))
}
