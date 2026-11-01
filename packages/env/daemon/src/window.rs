use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct Window {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub min_interval: Duration,
    pub bytes_per_second: f64,
}
impl Window {
    pub fn from_json(value: &Value) -> Option<Self> {
        let value = value.as_object()?;
        Some(Self {
            max_bytes: value.get("maxBytes")?.as_u64()? as usize,
            max_lines: value.get("maxLines")?.as_u64()? as usize,
            min_interval: Duration::from_secs_f64(
                value.get("minIntervalMs")?.as_f64()?.max(0.0) / 1000.0,
            ),
            bytes_per_second: value.get("bytesPerSecond")?.as_f64()?.max(1.0),
        })
    }
}
pub struct Event {
    pub stream: &'static str,
    pub text: String,
    pub skipped: Option<Value>,
}
#[derive(Default)]
struct Omitted {
    bytes: u64,
    lines: u64,
    newline: bool,
}
pub struct Pending {
    limits: Window,
    pieces: Vec<(&'static str, String)>,
    bytes: usize,
    lines: usize,
    omitted: Option<Omitted>,
    ready: Instant,
}
fn lines(text: &str) -> usize {
    text.as_bytes()
        .iter()
        .filter(|&&byte| byte == b'\n')
        .count()
}
impl Pending {
    pub fn new(limits: Window) -> Self {
        Self {
            limits,
            pieces: Vec::new(),
            bytes: 0,
            lines: 0,
            omitted: None,
            ready: Instant::now(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.pieces.is_empty()
    }
    pub fn next_send(&self) -> Instant {
        self.ready
    }
    pub fn push(&mut self, stream: &'static str, text: String) {
        if text.is_empty() {
            return;
        }
        self.bytes += text.len();
        self.lines += lines(&text);
        match self.pieces.last_mut() {
            Some((name, previous)) if *name == stream => previous.push_str(&text),
            _ => self.pieces.push((stream, text)),
        }
        if self.bytes > 4 * (self.limits.max_bytes + 1)
            || self.lines > 4 * (self.limits.max_lines + 1)
        {
            self.trim();
        }
    }
    fn outside(&self, bytes: usize, newlines: usize) -> bool {
        bytes > self.limits.max_bytes || newlines > self.limits.max_lines
    }
    fn trim(&mut self) {
        let mut removed = String::new();
        while self.pieces.len() > 1 {
            let first = &self.pieces[0].1;
            let count = lines(first);
            if !self.outside(self.bytes - first.len(), self.lines - count) {
                break;
            }
            let (_, text) = self.pieces.remove(0);
            self.bytes -= text.len();
            self.lines -= count;
            removed.push_str(&text);
        }
        let first = &self.pieces[0].1;
        let rest_bytes = self.bytes - first.len();
        let rest_lines = self.lines - lines(first);
        let keep_bytes = (self.limits.max_bytes + 1).saturating_sub(rest_bytes);
        let mut cut = 0;
        if first.len() > keep_bytes {
            cut = first.len() - keep_bytes;
            while cut > 0 && !first.is_char_boundary(cut) {
                cut -= 1;
            }
        }
        let keep_lines = (self.limits.max_lines + 1).saturating_sub(rest_lines);
        if keep_lines == 0 {
            cut = first.len();
        } else {
            let positions: Vec<usize> = first
                .bytes()
                .enumerate()
                .filter(|(_, byte)| *byte == b'\n')
                .map(|(position, _)| position)
                .collect();
            if positions.len() >= keep_lines {
                cut = cut.max(positions[positions.len() - keep_lines]);
            }
        }
        if cut > 0 {
            let first = &mut self.pieces[0].1;
            let prefix: String = first.drain(..cut).collect();
            self.bytes -= prefix.len();
            self.lines -= lines(&prefix);
            removed.push_str(&prefix);
            if first.is_empty() {
                self.pieces.remove(0);
            }
        }
        if !removed.is_empty() {
            let skipped = self.omitted.get_or_insert_with(Omitted::default);
            skipped.bytes += removed.len() as u64;
            skipped.lines += lines(&removed) as u64;
            skipped.newline = removed.ends_with('\n');
        }
    }
    pub fn take(&mut self) -> Vec<Event> {
        let pieces = std::mem::take(&mut self.pieces);
        let delivered = self.bytes;
        self.bytes = 0;
        self.lines = 0;
        let pace = Duration::from_secs_f64(
            delivered.min(self.limits.max_bytes) as f64 / self.limits.bytes_per_second,
        );
        self.ready = Instant::now() + self.limits.min_interval.max(pace);
        if let Some(omitted) = self.omitted.take() {
            let stream = pieces.last().map(|(stream, _)| *stream).unwrap_or("stdout");
            vec![Event {
                stream,
                text: pieces.into_iter().map(|(_, text)| text).collect(),
                skipped: Some(
                    json!({"bytes": omitted.bytes, "newlines": omitted.lines, "endsWithNewline": omitted.newline}),
                ),
            }]
        } else {
            pieces
                .into_iter()
                .map(|(stream, text)| Event {
                    stream,
                    text,
                    skipped: None,
                })
                .collect()
        }
    }
}
