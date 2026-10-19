use crate::decode::{decode_into, range_decoder, starts_with_bom};
use encoding_rs::Decoder;
use serde_json::{Value, json};

pub struct LineScanner {
    from: u64,
    to: Option<u64>,
    position: u64,
    newlines: u64,
    line_start: u64,
    start: Option<u64>,
    end: Option<u64>,
    first_end: Option<u64>,
    last_start: Option<u64>,
    selected: u64,
    first_bytes: u64,
    selection: Option<Decoder>,
    first_line: Option<Decoder>,
    head: Option<Vec<u8>>,
    bom: bool,
}
impl LineScanner {
    pub fn new(from: u64, to: Option<u64>) -> Self {
        let mut scanner = Self {
            from,
            to,
            position: 0,
            newlines: 0,
            line_start: 0,
            start: None,
            end: None,
            first_end: None,
            last_start: None,
            selected: 0,
            first_bytes: 0,
            selection: None,
            first_line: None,
            head: Some(Vec::with_capacity(3)),
            bom: false,
        };
        if from == 0 {
            scanner.begin(0);
        }
        scanner
    }
    fn last_line(&self, line: u64) -> bool {
        self.to.is_some_and(|to| line + 1 == to)
    }
    pub fn push(&mut self, mut bytes: &[u8]) {
        if let Some(head) = &mut self.head {
            let take = bytes.len().min(3 - head.len());
            head.extend_from_slice(&bytes[..take]);
            if head.len() < 3 {
                return;
            }
            bytes = &bytes[take..];
            self.release_head();
        }
        self.process(bytes);
    }
    fn release_head(&mut self) {
        let head = self.head.take().unwrap_or_default();
        self.bom = starts_with_bom(&head);
        self.process(&head);
    }
    fn process(&mut self, bytes: &[u8]) {
        let base = self.position;
        let mut at = 0;
        while let Some(distance) = bytes[at..].iter().position(|byte| *byte == b'\n') {
            let newline = at + distance;
            self.feed(bytes, base, at, newline);
            let position = base + newline as u64;
            if self.newlines == self.from {
                self.end_first(position);
            }
            if self.last_line(self.newlines) {
                self.end_selection(position);
            }
            self.feed(bytes, base, newline, newline + 1);
            self.newlines += 1;
            self.line_start = position + 1;
            if self.newlines == self.from {
                self.begin(self.line_start);
            }
            if self.last_line(self.newlines) {
                self.last_start = Some(self.line_start);
            }
            at = newline + 1;
        }
        self.feed(bytes, base, at, bytes.len());
        self.position += bytes.len() as u64;
    }
    fn begin(&mut self, at: u64) {
        self.start = Some(at);
        if self.last_line(self.from) {
            self.last_start = Some(at);
        }
        self.selection = Some(range_decoder());
        self.first_line = Some(range_decoder());
    }
    fn end_first(&mut self, at: u64) {
        self.first_end = Some(at);
        if let Some(mut decoder) = self.first_line.take() {
            self.first_bytes += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }
    fn end_selection(&mut self, at: u64) {
        self.end = Some(at);
        if let Some(mut decoder) = self.selection.take() {
            self.selected += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }
    fn feed(&mut self, bytes: &[u8], base: u64, mut from: usize, to: usize) {
        if self.bom && base + (from as u64) < 3 {
            from = to.min((3 - base) as usize);
        }
        if from >= to {
            return;
        }
        let selected = &bytes[from..to];
        if let Some(decoder) = &mut self.selection {
            self.selected += decode_into(decoder, selected, false).len() as u64;
        }
        if let Some(decoder) = &mut self.first_line {
            self.first_bytes += decode_into(decoder, selected, false).len() as u64;
        }
    }
    pub fn finish(mut self) -> Value {
        if self.head.is_some() {
            self.release_head();
        }
        let size = self.position;
        let Some(start) = self.start else {
            return json!({"newlines":self.newlines,"start":size,"end":size,"firstLineEnd":size,"lastLineStart":size,"selectedBytes":0,"firstLineBytes":0});
        };
        if self.first_end.is_none() {
            self.end_first(size);
        }
        if self.end.is_none() {
            self.end_selection(size);
        }
        json!({"newlines":self.newlines,"start":start,"end":self.end.unwrap_or(size),"firstLineEnd":self.first_end.unwrap_or(size),"lastLineStart":self.last_start.unwrap_or(self.line_start),"selectedBytes":self.selected,"firstLineBytes":self.first_bytes})
    }
}
