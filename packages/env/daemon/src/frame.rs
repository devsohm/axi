use serde_json::Value;
use std::io::{self, Read, Write};

pub const REQUEST: u8 = 1;
pub const RESULT: u8 = 2;
pub const ERROR: u8 = 3;
pub const EVENT: u8 = 4;
pub const CANCEL: u8 = 5;
pub const PING: u8 = 6;
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
pub const MAX_PAYLOAD: usize = MAX_FRAME - 65536;

pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub json: Value,
    pub payload: Vec<u8>,
}
impl Frame {
    pub fn new(kind: u8, id: u32, json: Value) -> Self {
        Self::with_payload(kind, id, json, Vec::new())
    }
    pub fn with_payload(kind: u8, id: u32, json: Value, payload: Vec<u8>) -> Self {
        Self {
            kind,
            id,
            json,
            payload,
        }
    }
}
fn corrupt(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut word = [0; 4];
    match input.read_exact(&mut word) {
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
        Ok(()) => {}
    }
    let size = u32::from_be_bytes(word) as usize;
    if !(9..=MAX_FRAME).contains(&size) {
        return Err(corrupt("frame length out of range"));
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    let id = u32::from_be_bytes(bytes[1..5].try_into().unwrap());
    let boundary = 9 + u32::from_be_bytes(bytes[5..9].try_into().unwrap()) as usize;
    if boundary > size {
        return Err(corrupt("JSON length out of range"));
    }
    let json = if boundary == 9 {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&bytes[9..boundary]).unwrap_or(Value::Null)
    };
    Ok(Some(Frame::with_payload(
        bytes[0],
        id,
        json,
        bytes[boundary..].to_vec(),
    )))
}
pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let json = serde_json::to_vec(&frame.json).map_err(|_| corrupt("unserializable JSON"))?;
    let size = json.len() + frame.payload.len() + 9;
    if size > MAX_FRAME {
        return Err(corrupt("frame too large"));
    }
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(size as u32).to_be_bytes());
    header.push(frame.kind);
    header.extend_from_slice(&frame.id.to_be_bytes());
    header.extend_from_slice(&(json.len() as u32).to_be_bytes());
    writer.write_all(&header)?;
    writer.write_all(&json)?;
    writer.write_all(&frame.payload)?;
    writer.flush()
}
