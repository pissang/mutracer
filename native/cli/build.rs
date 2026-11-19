use std::process::Command;

fn main() {
    // A different executable may produce different pixels. Packagers can
    // supply the source revision when building without a Git checkout.
    println!("cargo:rerun-if-env-changed=MUTRACER_CLI_REVISION");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../host/src");
    let revision = std::env::var("MUTRACER_CLI_REVISION").unwrap_or_else(|_| {
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_else(|| "source".into())
    });
    println!(
        "cargo:rustc-env=MUTRACER_CLI_BUILD_ID={}-{}",
        env!("CARGO_PKG_VERSION"),
        revision
    );
}
