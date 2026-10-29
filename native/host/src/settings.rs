//! C fields are copied into the TS settings record; normalization stays in TS.
use super::*;
use crate::layout::{WORD_BYTES, settings as wire};

#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub struct RenderSettings {
    pub struct_size: u32,
    pub sampling_pattern: u32,
    pub seed: u32,
    pub max_samples: u32,
    pub bounces: u32,
    pub direct_light_candidates: u32,
    pub bevel_samples: u32,
    pub sample_sequence_offset: u32,
    pub clamping: f64,
    pub transmissive_output_alpha_min: f64,
    pub caustic_flags: u32,
    pub light_photons: u32,
    pub photon_map_photons: u32,
    pub photon_map_radius: f32,
}
impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            sampling_pattern: 0,
            seed: 12345,
            max_samples: 64,
            bounces: 6,
            direct_light_candidates: 2,
            bevel_samples: 8,
            sample_sequence_offset: 0,
            clamping: 0.,
            transmissive_output_alpha_min: 1.,
            caustic_flags: 0,
            light_photons: 0,
            photon_map_photons: 0,
            photon_map_radius: 0.,
        }
    }
}
impl RenderSettings {
    // The internal wire record keeps f64 counts and its own size; TS clamps them.
    pub(super) fn wire(&self, variants: u32) -> Result<Vec<u8>> {
        if self.struct_size as usize != std::mem::size_of::<Self>() {
            return Err(fail(
                Status::InvalidArgument,
                "mt_render_settings.struct_size must be sizeof(mt_render_settings)",
            ));
        }
        if self.caustic_flags & !6 != 0
            || !self.photon_map_radius.is_finite()
            || self.photon_map_radius < 0.
        {
            return Err(fail(Status::InvalidArgument, "Invalid caustic settings"));
        }
        let mut bytes = vec![0; wire::WORDS * WORD_BYTES];
        for (field, value) in [
            (wire::STRUCT_SIZE, (wire::WORDS * WORD_BYTES) as u32),
            (wire::SAMPLING_PATTERN, self.sampling_pattern),
            (wire::SEED, self.seed),
            (wire::MAX_SAMPLES, self.max_samples),
            (wire::SEQUENCE_OFFSET, self.sample_sequence_offset),
            (wire::VARIANTS, variants),
            (wire::CAUSTIC_FLAGS, self.caustic_flags),
            (wire::LIGHT_PHOTONS, self.light_photons),
            (wire::PHOTON_MAP_PHOTONS, self.photon_map_photons),
            (wire::PHOTON_MAP_RADIUS, self.photon_map_radius.to_bits()),
        ] {
            bytes[field * WORD_BYTES..(field + 1) * WORD_BYTES]
                .copy_from_slice(&value.to_le_bytes());
        }
        for (field, value) in [
            (wire::BOUNCES, f64::from(self.bounces)),
            (
                wire::DIRECT_LIGHT_CANDIDATES,
                f64::from(self.direct_light_candidates),
            ),
            (wire::BEVEL_SAMPLES, f64::from(self.bevel_samples)),
            (wire::CLAMPING, self.clamping),
            (
                wire::TRANSMISSIVE_ALPHA_MIN,
                self.transmissive_output_alpha_min,
            ),
        ] {
            bytes[field * WORD_BYTES..(field + 2) * WORD_BYTES]
                .copy_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    }
}
/// # Safety
/// Non-null output must be writable for a complete RenderSettings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_settings_default(output: *mut RenderSettings) -> i32 {
    if output.is_null() {
        return crate::Status::InvalidArgument as i32;
    }
    unsafe {
        *output = RenderSettings::default();
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn c_struct_layout_and_wire_conversion() {
        // Mirrors the _Static_assert in mutracer-context.h.
        assert_eq!(std::mem::size_of::<RenderSettings>(), 64);
        assert_eq!(std::mem::offset_of!(RenderSettings, clamping), 32);
        let settings = RenderSettings {
            bounces: 7,
            caustic_flags: 6,
            light_photons: 123,
            photon_map_photons: 456,
            photon_map_radius: 0.25,
            ..Default::default()
        };
        let bytes = settings.wire(0).unwrap();
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let double = |i: usize| f64::from_le_bytes(bytes[i * 4..i * 4 + 8].try_into().unwrap());
        assert_eq!(word(wire::STRUCT_SIZE) as usize, wire::WORDS * WORD_BYTES);
        assert_eq!(double(wire::BOUNCES), 7.);
        assert_eq!(word(wire::CAUSTIC_FLAGS), 6);
        assert_eq!(word(wire::LIGHT_PHOTONS), 123);
        assert_eq!(word(wire::PHOTON_MAP_PHOTONS), 456);
        assert_eq!(f32::from_bits(word(wire::PHOTON_MAP_RADIUS)), 0.25);
        assert_eq!(double(wire::TRANSMISSIVE_ALPHA_MIN), 1.);
        let wrong = RenderSettings {
            struct_size: 48,
            ..Default::default()
        };
        assert!(wrong.wire(0).is_err());
        for (flags, radius) in [(16, 0.), (1, 0.), (9, 0.), (8, 0.), (0, -1.), (0, f32::NAN)] {
            assert!(
                RenderSettings {
                    caustic_flags: flags,
                    photon_map_radius: radius,
                    ..Default::default()
                }
                .wire(0)
                .is_err()
            );
        }
    }
}
