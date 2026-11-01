use crate::frame::{Frame, write_frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;

type CountedFrame = (Frame, Option<Arc<AtomicUsize>>);
#[derive(Default)]
struct State {
    urgent: VecDeque<Frame>,
    bulk: VecDeque<CountedFrame>,
    bytes: usize,
    closed: bool,
}
#[derive(Default)]
pub struct Output {
    state: Mutex<State>,
    changed: Condvar,
    room: Condvar,
}
impl Output {
    pub fn control(&self, frame: Frame) {
        let mut state = self.state.lock().unwrap();
        state.urgent.push_back(frame);
        self.changed.notify_one();
    }
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut state = self.state.lock().unwrap();
        state.bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        state.bulk.push_back((frame, unsent));
        self.changed.notify_one();
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.changed.notify_all();
        self.room.notify_all();
    }
    pub fn wait_for_room(&self, stop: &AtomicBool) {
        let mut state = self.state.lock().unwrap();
        while state.bytes > 4194304 && !state.closed && !stop.load(Ordering::SeqCst) {
            state = self
                .room
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, counter) = {
                let mut state = self.state.lock().unwrap();
                loop {
                    if let Some(frame) = state.urgent.pop_front() {
                        break (frame, None);
                    }
                    if let Some(item) = state.bulk.pop_front() {
                        state.bytes -= item.0.payload.len();
                        break item;
                    }
                    if state.closed {
                        return;
                    }
                    state = self.changed.wait(state).unwrap();
                }
            };
            let result = write_frame(writer, &frame);
            if let Some(counter) = counter {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.room.notify_all();
            if result.is_err() {
                self.close();
                return;
            }
        }
    }
}
