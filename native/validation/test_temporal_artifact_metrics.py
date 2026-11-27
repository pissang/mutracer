"""Small deterministic controls for the motion and artifact measurements."""

import unittest

import numpy as np

from temporal_artifact_metrics import ForegroundTrails, QuickMetrics, ReferenceMetrics, Warp, tap_switches


class MetricTests(unittest.TestCase):
    def setUp(self):
        self.shape = (24, 48)
        self.grid = np.indices(self.shape, dtype=np.float32)
        self.ids = np.ones((*self.shape, 4), dtype=np.uint32)
        self.motion = np.zeros((*self.shape, 4), dtype=np.float32)
        self.motion[..., 3] = 3
        self.window = np.zeros((*self.shape, 12), dtype=np.uint32)

    def frame(self, code):
        result = np.zeros((*self.shape, 3), dtype=np.float32)
        result[..., 0] = code
        return result

    def test_fractional_motion_excludes_occlusion(self):
        previous = self.ids.copy()
        previous[:, :4, 1] = 2
        self.motion[..., 0] = -.75
        warp = Warp(self.grid, self.motion, self.ids, previous)
        signal = self.frame(self.grid[1])
        self.assertFalse(warp.valid[:, 4].any())
        self.assertTrue(warp.valid[:, 5:].all())
        np.testing.assert_allclose(warp.sample(signal)[:, 5:, 0], signal[:, 5:, 0] - .75)

    def test_visibility_follows_the_surface_and_resets_on_occlusion(self):
        self.motion[..., 0] = 1
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        detector = QuickMetrics()
        signal = self.frame(5)
        for index in range(8):
            m = detector.push(signal, signal, self.window, warp if index else None)
        self.assertTrue(m.established[:, :-4].all())
        self.assertFalse(m.established[:, -4:].any())
        self.assertTrue(m.valid[:, -4:-1].all())

        previous = self.ids.copy()
        previous[:, 17, 1] = 2
        occlusion = Warp(self.grid, self.motion, self.ids, previous)
        m = detector.push(signal, signal, self.window, occlusion)
        self.assertFalse(m.established[:, 16].any())
        m = detector.push(signal, signal, self.window, warp)
        self.assertTrue(m.valid[:, 15].all())
        self.assertFalse(m.established[:, 15].any())
        detector.reset()
        m = detector.push(signal, signal, self.window, None)
        self.assertFalse(m.established.any())

    def test_stationary_baseline_noise_tracks_the_oidn_arm(self):
        detector = QuickMetrics()
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        for index in range(10):
            spatial = self.frame(50 + (-1) ** index * 12)
            m = detector.push(self.frame(50), spatial, self.window, warp if index else None)
        self.assertTrue(m.established.all())
        self.assertTrue((m.oidn_noise > 20).all())
        self.assertFalse(m.moving.any())
        self.assertFalse(m.flicker.any())
        detector.reset()
        m = detector.push(self.frame(50), spatial, self.window, None)
        self.assertFalse(m.oidn_noise.any())

    def test_zero_history_matches_the_spatial_flicker_baseline(self):
        quick = QuickMetrics()
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        for i, level in enumerate([32, 12, 32, 12]):
            signal = self.frame(level)
            m = quick.push(signal, signal, self.window, warp if i else None)
        np.testing.assert_array_equal(m.flicker, m.oidn_change)
        self.assertGreater(m.flicker.min(), 19)
        self.assertFalse(m.ghost.any())

    def test_switches_compare_the_same_eligible_signed_offsets(self):
        current = self.window.copy()
        current[..., :2] = 0b111
        previous = current.copy()
        current[..., 4] = 0b101
        current[..., 2] = 0b001
        previous[..., 0] = 0b011
        previous[..., 4] = 0b010
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        switches, compared, flips, _ = tap_switches(warp, current, previous)
        self.assertTrue(compared.all())
        np.testing.assert_allclose(switches, 2 / 5)
        _, _, _, reversals = tap_switches(warp, previous, current, flips)
        self.assertTrue(reversals.all())

    def test_reference_separates_trails_from_an_oscillating_error(self):
        quick, fine = QuickMetrics(), ReferenceMetrics()
        no_history = QuickMetrics(history=False)
        self.motion[..., 0] = -1
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        for i in range(6):
            edge = 15 + 2 * i
            baseline = self.frame(10)
            baseline[:, edge:edge + 8, 0] = 65
            temporal = baseline.copy()
            temporal[:, edge - 6:edge, 0] += 20
            temporal[:, 4:10, 0] += 10 * (-1) ** i
            m = quick.push(temporal, baseline, self.window, warp if i else None)
            exact = fine.push(temporal, baseline, baseline, warp if i else None)
            no_history_result = no_history.push(temporal, baseline, self.window, warp if i else None)
        self.assertGreater(m.ghost[10, edge - 3], 10)
        self.assertGreater(m.corroborated_ghost[10, edge - 3], 10)
        self.assertFalse(no_history_result.ghost.any())
        high, low, valid, _ = exact
        self.assertTrue(valid[10, edge - 3])
        self.assertGreater(high[10, 8], 5)
        self.assertGreater(low[10, edge - 2], 3)
        self.assertEqual(low[10, 8], 0)

    def test_foreground_trail_identifies_the_old_bright_object(self):
        detector = ForegroundTrails()
        self.motion[..., 0] = -1
        previous = None
        for i in range(7):
            edge = 9 + 3 * i
            ids = self.ids.copy()
            ids[:, edge:edge + 8, 0] = 2
            spatial = self.frame(20)
            spatial[:, edge:edge + 8, 0] = 230
            temporal = spatial.copy()
            temporal[:, edge - 9:edge, 0] += 45
            warp = None if previous is None else Warp(self.grid, self.motion, ids, previous)
            score, sources = detector.push(temporal, spatial, ids, warp)
            previous = ids
        self.assertGreater(score[12, edge - 6], 8)
        self.assertEqual(sources[12, edge - 6], 2)
        self.assertEqual(score[12, edge + 2], 0)
        detector.reset()
        score, _ = detector.push(spatial, spatial, ids, None)
        self.assertFalse(score.any())

    def test_static_bias_is_not_a_trail(self):
        quick, fine = QuickMetrics(), ReferenceMetrics()
        warp = Warp(self.grid, self.motion, self.ids, self.ids)
        for i in range(6):
            temporal = self.frame(45)
            spatial = self.frame(30)
            m = quick.push(temporal, spatial, self.window, warp if i else None)
            exact = fine.push(temporal, spatial, temporal, warp if i else None)
        self.assertFalse(m.flicker.any())
        self.assertFalse(m.ghost.any())
        self.assertFalse(exact[0].any())
        self.assertFalse(exact[1].any())


if __name__ == '__main__':
    unittest.main()
