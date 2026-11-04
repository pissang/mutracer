//! Owned immutable TinyBVH picking; no scene or GPU state is shared.
use std::ptr::NonNull;
unsafe extern "C" {
    fn mt_native_pick_create(
        p: *const f32,
        nv: u32,
        i: *const u32,
        ni: u32,
    ) -> *mut std::ffi::c_void;
    fn mt_native_pick_destroy(p: *mut std::ffi::c_void);
    fn mt_native_pick_hit(
        p: *const std::ffi::c_void,
        o: *const f32,
        d: *const f32,
        nearest: f32,
        out: *mut GeometryHit,
    ) -> u32;
    fn mt_native_pick_query(
        p: *const std::ffi::c_void,
        o: *const f32,
        d: *const f32,
        nearest: f32,
    ) -> f32;
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct GeometryHit {
    pub distance: f32,
    pub u: f32,
    pub v: f32,
    pub primitive: u32,
}
pub struct PickBvh(NonNull<std::ffi::c_void>);
// C++ owns copied inputs and immutable BVH nodes. Queries mutate only a stack Ray.
unsafe impl Send for PickBvh {}
unsafe impl Sync for PickBvh {}
impl PickBvh {
    pub fn new(positions: &[f32], indices: &[u32]) -> Result<Self, String> {
        if positions.len() % 3 != 0
            || indices.len() % 3 != 0
            || indices.is_empty()
            || positions.len() / 3 > u32::MAX as usize
            || indices.len() > u32::MAX as usize
            || positions.iter().any(|v| !v.is_finite())
            || indices.iter().any(|&i| i as usize >= positions.len() / 3)
        {
            return Err("Invalid picking geometry".into());
        }
        NonNull::new(unsafe {
            mt_native_pick_create(
                positions.as_ptr(),
                (positions.len() / 3) as u32,
                indices.as_ptr(),
                indices.len() as u32,
            )
        })
        .map(Self)
        .ok_or("Picking BVH build failed".into())
    }
    pub(crate) fn intersect_hit(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        nearest: f32,
    ) -> Option<GeometryHit> {
        if origin.iter().chain(&direction).any(|v| !v.is_finite())
            || nearest.is_nan()
            || nearest <= 0.
        {
            return None;
        }
        let mut hit = GeometryHit::default();
        (unsafe {
            mt_native_pick_hit(
                self.0.as_ptr(),
                origin.as_ptr(),
                direction.as_ptr(),
                nearest.min(1e30),
                &mut hit,
            )
        } != 0)
            .then_some(hit)
    }
    /// Direction is deliberately unnormalized: inverse transforms preserve world t.
    pub fn intersect(&self, origin: [f32; 3], direction: [f32; 3], nearest: f32) -> Option<f32> {
        if origin.iter().chain(&direction).any(|v| !v.is_finite())
            || nearest.is_nan()
            || nearest <= 0.
        {
            return None;
        }
        let limit = nearest.min(1e30);
        let t = unsafe {
            mt_native_pick_query(self.0.as_ptr(), origin.as_ptr(), direction.as_ptr(), limit)
        };
        (t > 0. && t < limit).then_some(t)
    }
}
impl Drop for PickBvh {
    fn drop(&mut self) {
        unsafe { mt_native_pick_destroy(self.0.as_ptr()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn immutable_tree_owns_inputs_and_supports_queries_after_build() {
        let tree = {
            let positions = [0., 0., 0., 1., 0., 0., 0., 1., 0.];
            std::sync::Arc::new(PickBvh::new(&positions, &[0, 1, 2]).unwrap())
        };
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let tree = tree.clone();
                scope.spawn(move || {
                    for _ in 0..100 {
                        let hit = tree
                            .intersect_hit([0.25, 0.25, 1.], [0., 0., -1.], 10.)
                            .unwrap();
                        assert_eq!((hit.distance, hit.primitive), (1., 0));
                        assert_eq!((hit.u, hit.v), (0.25, 0.25));
                        assert!(tree.intersect([2., 2., 1.], [0., 0., -1.], 10.).is_none());
                    }
                });
            }
        });
    }
}
