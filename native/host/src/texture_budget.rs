//! One process-wide material budget for decoded images and GPU storage.
const MIB: usize = 1024 * 1024;
const DEFAULT_MIB: usize = 3072;
fn parse(value: Option<&str>) -> usize {
    value
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| (1..=4095).contains(v))
        .unwrap_or(DEFAULT_MIB)
        * MIB
}
pub(crate) fn bytes() -> usize {
    parse(
        std::env::var("MUTRACER_NATIVE_TEXTURE_BUDGET_MIB")
            .ok()
            .as_deref(),
    )
}
pub(crate) fn texels() -> u64 {
    (bytes() / 4) as u64
}
#[cfg(test)]
mod tests {
    #[test]
    fn budget_defaults_and_overrides_stay_within_resource_wire_offsets() {
        assert_eq!(super::parse(None), 3 * 1024 * 1024 * 1024);
        assert_eq!(super::parse(Some("2048")), 2 * 1024 * 1024 * 1024);
        assert_eq!(super::parse(Some("1")), 1024 * 1024);
        for value in ["0", "-1", "4096", "invalid", "18446744073709551615"] {
            assert_eq!(super::parse(Some(value)), super::parse(None));
        }
        assert!(super::parse(Some("4095")) < crate::memory_budget::RESOURCE_WIRE_BYTES);
    }
}
