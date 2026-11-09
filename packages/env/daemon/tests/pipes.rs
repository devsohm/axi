use axi_env::sys;
use std::{
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

fn peer(test: &str) -> Child {
    if std::env::var_os("AXI_ENV_PIPE_CHILD").is_some() {
        thread::sleep(Duration::from_secs(20));
        std::process::exit(0);
    }
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("AXI_ENV_PIPE_CHILD", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn blocked_read_stops_without_waiting_for_the_child() {
    let mut child = peer("blocked_read_stops_without_waiting_for_the_child");
    let pipe = child.stdout.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::channel();
    let flag = stop.clone();
    let reader = thread::spawn(move || {
        sys::read_pipe(pipe, &flag, |_| true);
        send.send(()).unwrap();
    });
    thread::sleep(Duration::from_millis(150));
    stop.store(true, Ordering::SeqCst);
    let result = receive.recv_timeout(Duration::from_secs(2));
    let _ = child.kill();
    let _ = child.wait();
    reader.join().unwrap();
    assert!(result.is_ok(), "stopped pipe read remained blocked");
}

#[test]
fn blocked_write_stops_without_waiting_for_the_child() {
    let mut child = peer("blocked_write_stops_without_waiting_for_the_child");
    let mut pipe = child.stdin.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let (send, receive) = mpsc::channel();
    let flag = stop.clone();
    let writer = thread::spawn(move || {
        let result = sys::write_process_input(&mut pipe, &vec![7; 8 * 1024 * 1024], &flag);
        send.send(result).unwrap();
    });
    thread::sleep(Duration::from_millis(150));
    stop.store(true, Ordering::SeqCst);
    let result = receive.recv_timeout(Duration::from_secs(2));
    let _ = child.kill();
    let _ = child.wait();
    writer.join().unwrap();
    assert_eq!(result.unwrap(), false, "stopped pipe write completed");
}
