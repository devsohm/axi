use serde_json::{Value, json};
use std::io;

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    fields: Option<Box<FailureFields>>,
}
#[derive(Debug, Default)]
struct FailureFields {
    syscall: Option<String>,
    path: Option<String>,
    extra: Option<Value>,
}
impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            fields: None,
        }
    }
    fn fields_mut(&mut self) -> &mut FailureFields {
        self.fields.get_or_insert_with(Default::default)
    }
    pub fn path(mut self, path: &str) -> Self {
        self.fields_mut().path = Some(path.into());
        self
    }
    pub fn extra(mut self, fields: Value) -> Self {
        self.fields_mut().extra = Some(fields);
        self
    }
    pub fn io(error: &io::Error, call: &str, path: &str) -> Self {
        Self::io_between(error, call, path, None)
    }
    pub fn io_between(error: &io::Error, call: &str, path: &str, to: Option<&str>) -> Self {
        let code = crate::sys::error_name(error).to_string();
        let description = match code.as_str() {
            "EPERM" => "operation not permitted",
            "ENOENT" => "no such file or directory",
            "EIO" => "i/o error",
            "EBADF" => "bad file descriptor",
            "EAGAIN" => "resource temporarily unavailable",
            "ENOMEM" => "not enough memory",
            "EACCES" => "permission denied",
            "EBUSY" => "resource busy or locked",
            "EEXIST" => "file already exists",
            "EXDEV" => "cross-device link not permitted",
            "ENOTDIR" => "not a directory",
            "EISDIR" => "illegal operation on a directory",
            "EINVAL" => "invalid argument",
            "ENFILE" => "file table overflow",
            "EMFILE" => "too many open files",
            "ETXTBSY" => "text file is busy",
            "EFBIG" => "file too large",
            "ENOSPC" => "no space left on device",
            "EROFS" => "read-only file system",
            "EMLINK" => "too many links",
            "ENAMETOOLONG" => "name too long",
            "ENOTEMPTY" => "directory not empty",
            "ELOOP" => "too many symbolic links encountered",
            "ENOSYS" => "function not implemented",
            "ENOTSUP" => "operation not supported on socket",
            _ => "",
        };
        let description = if description.is_empty() {
            let text = error.to_string();
            text.split(" (os error")
                .next()
                .unwrap_or(&text)
                .to_lowercase()
        } else {
            description.to_string()
        };
        let target = to.map_or_else(|| format!("'{path}'"), |to| format!("'{path}' -> '{to}'"));
        let mut result = Self::new(&code, format!("{code}: {description}, {call} {target}"));
        result.fields_mut().syscall = Some(call.into());
        result.path(path)
    }
    pub fn to_json(&self) -> Value {
        let mut value = json!({"code": self.code, "message": self.message});
        if let Some(fields) = &self.fields {
            if let Some(call) = &fields.syscall {
                value["syscall"] = json!(call);
            }
            if let Some(path) = &fields.path {
                value["path"] = json!(path);
            }
            if let Some(Value::Object(extra)) = &fields.extra {
                for (key, item) in extra {
                    value[key] = item.clone();
                }
            }
        }
        value
    }
}
