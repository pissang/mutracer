//! Per-allocation admission budget; this is not a promise about process peak RSS.
//! Resource packets use byte offsets, while scene descriptors use word offsets.
const MIB: usize = 1024 * 1024;
pub(crate) const SCENE_WIRE_BYTES: usize = u32::MAX as usize * 4;
pub(crate) const RESOURCE_WIRE_BYTES: usize = u32::MAX as usize & !3;
pub(crate) fn bytes() -> usize {
    std::env::var("MUTRACER_NATIVE_MEMORY_BUDGET_MIB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .and_then(|v| v.checked_mul(MIB))
        .unwrap_or(8192 * MIB)
}
pub(crate) fn check(required: usize, label: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        required <= bytes(),
        "{label} requires {required} bytes; native memory budget is {} bytes (MUTRACER_NATIVE_MEMORY_BUDGET_MIB)",
        bytes()
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn wire_offsets_do_not_wrap() {
        assert_eq!(super::SCENE_WIRE_BYTES / 4, u32::MAX as usize);
        assert!(super::RESOURCE_WIRE_BYTES <= u32::MAX as usize);
        assert!(
            super::check(usize::MAX, "fixture")
                .unwrap_err()
                .to_string()
                .contains("requires")
        );
    }
}
