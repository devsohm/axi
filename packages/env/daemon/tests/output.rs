use axi_env::{
    frame::{self, Frame},
    output::{Output, ReaderGate},
};
use serde_json::json;
use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[test]
fn controls_precede_bulk_and_close_drains_both_queues() {
    let output = Arc::new(Output::default());
    let unsent = Arc::new(AtomicUsize::new(0));
    output.bulk(
        Frame::with_payload(frame::EVENT, 8, json!({}), b"first".to_vec()),
        Some(unsent.clone()),
    );
    output.control(Frame::new(frame::PING, 9, json!({})));
    output.bulk(
        Frame::with_payload(frame::EVENT, 10, json!({}), b"last".to_vec()),
        Some(unsent.clone()),
    );
    assert_eq!(unsent.load(Ordering::SeqCst), 2);
    output.close();
    let mut bytes = Vec::new();
    output.run(&mut bytes);
    let mut input = bytes.as_slice();
    let ping = frame::read_frame(&mut input).unwrap().unwrap();
    assert_eq!((ping.kind, ping.id), (frame::PING, 9));
    let first = frame::read_frame(&mut input).unwrap().unwrap();
    assert_eq!((first.id, first.payload), (8, b"first".to_vec()));
    let last = frame::read_frame(&mut input).unwrap().unwrap();
    assert_eq!((last.id, last.payload), (10, b"last".to_vec()));
    assert!(frame::read_frame(&mut input).unwrap().is_none());
    assert_eq!(unsent.load(Ordering::SeqCst), 0);
}

#[test]
fn failed_write_releases_the_frame_counter_and_closes_backpressure() {
    struct BrokenWriter;
    impl Write for BrokenWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let output = Arc::new(Output::default());
    let unsent = Arc::new(AtomicUsize::new(0));
    output.bulk(Frame::new(frame::EVENT, 1, json!({})), Some(unsent.clone()));
    output.bulk(
        Frame::with_payload(frame::EVENT, 2, json!({}), vec![0; 4_194_305]),
        None,
    );
    output.run(&mut BrokenWriter);
    assert_eq!(unsent.load(Ordering::SeqCst), 0);
    assert!(ReaderGate::new(&output).forward(&AtomicBool::new(false), || true));
}

#[test]
fn reader_gate_covers_handover_and_releases_after_forwarding() {
    let output = Arc::new(Output::default());
    let gate = ReaderGate::new(&output);
    let same_command = gate.clone();
    assert!(!gate.pending());
    assert!(!gate.forward(&AtomicBool::new(false), || {
        assert!(same_command.pending());
        false
    }));
    assert!(!same_command.pending());
}
