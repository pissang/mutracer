"""Behavior checks for grouping and reference evidence in the scan report."""

import importlib.util
from pathlib import Path
import sys
import unittest

import numpy as np


spec = importlib.util.spec_from_file_location('artifact_scan', Path(__file__).with_name('temporal-artifact-scan.py'))
scan = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scan
spec.loader.exec_module(scan)


class ReportTests(unittest.TestCase):
    def test_consecutive_bridge_joins_projected_tracks(self):
        report = scan.Report({}, [], {})
        key = ('ghost', 1, 0, 2, 'Cup', 'Glass', (), None, None)
        box = [0, 0, 24, 8]
        reasons = np.zeros(len(scan.REASONS))
        weights = np.array([2., 1.])

        def observe(frame, footprint, landing):
            report.track(frame, key, box, set(footprint), set(landing), 6, 2.,
                         reasons, weights, 0., 0., 0.)

        for frame in range(1, 4):
            observe(frame, [0], [0])
            observe(frame, [2], [2])
            report.advance(frame)
        observe(4, [0, 1, 2], [0, 1, 2])
        report.advance(4)
        issues = report.complete()
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]['frames'], [1, 4])
        self.assertEqual(issues[0]['pixelFrames'], 42)

    def test_boxes_without_shared_tiles_remain_separate(self):
        report = scan.Report({}, [], {})
        key = ('flicker', 1, 0, 2, 'Blind', 'Enamel', (), None, None)
        reasons = np.zeros(len(scan.REASONS))
        weights = np.ones(2)
        for frame in range(1, 4):
            for tile in (0, 2):
                report.track(frame, key, [0, 0, 24, 24], {tile}, {tile}, 6, 1.,
                             reasons, weights, 0., 0., 0.)
            report.advance(frame)
        self.assertEqual(len(report.complete()), 2)

    def test_limited_review_prefers_repeated_reference_support(self):
        noisy = {'type': 'ghost', 'object': {'id': 1, 'instance': 0}, 'severity': 10,
                 'referenceEvidence': {'supportingFrames': [10], 'measuredFrames': [10, 11, 12]}}
        supported = {'type': 'ghost', 'object': {'id': 2, 'instance': 0}, 'severity': 5,
                     'referenceEvidence': {'supportingFrames': [10, 11, 12], 'measuredFrames': [10, 11, 12]}}
        self.assertEqual(scan.review_list([noisy, supported], 1), [supported])
        self.assertEqual(scan.review_list([noisy, supported], 0), [noisy, supported])

    def test_reference_support_requires_the_issue_identity(self):
        issue = {'type': 'ghost', 'frameBoxes': [[10, 0, 0, 8, 8], [11, 0, 0, 8, 8]],
                 'object': {'id': 1, 'instance': 0}, 'material': {'id': 2}}
        review = scan.ReferenceReview({'issues': [issue], 'authoredChanges': []})
        ids = np.zeros((8, 8, 4), dtype=np.uint32)
        ids[..., 0], ids[..., 2] = 1, 2
        valid = np.ones((8, 8), dtype=bool)
        events = np.zeros_like(valid)
        trail = np.full(valid.shape, 6.)
        exact = trail, trail, valid, trail
        review.add(10, ids, exact, events, scan.Thresholds())
        ids[..., 1] = 1
        review.add(11, ids, exact, events, scan.Thresholds())
        self.assertEqual(issue['referenceEvidence'], {'measuredFrames': [10], 'supportingFrames': [10]})


if __name__ == '__main__':
    unittest.main()
