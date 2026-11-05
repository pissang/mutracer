//! Shared post-processing source, cached after one call to the TS AOT generator.
use crate::Result;
use std::sync::OnceLock;

#[derive(Debug, serde::Deserialize, serde::Serialize, PartialEq)]
pub(crate) struct Sources {
    pub bloom: String,
    pub auxiliary: String,
    pub normalize: String,
    pub frame_resolve: String,
    pub oidn_composition: [String; 2],
    pub oidn_display: String,
    pub bloom_levels: usize,
    pub bloom_plan: Vec<(usize, usize, usize, usize, f32, f32)>,
    /// EASU color, area downsample, guided detail, albedo guides, tone table and albedo fit.
    pub easu: [String; 6],
    /// Ratio range, depth and coverage thresholds, minimum albedo, depth
    /// tolerance and guided-fit regularization.
    pub easu_detail: [f32; 7],
    pub tone_lut_size: u32,
    /// Default and display-resolution AOV entry points of the path tracer.
    pub aov_trace: [String; 2],
}
unsafe extern "C" {
    fn mt_core_postprocess(output: *mut *const u8, size: *mut usize);
    fn mt_core_bloom_parameters(radius: f64, output: *mut *const u8, size: *mut usize);
}
pub(crate) fn bloom_parameters(radius: f32) -> Result<[f32; 2]> {
    crate::runtime::call(move || {
        let mut pointer = std::ptr::null();
        let mut length = 0;
        unsafe { mt_core_bloom_parameters(radius as f64, &mut pointer, &mut length) };
        let bytes = unsafe { crate::copy_core_result(pointer, length, length)? };
        unsafe { crate::mt_core_collect() };
        Ok(serde_json::from_slice(&bytes)?)
    })
}
pub(crate) fn sources() -> Result<&'static Sources> {
    static SOURCES: OnceLock<Sources> = OnceLock::new();
    if let Some(sources) = SOURCES.get() {
        return Ok(sources);
    }
    let sources = crate::runtime::call(|| {
        let mut pointer = std::ptr::null();
        let mut length = 0;
        unsafe { mt_core_postprocess(&mut pointer, &mut length) };
        let bytes = unsafe { crate::copy_core_result(pointer, length, length)? };
        unsafe { crate::mt_core_collect() };
        Ok(serde_json::from_slice::<Sources>(&bytes)?)
    })?;
    // Concurrent callers may prepare the same immutable packet; either is valid.
    let _ = SOURCES.set(sources);
    Ok(SOURCES.get().unwrap())
}

#[cfg(test)]
#[test]
fn shared_postprocess_sources_validate_and_match_js() {
    let sources = sources().unwrap();
    for source in [
        &sources.bloom,
        &sources.auxiliary,
        &sources.normalize,
        &sources.frame_resolve,
        &sources.oidn_display,
        &sources.oidn_composition[0],
        &sources.oidn_composition[1],
        &sources.easu[0],
        &sources.easu[1],
        &sources.easu[2],
        &sources.easu[3],
        &sources.easu[4],
        &sources.easu[5],
    ] {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap();
    }
    let defaults = crate::api::EasuOptions::default();
    assert_eq!(
        sources.easu_detail[..4],
        [
            defaults.ratio_range[0],
            defaults.ratio_range[1],
            defaults.depth_threshold,
            defaults.coverage_threshold
        ]
    );
    assert!(sources.aov_trace.iter().all(|s| !s.is_empty()));
    if let Ok(path) = std::env::var("MUTRACER_POSTPROCESS_SOURCES") {
        let reference: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let expected: Sources = serde_json::from_value(reference["sources"].clone()).unwrap();
        assert_eq!(sources, &expected);
        for case in reference["bloom"].as_array().unwrap() {
            let radius = case["radius"].as_f64().unwrap() as f32;
            let expected: [f32; 2] = serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(bloom_parameters(radius).unwrap(), expected);
        }
        for case in reference["viewer"].as_array().unwrap() {
            let args: Vec<f64> = serde_json::from_value(case["args"].clone()).unwrap();
            let expected: Vec<f64> = serde_json::from_value(case["expected"].clone()).unwrap();
            let actual =
                crate::viewer_math::values(case["kind"].as_u64().unwrap() as u32, &args).unwrap();
            assert_eq!(actual.len(), expected.len());
            for (a, b) in actual.into_iter().zip(expected) {
                assert!(
                    (a - b).abs() <= 1e-12 * b.abs().max(1.),
                    "viewer {a} != {b}"
                );
            }
        }
    }
}
