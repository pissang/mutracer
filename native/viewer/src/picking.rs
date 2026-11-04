//! Viewport queries share the committed renderer's GPU acceleration structures.
use mutracer_native_probe::api::{self, SurfacePick};
use std::sync::mpsc;

pub enum Reply {
    Focus(Option<f32>),
    Selection(SurfacePick),
}
#[derive(Default)]
pub struct Picker {
    revision: u64,
    queued: Option<(u64, [f32; 2], bool)>,
    pending: Option<(u64, u64, mpsc::Receiver<Result<Option<Reply>, String>>)>,
}
impl Picker {
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn request(&mut self, generation: u64, uv: [f32; 2], focus: bool) {
        self.revision += 1;
        self.queued = Some((generation, uv, focus));
    }
    pub fn dispatch(
        &mut self,
        engine: &api::Engine,
        generation: u64,
        ready: bool,
        ctx: &eframe::egui::Context,
    ) {
        let Some((requested, uv, focus)) = self.queued else {
            return;
        };
        if requested != generation {
            self.queued = None;
            return;
        }
        if !ready || self.pending.is_some() {
            return;
        }
        self.queued = None;
        let engine = engine.clone();
        let ctx = ctx.clone();
        let (send, receive) = mpsc::channel();
        self.pending = Some((generation, self.revision, receive));
        std::thread::spawn(move || {
            let result = if focus {
                engine
                    .read_depth_samples(api::DepthSampleArea {
                        x: uv[0],
                        y: uv[1],
                        size: 0.,
                    })
                    .map(|samples| samples.map(|v| Reply::Focus((v[0] > 0.).then_some(v[0]))))
            } else {
                engine.pick_surface(uv[0], uv[1]).map(|hit| match hit {
                    SurfacePick::Unavailable => None,
                    hit => Some(Reply::Selection(hit)),
                })
            }
            .map_err(|error| error.to_string());
            let _ = send.send(result);
            ctx.request_repaint();
        });
    }
    pub fn poll(&mut self, generation: u64) -> Option<Result<Reply, String>> {
        let (requested, revision, receive) = self.pending.as_ref()?;
        match receive.try_recv() {
            Ok(result) => {
                let current = *requested == generation && *revision == self.revision;
                self.pending = None;
                if current { result.transpose() } else { None }
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                self.pending = None;
                None
            }
            Err(mpsc::TryRecvError::Empty) => None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_camera_or_scene_replies_are_discarded() {
        for current in [5, 6] {
            let (send, receive) = mpsc::channel();
            let mut picker = Picker {
                pending: Some((5, 0, receive)),
                ..Default::default()
            };
            send.send(Ok(Some(Reply::Focus(Some(4.))))).unwrap();
            assert_eq!(picker.poll(current).is_some(), current == 5);
            assert!(picker.poll(current).is_none());
        }
    }
    #[test]
    fn a_new_click_replaces_an_in_flight_click() {
        let (send, receive) = mpsc::channel();
        let mut picker = Picker {
            pending: Some((5, 0, receive)),
            ..Default::default()
        };
        picker.request(5, [0.8, 0.2], false);
        send.send(Ok(Some(Reply::Focus(Some(4.))))).unwrap();
        assert!(picker.poll(5).is_none());
        assert_eq!(picker.queued, Some((5, [0.8, 0.2], false)));
    }
}
