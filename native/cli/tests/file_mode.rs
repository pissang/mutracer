use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn validate(path: &str) -> (i32, Value) {
    let result = Command::new(env!("CARGO_BIN_EXE_mutracer"))
        .arg("validate")
        .arg(fixture(path))
        .output()
        .unwrap();
    let output = if result.status.success() {
        let events = String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect::<Vec<_>>();
        events
            .into_iter()
            .rev()
            .find(|event| event["event"] != "warning")
            .map(|event| serde_json::to_vec(&event).unwrap())
            .expect("successful validation emits a non-warning event")
    } else {
        result.stderr
    };
    (
        result.status.code().unwrap(),
        serde_json::from_slice(&output).unwrap(),
    )
}

#[test]
fn validate_checks_sidecars_and_reports_located_errors() {
    let (status, result) = validate("tests/fixtures/sidecar-shot.json");
    assert_eq!(status, 0);
    assert_eq!(result["cost"]["frames"], 3);
    assert_eq!(result["cost"]["pixelSamples"], 36864);
    let (status, result) = validate("tests/fixtures/bad-sidecar.json");
    assert_eq!(status, 2);
    assert_eq!(result["pointer"], "/objects/0/geometry/positions");
    let (status, result) = validate("tests/fixtures/unknown-key.json");
    assert_eq!(status, 2);
    assert_eq!(result["pointer"], "/output/fpss");
}

#[test]
fn example_shots_pass_native_cpu_preparation() {
    for path in ["examples/turntable.json", "examples/material-sweep.json"] {
        let (status, result) = validate(path);
        assert_eq!(status, 0, "{path}: {result}");
        assert_eq!(result["cost"]["frames"], 24);
    }
}

#[test]
fn frame_selection_accepts_one_index_and_inclusive_ranges() {
    let temp = tempfile::tempdir().unwrap();
    for (action, selection, count) in [
        ("render", "10", 1),
        ("render", "10-10", 1),
        ("render", "10-12", 3),
        ("preview", "10", 1),
        ("preview", "10-12", 2),
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_mutracer"))
            .arg(action)
            .arg(fixture("examples/turntable.json"))
            // Let validation and planning run, but expire before starting a GPU worker.
            .args([
                "--frames",
                selection,
                "--max-minutes",
                "0.00000000002",
                "-o",
            ])
            .arg(temp.path().join(format!("{action}.mp4")))
            .output()
            .unwrap();
        assert_eq!(
            result.status.code(),
            Some(4),
            "{action} --frames {selection}"
        );
        let plan: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(plan["event"], "plan");
        assert_eq!(plan["cost"]["frames"], count);
    }

    for selection in ["10-", "12-10", "24"] {
        let result = Command::new(env!("CARGO_BIN_EXE_mutracer"))
            .arg("render")
            .arg(fixture("examples/turntable.json"))
            .args(["--frames", selection, "-o"])
            .arg(temp.path().join("invalid.mp4"))
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2), "--frames {selection}");
        assert!(result.stdout.is_empty());
    }
}

#[test]
#[ignore = "requires a native GPU"]
fn killing_only_the_supervisor_stops_the_worker_and_reuses_frames() {
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("result.mp4");
    let cache = temp.path().join("result.mp4.frames");
    let first_frame = cache.join("frame_000000.png");
    let mut command = Command::new(env!("CARGO_BIN_EXE_mutracer"));
    command
        .arg("render")
        .arg(fixture("examples/turntable.json"))
        .args(["--size", "640x360", "--spp", "32", "--frames", "0-7", "-o"])
        .arg(&output);
    let mut supervisor = command.stdout(Stdio::piped()).spawn().unwrap();
    let stdout = supervisor.stdout.take().unwrap();
    let (send, events) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = line.unwrap();
            let event: Value = serde_json::from_str(&line).unwrap();
            if send.send(event).is_err() {
                break;
            }
        }
    });

    let until = Instant::now() + Duration::from_secs(45);
    let mut worker = None;
    let ready = loop {
        match events.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Ok(event) if event["event"] == "worker" => worker = event["pid"].as_u64(),
            Ok(event) if event["event"] == "frame" && event["frame"] == 0 => break true,
            Ok(_) => {}
            Err(_) => break false,
        }
    };
    supervisor.kill().unwrap();
    supervisor.wait().unwrap();
    assert!(ready, "the worker must finish frame 0 before interruption");
    assert_ne!(worker.unwrap(), u64::from(supervisor.id()));

    // The supervisor and worker both own stdout. EOF after killing only
    // the supervisor verifies that the worker closed its inherited handle.
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        match events.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => panic!("worker kept running after supervisor died"),
            Ok(event) => assert_ne!(event["event"], "encoded"),
        }
    }
    assert!(!cache.join("frame_000007.png").exists());
    assert!(fs::read_dir(&cache).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
    let complete = fs::read(&first_frame).unwrap();

    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let events: Vec<Value> = BufReader::new(result.stdout.as_slice())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    assert!(
        events
            .iter()
            .any(|event| event["event"] == "reused" && event["frame"] == 0)
    );
    assert!(
        events
            .iter()
            .any(|event| event["event"] == "frame" && event["frame"] == 7)
    );
    assert_eq!(fs::read(first_frame).unwrap(), complete);
}
