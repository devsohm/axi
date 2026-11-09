use crate::{errors::Failure, sys};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::{self, Read, Write},
    path::Path,
};
pub type Outcome<T> = Result<T, Failure>;
pub fn info(path: &str, metadata: &Metadata) -> Value {
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (sec, nsec) = sys::mtime(metadata);
    let (dev, ino) = sys::identity(metadata);
    json!({"name":name,"kind":kind,"size":metadata.len(),"mtimeSec":sec,"mtimeNsec":nsec,"dev":dev,"ino":ino})
}
pub fn lstat(path: &str) -> Outcome<Value> {
    fs::symlink_metadata(path)
        .map(|meta| info(path, &meta))
        .map_err(|error| Failure::io(&error, "lstat", path))
}
pub fn realpath(path: &str) -> Outcome<Value> {
    sys::realpath(path)
        .map(|path| json!({"path":path}))
        .map_err(|error| Failure::io(&error, "realpath", path))
}
pub fn mkdir_recursive(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if path.is_dir() {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
                return Err(error);
            };
            match mkdir_recursive(parent) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(sys::synthetic("ENOTDIR"));
                }
                result => result?,
            }
            match fs::create_dir(path) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {
                    Ok(())
                }
                result => result,
            }
        }
        Err(error) => Err(error),
    }
}
pub fn mkdir(path: &str, recursive: bool) -> Outcome<Value> {
    (if recursive {
        mkdir_recursive(Path::new(path))
    } else {
        fs::create_dir(path)
    })
    .map(|()| json!({}))
    .map_err(|error| Failure::io(&error, "mkdir", path))
}
pub fn write(path: &str, append: bool, parents: bool, bytes: &[u8]) -> Outcome<File> {
    if parents {
        if let Some(parent) = Path::new(path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            mkdir_recursive(parent)
                .map_err(|error| Failure::io(&error, "mkdir", &parent.to_string_lossy()))?;
        }
    }
    let mut file = sys::open(
        path,
        if append {
            sys::OpenMode::Append
        } else {
            sys::OpenMode::Write
        },
    )
    .map_err(|error| Failure::io(&error, "open", path))?;
    file.write_all(bytes)
        .map_err(|error| Failure::io(&error, "write", path))?;
    Ok(file)
}
pub fn truncate(path: &str, size: u64) -> Outcome<Value> {
    let file = sys::open(path, sys::OpenMode::ReadWrite)
        .map_err(|error| Failure::io(&error, "open", path))?;
    file.set_len(size)
        .map_err(|error| Failure::io(&error, "ftruncate", path))?;
    Ok(json!({}))
}
pub fn fsync(path: &str) -> Outcome<Value> {
    if Path::new(path).is_dir() {
        return Err(Failure::new(
            "EISDIR",
            format!("EISDIR: illegal operation on a directory, open '{path}'"),
        )
        .path(path));
    }
    let file = sys::open(path, sys::OpenMode::ReadWrite)
        .map_err(|error| Failure::io(&error, "open", path))?;
    file.sync_all()
        .map_err(|error| Failure::io(&error, "fsync", path))?;
    Ok(json!({}))
}
pub fn rename(from: &str, to: &str) -> Outcome<Value> {
    sys::rename(from, to)
        .map(|()| json!({}))
        .map_err(|error| Failure::io_between(&error, "rename", from, Some(to)))
}
pub fn rm(path: &str, recursive: bool, force: bool) -> Outcome<Value> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(Failure::io(&error, "lstat", path)),
    };
    let result = if meta.is_dir() {
        if !recursive {
            return Err(Failure::new(
                "ERR_FS_EISDIR",
                format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            )
            .path(path));
        }
        fs::remove_dir_all(path)
    } else {
        sys::remove_file(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "rm", path))
}
pub fn mkdtemp(prefix: &str) -> Outcome<Value> {
    sys::mkdtemp(prefix)
        .map(|path| json!({"path":path}))
        .map_err(|error| Failure::io(&error, "mkdtemp", &format!("{prefix}XXXXXX")))
}
pub fn open_reader(path: &str, no_follow: bool) -> Outcome<(File, Value)> {
    let file = sys::open_reader(path, no_follow)?;
    let meta = file
        .metadata()
        .map_err(|error| Failure::io(&error, "fstat", path))?;
    if meta.is_dir() {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    if !meta.is_file() {
        return Err(Failure::new("NOT_REGULAR", "Not a regular file").path(path));
    }
    let info = info(path, &meta);
    Ok((file, info))
}
pub fn pread(file: &File, path: &str, offset: u64, length: usize) -> Outcome<Vec<u8>> {
    let mut bytes = vec![0; length];
    let mut used = 0;
    while used < length {
        match sys::read_at(file, &mut bytes[used..], offset + used as u64) {
            Ok(0) => break,
            Ok(n) => used += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
    bytes.truncate(used);
    Ok(bytes)
}
pub fn read(mut file: &File, path: &str, length: usize) -> Outcome<Vec<u8>> {
    let mut bytes = vec![0; length];
    loop {
        match file.read(&mut bytes) {
            Ok(n) => {
                bytes.truncate(n);
                return Ok(bytes);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
}
pub fn dir_entry(directory: &str, name: &OsStr) -> Value {
    let decoded = name.to_string_lossy().into_owned();
    let path = Path::new(directory)
        .join(&decoded)
        .to_string_lossy()
        .into_owned();
    let mut result = match fs::symlink_metadata(&path) {
        Ok(meta) => json!({"name":decoded,"info":info(&path,&meta)}),
        Err(error) => json!({"name":decoded,"error":Failure::io(&error,"lstat",&path).to_json()}),
    };
    if let Some(raw) = sys::raw_name(name).filter(|bytes| bytes.as_slice() != decoded.as_bytes()) {
        result["raw"] = json!(raw);
    }
    result
}
