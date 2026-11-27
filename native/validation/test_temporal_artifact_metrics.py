"""Small deterministic controls for the motion and artifact measurements."""

import unittest

import numpy as np

from temporal_artifact_metrics import QuickMetrics, ReferenceMetrics, Warp, tap_switches


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
        self.assertGreater(m.ghost[10, edge - 3], 10)
        high, low, valid, _ = exact
        self.assertTrue(valid[10, edge - 3])
        self.assertGreater(high[10, 8], 5)
        self.assertGreater(low[10, edge - 2], 3)
        self.assertEqual(low[10, 8], 0)

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
