use std::{io, process, sync::Mutex, thread};

static PUBLISH: Mutex<()> = Mutex::new(());

pub fn watch_stdin() {
    thread::spawn(|| {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        parent_closed();
    });
}

pub fn parent_closed() -> ! {
    // GPU work may be blocked in the driver. Only wait for any in-progress
    // file publication, then let the OS release the device and file locks.
    let _guard = PUBLISH.lock().unwrap_or_else(|e| e.into_inner());
    process::exit(0);
}

pub fn publish<T>(write: impl FnOnce() -> T) -> T {
    let _guard = PUBLISH.lock().unwrap_or_else(|e| e.into_inner());
    write()
}
