use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
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
        result.stdout
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
