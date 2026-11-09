fn main() {
    let version_header = "../include/mutracer-version.h";
    println!("cargo:rerun-if-changed={version_header}");
    let header = std::fs::read_to_string(version_header).unwrap();
    assert!(
        header.lines().any(|line| line == format!("#define MT_SDK_VERSION \"{}\"", env!("CARGO_PKG_VERSION"))),
        "Run node native/scripts/generate-sdk-version.mjs after changing the SDK version"
    );
    println!("cargo:rerun-if-changed=../src/mutracer-internal-layout.h");
    // This is the same wrapper used by the WebAssembly build, linked natively.
    println!("cargo:rerun-if-changed=tinybvh.cpp");
    println!("cargo:rerun-if-changed=../../src/tinybvh/tinybvh_wrapper.cpp");
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let manifest_path = root.join("src/tinybvh/upstream.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    let mut include = root
        .join(".cache/tinybvh")
        .join(manifest["revision"].as_str().unwrap());
    for file in manifest["files"].as_array().unwrap() {
        let header = include.join(file["file"].as_str().unwrap());
        assert!(
            header.is_file(),
            "TinyBVH header missing: {}. Run npm run fetch:tinybvh from the repository root before Cargo.",
            header.display()
        );
        println!("cargo:rerun-if-changed={}", header.display());
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Keep the verified upstream cache intact. DLL static destructors run
        // after ExitProcess has killed the other threads, so pool cleanup must
        // check Windows' process-termination state before CRT teardown.
        let adapted =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("tinybvh");
        std::fs::create_dir_all(&adapted).unwrap();
        for file in manifest["files"].as_array().unwrap() {
            let name = file["file"].as_str().unwrap();
            let mut source = std::fs::read_to_string(include.join(name)).unwrap();
            if name == "tiny_bvh_base.h" {
                let original =
                    "struct PoolAtExit { ~PoolAtExit() { tinybvh_shutdown_builtin_pool(); } };";
                assert_eq!(
                    source.matches(original).count(),
                    1,
                    "TinyBVH exit hook changed"
                );
                source = source.replace(original, "struct PoolAtExit { ~PoolAtExit() { if (!::mt_native_process_terminating()) tinybvh_shutdown_builtin_pool(); } };");
            }
            std::fs::write(adapted.join(name), source).unwrap();
        }
        include = adapted;
    }
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .opt_level(3)
        // Preserve conservative bounds across native SIMD and scalar Wasm.
        .flag_if_supported("-ffp-contract=off")
        .flag_if_supported("/fp:strict")
        .file("tinybvh.cpp")
        .include(include)
        .warnings(false)
        .compile("mutracer_tinybvh");
    println!("cargo:rerun-if-env-changed=MUTRACER_AOT_ARCHIVE");
    let archive = std::env::var("MUTRACER_AOT_ARCHIVE")
        .expect("Set MUTRACER_AOT_ARCHIVE to the scriptc render-core.lib.a");
    println!("cargo:rerun-if-changed={archive}");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let library_name = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        "mutracer_aot.lib"
    } else {
        "libmutracer_aot.a"
    };
    std::fs::copy(archive, output.join(library_name)).unwrap();
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=mutracer_aot");
    // System imports used by the scriptc runtime and UCRT compatibility layer.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        for library in [
            "ws2_32", "bcrypt", "crypt32", "iphlpapi", "userenv", "ntdll", "advapi32",
        ] {
            println!("cargo:rustc-link-lib={library}");
        }
    }
}
