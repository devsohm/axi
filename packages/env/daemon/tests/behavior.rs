use axi_env::{
    errors::Failure,
    frame::{self, Frame},
    scan::LineScanner,
    window::{Pending, Window},
};
use serde_json::json;
use std::time::Duration;

#[test]
fn response_frame_has_a_stable_header_json_boundary_and_raw_payload() {
    let mut bytes = Vec::new();
    frame::write_frame(
        &mut bytes,
        &Frame::with_payload(2, 7, json!({"ok":true}), vec![0, 255, 10]),
    )
    .unwrap();
    let mut expected = vec![0, 0, 0, 23, 2, 0, 0, 0, 7, 0, 0, 0, 11];
    expected.extend_from_slice(b"{\"ok\":true}");
    expected.extend_from_slice(&[0, 255, 10]);
    assert_eq!(bytes, expected);
    let decoded = frame::read_frame(&mut bytes.as_slice()).unwrap().unwrap();
    assert_eq!(
        (decoded.kind, decoded.id, decoded.payload),
        (2, 7, vec![0, 255, 10])
    );
    assert_eq!(decoded.json, json!({"ok":true}));
    assert_eq!(
        frame::read_frame(&mut [0, 0, 0, 8].as_slice())
            .err()
            .unwrap()
            .to_string(),
        "frame length out of range"
    );
}
#[test]
fn additional_failure_fields_replace_previous_extras_and_override_defaults() {
    let failure = Failure::new("initial", "original")
        .extra(json!({"discarded": true}))
        .extra(json!({"code": "custom", "path": "extra"}))
        .path("fallback");
    assert_eq!(
        failure.to_json(),
        json!({"code": "custom", "message": "original", "path": "extra"})
    );
    assert_eq!(
        Failure::new("initial", "original")
            .extra(json!({"discarded": true}))
            .extra(json!(null))
            .to_json(),
        json!({"code": "initial", "message": "original"})
    );
}
#[test]
fn line_ranges_keep_raw_offsets_and_count_decoded_invalid_utf8() {
    let bytes = [
        239, 187, 191, 97, 10, 226, 130, 10, 10, 239, 187, 191, 98, 10, 195, 169,
    ];
    for size in [1, 2, 3, 7, 16] {
        let mut scanner = LineScanner::new(1, Some(3));
        for part in bytes.chunks(size) {
            scanner.push(part);
        }
        assert_eq!(
            scanner.finish(),
            json!({"newlines":4,"start":5,"end":8,"firstLineEnd":7,"lastLineStart":8,"selectedBytes":4,"firstLineBytes":3})
        );
    }
}
#[test]
fn output_windows_account_for_every_byte_and_keep_the_exact_suffix() {
    let mut output = Pending::new(Window {
        max_bytes: 19,
        max_lines: 3,
        min_interval: Duration::ZERO,
        bytes_per_second: 1e9,
    });
    let mut full = String::new();
    for number in 0..200 {
        let line = format!("message {number} 😀\n");
        full.push_str(&line);
        output.push("stdout", line);
    }
    let events = output.take();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    let skipped = event.skipped.as_ref().unwrap();
    assert_eq!(
        skipped["bytes"].as_u64().unwrap() + event.text.len() as u64,
        full.len() as u64
    );
    assert_eq!(
        skipped["newlines"].as_u64().unwrap()
            + event.text.bytes().filter(|b| *b == 10).count() as u64,
        200
    );
    assert!(full.ends_with(&event.text));
    assert!(event.text.len() > 19 || event.text.bytes().filter(|b| *b == 10).count() > 3);
}
