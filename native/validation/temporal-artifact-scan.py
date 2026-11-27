#!/usr/bin/env python3
"""Capture and report temporal flicker, moving trails and unstable history decisions."""

import argparse
from collections import defaultdict
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from time import monotonic

import numpy as np
from PIL import Image
from scipy import ndimage

from temporal_artifact_metrics import ForegroundTrails, QuickMetrics, ReferenceMetrics, Warp, display_signal


ROOT = Path(__file__).resolve().parents[2]
TILE = 8
MIN_PIXELS = 6
MIN_FRAMES = 3
DEFAULT_ISSUE_LIMIT = 40
REFERENCE_SAMPLES = (64, 128, 256)
TYPES = ('flicker', 'ghost')
REASONS = (
    'surface correspondence', 'surface geometry', 'missing radiance',
    'roughness-limited radius', 'local lighting', 'bright foreground silhouette',
    'reflection cone transition', 'curvature trust', 'virtual correspondence',
    'reflection silhouette', 'glossy dielectric view change', 'partial or recovered coverage',
    'reflected local lighting',
)
REFLECTION_CHECKS = frozenset(REASONS[i] for i in (6, 7, 8, 9, 10, 12))


@dataclass(frozen=True)
class Thresholds:
    flicker: float = 2.0
    oidn_ratio: float = .65
    ghost: float = 3.0
    foreground_trail: float = 8.0
    switch: float = .2
    reference_flicker: float = 2.0
    reference_ghost: float = 3.0

    def check(self):
        if any(not math.isfinite(value) or value <= 0 for value in asdict(self).values()):
            raise ValueError('Thresholds must be finite and positive.')
        if self.switch > 1:
            raise ValueError('The switch threshold is a fraction.')


def frame_range(value):
    if not re.fullmatch(r'\d+(?:-\d+)?', value):
        raise argparse.ArgumentTypeError('Use an inclusive frame range N or FIRST-LAST.')
    edges = list(map(int, value.split('-')))
    if edges[0] > edges[-1]:
        raise argparse.ArgumentTypeError('The first frame must not exceed the last.')
    return edges[0], edges[-1]


def range_flag(edges):
    return f'{edges[0]}-{edges[1]}'


def dump_json(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')


def frame_path(folder, index, extension):
    return folder / f'frame-{index:04}.{extension}'


def image(folder, index, size):
    with Image.open(frame_path(folder, index, 'png')) as png:
        if png.size != size:
            raise ValueError(f'Frame {index} in {folder} has size {png.size}, expected {size}.')
        return np.array(png.convert('RGB'))


def sidecar(folder, index, shape, ext, dtype):
    path = frame_path(folder, index, ext)
    return np.fromfile(path, dtype=dtype).reshape(shape)


def load_metadata(folder):
    return json.loads((folder / 'capture.json').read_text())


def checkout_settings(temporal, spatial):
    keys = ('size', 'spp', 'seed', 'seedValue', 'tracer', 'sampleSequence',
            'sampleSequenceOffset', 'experimentalSequenceStride', 'display', 'render')
    if (spatial['saved'] != temporal['saved'] or spatial['fps'] != temporal['fps']
            or any(spatial['settings'].get(k) != temporal['settings'].get(k) for k in keys)):
        raise ValueError('Paired captures must use the same frames and render settings.')
    if not temporal['scan'].get('denoiserWeights'):
        raise ValueError('The temporal capture must use cleanAuxLarge weights.')
    if temporal['settings']['denoise'] != 'temporal' or spatial['settings']['denoise'] != 'cleanAuxLarge':
        raise ValueError('Use temporal and cleanAuxLarge captures.')
    first, last = temporal['saved'][0]
    # A capture can replay a longer history context. Confirm that selected poses
    # still agree when separately captured.
    for frame in range(first, last + 1):
        if temporal['cameras'][str(frame)] != spatial['cameras'][str(frame)]:
            raise ValueError(f'Paired camera poses differ at frame {frame}.')
    return first, last


def validated_events(events, size):
    w, h = size
    for event in events:
        if (not isinstance(event.get('label'), str) or type(event.get('first')) is not int
                or type(event.get('last')) is not int or not 0 <= event['first'] <= event['last']):
            raise ValueError('Each artifact event needs a label and an inclusive first and last frame.')
        if 'box' in event:
            x0, y0, x1, y1 = event['box']
            if not 0 <= x0 < x1 <= w or not 0 <= y0 < y1 <= h:
                raise ValueError('An event box must fit within the output in pixels.')
        if 'objects' in event and (not isinstance(event['objects'], list) or
                                   any(not isinstance(name, str) for name in event['objects'])):
            raise ValueError('Event objects must be a list of mesh names.')
    return events


def box_intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def matches_event(event, frame, box, name):
    return (event['first'] <= frame <= event['last']
            and ('objects' not in event or name in event['objects'])
            and ('box' not in event or box_intersection(box, event['box'])))


def count_tiles(mask):
    h, w = mask.shape
    padded = np.pad(mask, ((0, -h % TILE), (0, -w % TILE)))
    return padded.reshape(padded.shape[0] // TILE, TILE, padded.shape[1] // TILE, TILE).sum((1, 3))


def detector_scores(m, thresholds, scale=1., ratio=None, stage='corroboration'):
    ratio = thresholds.oidn_ratio if ratio is None else ratio
    flicker_floor = np.maximum(thresholds.flicker * scale, ratio * m.oidn_change)
    ghost_floor = thresholds.ghost * scale
    ghost = m.ghost
    eligible = m.valid if stage == 'baseline' else m.established
    if stage in ('noise', 'corroboration'):
        # On a moving surface, OIDN innovations also include legitimate view
        # changes. Use them as a stronger noise control on stationary surfaces.
        noise_floor = np.where(m.moving, .65 * m.oidn_noise,
                               np.maximum(2.8 * m.oidn_noise, 1.35 * m.oidn_change))
        flicker_floor = np.maximum(flicker_floor, noise_floor)
    if stage == 'corroboration':
        # A hard veto loses observable trails when the optical feature also
        # moves along the surface path. Reduce confidence without that veto.
        ghost = .75 * m.ghost + .25 * m.corroborated_ghost
    return np.where(eligible, m.flicker / flicker_floor, 0), np.where(eligible, ghost / ghost_floor, 0)


def confusion(found, truth):
    return np.array((np.count_nonzero(found & truth), np.count_nonzero(found & ~truth),
                     np.count_nonzero(~found & truth)), dtype=np.int64)


def summarize(counts):
    tp, fp, fn = map(int, counts)
    return {'tp': tp, 'fp': fp, 'fn': fn,
            'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None,
            'f1': 2 * tp / (2 * tp + fp + fn) if tp + fn else None}


class Calibration:
    def __init__(self, thresholds):
        self.candidates = [(scale, ratio) for scale in (.75, 1., 1.25, 1.5)
                           for ratio in sorted(set((.65, .8, .95, thresholds.oidn_ratio)))]
        self.thresholds = thresholds
        self.tallies = {pair: np.zeros((len(TYPES), 3), dtype=np.int64) for pair in self.candidates}
        self.stages = {stage: np.zeros((len(TYPES), 3), dtype=np.int64)
                       for stage in ('baseline', 'visibility', 'noise', 'corroboration')}
        self.frames = []
        self.reference_error = []

    def add(self, frame, m, reference, events):
        t = self.thresholds
        high, ghost_error, valid, low = reference
        valid = valid & ~events
        flicker_truth = count_tiles(valid & (high >= t.reference_flicker)) >= MIN_PIXELS
        ghost_truth = count_tiles(valid & (ghost_error >= t.reference_ghost)) >= MIN_PIXELS
        self.reference_error.append({
            'frame': frame, 'validPixels': int(valid.sum()),
            'highFrequencyRms': float(np.sqrt(np.mean(high[valid] ** 2))) if valid.any() else None,
            'lowFrequencyRms': float(np.sqrt(np.mean(low[valid] ** 2))) if valid.any() else None,
        })
        self.frames.append(frame)
        def tally(scores):
            return np.stack([confusion(count_tiles(valid & (score >= 1)) >= MIN_PIXELS, truth)
                             for score, truth in zip(scores, (flicker_truth, ghost_truth))])

        defaults = Thresholds(oidn_ratio=.8)
        for stage, counts in self.stages.items():
            counts += tally(detector_scores(m, defaults, stage=stage))
        for (scale, ratio), counts in self.tallies.items():
            counts += tally(detector_scores(m, t, scale, ratio))

    def report(self):
        def metrics(counts):
            return {kind: summarize(row) for kind, row in zip(TYPES, counts)}

        rows = [{'scale': scale, 'oidn_ratio': ratio, **metrics(counts)}
                for (scale, ratio), counts in self.tallies.items()]
        recommendation = {}
        for kind in TYPES:
            eligible = [row for row in rows if row[kind]['f1'] is not None]
            if eligible:
                best = max(eligible, key=lambda row: (row[kind]['f1'], -abs(row['scale'] - 1),
                                                      -abs(row['oidn_ratio'] - self.thresholds.oidn_ratio)))
                recommendation[kind] = {'amplitude': best['scale'] * getattr(self.thresholds, kind)}
                if kind == 'flicker':
                    recommendation[kind]['oidn_ratio'] = best['oidn_ratio']
        return {'frames': self.frames, 'cellSize': TILE, 'minimumPixels': MIN_PIXELS,
                'thresholds': asdict(self.thresholds),
                'comparison': 'Per-frame tile overlap on valid five-frame tracks. Authored events excluded.',
                'referenceError': self.reference_error, 'rows': rows, 'recommendation': recommendation,
                'ablations': {stage: metrics(counts) for stage, counts in self.stages.items()}}


class Report:
    def __init__(self, scan, events, materials):
        self.active = defaultdict(list)
        self.finished = []
        self.names = scan.get('aovNames', {})
        self.materials = materials
        self.events = events

    def append(self, frame, kind, score, pixels, ids, window, sparkle, measurements, warp,
               foreground=None):
        minimum = MIN_PIXELS if foreground is None else 3
        ys, xs = np.nonzero(pixels)
        if xs.size < minimum:
            return
        tile_columns = (ids.shape[1] + TILE - 1) // TILE

        def occupied_tiles(rows, columns):
            return frozenset(np.unique((rows // TILE) * tile_columns + columns // TILE).tolist())

        active_keys = ids[ys, xs, :3]
        if foreground is not None:
            active_keys = np.column_stack((active_keys, foreground[ys, xs]))
        keys, inverse = np.unique(active_keys, axis=0, return_inverse=True)
        names = self.names.get(str(frame), {})
        material_slots = self.materials.get(str(frame), {})

        def name_for(key, category):
            entries = names.get(category, [])
            return entries[key - 1] if 0 < key <= len(entries) else None

        for label, key in enumerate(keys):
            select = inverse == label
            if np.count_nonzero(select) < minimum:
                continue
            y, x = ys[select], xs[select]
            y0, x0 = (y.min() // TILE) * TILE, (x.min() // TILE) * TILE
            local_y, local_x = (y - y0) // TILE, (x - x0) // TILE
            tiles = np.zeros((local_y.max() + 1, local_x.max() + 1), dtype=np.uint16)
            np.add.at(tiles, (local_y, local_x), 1)
            components, _ = ndimage.label(tiles >= minimum, np.ones((3, 3)))
            component_ids = components[local_y, local_x]
            object_id, instance, material_id = map(int, key[:3])
            source = int(key[3]) if foreground is not None else None
            source_name = name_for(source, 'objects') if source is not None else None
            name = name_for(object_id, 'objects')
            mat = name_for(material_id, 'materials')
            if mat is None and material_id in material_slots.get(name, ()):
                mat = f'Material on {name}'
            for component in np.unique(component_ids):
                if component == 0:
                    continue
                selected = component_ids == component
                yy, xx = y[selected], x[selected]
                box = [int(xx.min()), int(yy.min()), int(xx.max()) + 1, int(yy.max()) + 1]
                events = tuple(event['label'] for event in self.events if
                               matches_event(event, frame, box, name))
                landed_y, landed_x = warp.nearest[0][yy, xx], warp.nearest[1][yy, xx]
                landing = occupied_tiles(landed_y, landed_x)
                footprint = occupied_tiles(yy, xx)
                identity = (kind, object_id, instance, material_id, name, mat, events, source, source_name)
                weights = window[yy, xx, 10:12].copy().view('<f4')
                reason_counts = window[yy, xx, 6:10].copy().view(np.uint8)[:, :len(REASONS)].sum(0)
                corrections = vetoes = 0.
                if sparkle is not None:
                    correction, support, strength, _ = sparkle[yy, xx].T
                    corrections = float((np.abs(correction) >= .5).mean())
                    vetoes = float(((support >= .5) & (strength >= .03)).mean())
                self.track(frame, identity, box, footprint, landing, yy.size,
                           float(np.percentile(score[yy, xx], 90)), reason_counts, weights.mean(0),
                           corrections, vetoes, float(measurements.switch[yy, xx].mean()))

    def track(self, frame, identity, box, footprint, landing, area, peak, reasons, weights, sparkle,
              vetoes, switches):
        def overlap(region):
            if region['last'] != frame - 1:
                return 0
            previous = region['lastTiles']
            shared = len(landing & previous)
            return shared if shared >= .25 * math.sqrt(len(landing) * len(previous)) else 0

        active = self.active[identity]
        overlaps = [(overlap(region), region) for region in active]
        matches = sorted((pair for pair in overlaps if pair[0]), key=lambda pair: -pair[0])
        if matches:
            region = matches[0][1]
            for _, other in matches[1:]:
                # Join tracks when a component bridges their projected boxes.
                self.merge_tracks(region, other)
            if len(matches) > 1:
                merged = {id(other) for _, other in matches[1:]}
                self.active[identity] = [item for item in active if id(item) not in merged]
        else:
            region = {'identity': identity, 'first': frame, 'last': frame, 'boxes': [],
                      'pixelFrames': 0, 'peak': 0., 'peakFrame': frame, 'reasons': np.zeros(len(REASONS)),
                      'weights': np.zeros(2), 'sparkle': 0., 'sparkleVetoes': 0., 'switches': 0.}
            active.append(region)
        region['last'] = frame
        region['lastTiles'] = footprint
        region['boxes'].append([frame, *box])
        if peak > region['peak']:
            region['peak'], region['peakFrame'] = peak, frame
        region['pixelFrames'] += area
        region['reasons'] += reasons
        region['weights'] += weights * area
        region['sparkle'] += sparkle * area
        region['sparkleVetoes'] += vetoes * area
        region['switches'] += switches * area

    @staticmethod
    def merge_tracks(region, other):
        region['first'] = min(region['first'], other['first'])
        region['boxes'].extend(other['boxes'])
        if other['peak'] > region['peak']:
            region['peak'], region['peakFrame'] = other['peak'], other['peakFrame']
        for field in ('pixelFrames', 'reasons', 'weights', 'sparkle', 'sparkleVetoes', 'switches'):
            region[field] += other[field]

    def advance(self, frame):
        remaining = defaultdict(list)
        for identity, regions in self.active.items():
            for region in regions:
                if frame == region['last']:
                    remaining[identity].append(region)
                elif len({box[0] for box in region['boxes']}) >= MIN_FRAMES:
                    self.finished.append(region)
        self.active = remaining

    def complete(self):
        self.advance(math.inf)
        result = []
        for region in self.finished:
            kind, obj, instance, mat, name, material, events, source, source_name = region['identity']
            frames = sorted(region['boxes'])
            pixel_frames = region['pixelFrames']
            bounds = [min(x[1] for x in frames), min(x[2] for x in frames),
                      max(x[3] for x in frames), max(x[4] for x in frames)]
            ranked = sorted(zip(REASONS, region['reasons']), key=lambda item: -item[1])
            reasons = [{'check': check, 'tapCount': int(value)} for check, value in ranked if value]
            weights = region['weights'] / pixel_frames
            checks = reasons
            if weights[0] <= 1.25 < weights[1]:
                # On nearly mirror surfaces the short surface radius can be
                # constant while reflected history changes substantially.
                checks = [reason for reason in reasons if reason['check'] in REFLECTION_CHECKS] or reasons
            check = 'no dominant restriction recorded'
            if checks:
                check = checks[0]['check']
            elif region['sparkle'] + region['sparkleVetoes'] > .1 * pixel_frames:
                check = 'sparkle correction or glint veto'
            elif weights[0] <= 1.001:
                check = 'history unavailable'
            result.append({
                'type': kind, 'frames': [region['first'], region['last']], 'box': bounds,
                'frameBoxes': frames, 'pixelFrames': pixel_frames,
                'object': {'id': obj, 'instance': instance,
                           'name': name or ('Background' if obj == 0 else f'Unnamed mesh {obj}')},
                'material': {'id': mat, 'name': material or f'Unnamed material {mat}'},
                'events': list(events),
                'severity': round(region['peak'] * math.log2(1 + pixel_frames / TILE ** 2), 3),
                'peakSignal': round(region['peak'], 3), 'peakFrame': region['peakFrame'], 'primaryCheck': check,
                'tapReasons': reasons,
                **({'priorForeground': {'id': source, 'name': source_name or f'Unnamed mesh {source}'}} if source is not None else {}),
                'meanWindowWeight': weights.round(3).tolist(),
                'sparkleCorrectedFraction': round(region['sparkle'] / pixel_frames, 4),
                'sparkleVetoFraction': round(region['sparkleVetoes'] / pixel_frames, 4),
                'meanTapSwitchFraction': round(region['switches'] / pixel_frames, 4),
            })
        return sorted(result, key=lambda issue: -issue['severity'])


def review_list(issues, limit):
    if not limit or len(issues) <= limit:
        return issues
    # A long surface can produce several separate tracks. Reserve review
    # capacity for different surfaces and rank repeated reference support first.
    def reference_supported(issue):
        evidence = issue.get('referenceEvidence', {})
        supporting = len(evidence.get('supportingFrames', ()))
        measured = len(evidence.get('measuredFrames', ()))
        return supporting >= MIN_FRAMES and supporting * 2 >= measured

    seen = defaultdict(int)
    ranked = []
    for issue in sorted(issues, key=reference_supported, reverse=True):
        key = issue['type'], issue['object']['id'], issue['object']['instance']
        priority = issue['severity'] / (1 + seen[key])
        ranked.append(((reference_supported(issue), priority), issue))
        seen[key] += 1
    selected = {id(issue) for _, issue in sorted(ranked, key=lambda item: item[0], reverse=True)[:limit]}
    return [issue for issue in issues if id(issue) in selected]


class ReferenceReview:
    def __init__(self, report):
        self.by_frame = defaultdict(list)
        self.entries = report['issues'] + report['authoredChanges']
        for item in self.entries:
            boxes = defaultdict(list)
            for frame, *box in item['frameBoxes']:
                boxes[frame].append(box)
            item['referenceEvidence'] = {'measuredFrames': [], 'supportingFrames': []}
            for frame, frame_boxes in boxes.items():
                self.by_frame[frame].append((item, frame_boxes))

    def add(self, frame, ids, reference, events, thresholds):
        high, trail, valid, _ = reference
        valid = valid & ~events
        evidence = {'flicker': high >= thresholds.reference_flicker,
                    'ghost': trail >= thresholds.reference_ghost}
        for item, boxes in self.by_frame.get(frame, ()):
            identity = (item['object']['id'], item['object']['instance'], item['material']['id'])
            measured = supported = False
            positive = evidence.get(item['type'])
            if positive is None:
                continue
            for x0, y0, x1, y1 in boxes:
                rows = np.s_[y0:y1, x0:x1]
                surface = valid[rows] & np.all(ids[rows][..., :3] == identity, axis=-1)
                measured |= surface.sum() >= MIN_PIXELS
                supported |= (surface & positive[rows]).sum() >= MIN_PIXELS
            result = item['referenceEvidence']
            if measured:
                result['measuredFrames'].append(frame)
            if supported:
                result['supportingFrames'].append(frame)


class Video:
    @staticmethod
    def command():
        return os.environ.get('MUTRACER_SCAN_FFMPEG', 'ffmpeg')

    @staticmethod
    def check():
        try:
            subprocess.run([Video.command(), '-hide_banner', '-loglevel', 'error',
                            '-f', 'lavfi', '-i', 'color=size=2x2', '-frames:v', '1',
                            '-c:v', 'libx264', '-f', 'null', '-'], check=True)
        except (OSError, subprocess.CalledProcessError) as error:
            raise RuntimeError('Set MUTRACER_SCAN_FFMPEG to a working FFmpeg with libx264.') from error

    def __init__(self, path, size, fps):
        w, h = size
        self.process = subprocess.Popen([
            self.command(), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{2*w}x{h}', '-r', str(fps),
            '-i', '-', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264',
            '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(path),
        ], stdin=subprocess.PIPE)

    def frame(self, rgb, flicker, ghost):
        def overlay(score, tint):
            alpha = np.minimum(.8, np.maximum(0, score - .75) * .4)[..., None]
            return (rgb * (1 - alpha) + np.array(tint, np.float32) * alpha).astype(np.uint8)

        self.process.stdin.write(np.concatenate((overlay(flicker, (255, 52, 30)),
                                                overlay(ghost, (35, 180, 255))), axis=1).tobytes())

    def finish(self):
        self.process.stdin.close()
        if self.process.wait() != 0:
            raise RuntimeError('FFmpeg could not encode the heatmap video.')

    def abort(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()


def write_report(out, result):
    dump_json(out / 'issues.json', result)
    lines = ['# Temporal artifact scan', '',
             f"Frames {result['frames'][0]}–{result['frames'][1]} at {result['fps']} fps.",
             '', 'Coordinates are top-left pixel bounds with exclusive right and bottom edges.', '']
    if result['heatmaps']:
        lines.extend(['The heatmap video shows flicker on the left and trail candidates on the right.', ''])
    for title, key in [('Review issues', 'issues'), ('Overlapping authored changes', 'authoredChanges')]:
        lines.extend([f'## {title}', ''])
        group_count = result.get('issueGroups', {}).get(key, len(result[key]))
        if group_count > len(result[key]):
            lines.extend([f'Showing {len(result[key])} of {group_count} qualifying groups.', ''])
        if not result[key]:
            lines.extend(['None.', ''])
            continue
        columns = ['Severity', 'Type', 'Frames', 'Bounds', 'Object', 'Material', 'Main window evidence']
        review = any('referenceEvidence' in row for row in result[key])
        if review:
            columns.append('Reference support')
        lines.append('| ' + ' | '.join(columns) + ' |')
        lines.append('| ---: | ' + ' | '.join(['---'] * (len(columns) - 1)) + ' |')
        for item in result[key]:
            obj, mat = item['object'], item['material']
            obj_name, mat_name = obj['name'], mat['name']
            frame_text = '–'.join(map(str, item['frames']))
            check = item['primaryCheck']
            if 'priorForeground' in item:
                source = item['priorForeground']
                source_name = source['name']
                check += f" · Prior foreground {source_name}"
            if item['events']:
                check += ' · ' + ', '.join(item['events'])
            values = [item['severity'], item['type'], frame_text, ', '.join(map(str, item['box'])),
                      obj_name, mat_name, check]
            if review:
                evidence = item.get('referenceEvidence', {})
                measured = len(evidence.get('measuredFrames', ()))
                supported = len(evidence.get('supportingFrames', ()))
                values.append(f'{supported}/{measured} frames' if measured else 'Unmeasured')
            lines.append('| ' + ' | '.join(str(value).replace('|', '\\|').replace('\n', ' ')
                                           for value in values) + ' |')
        lines.append('')
    cost = result['cost']
    lines.extend(['## Cost', '',
                  '| Stage | Seconds | Seconds per saved frame |',
                  '| --- | ---: | ---: |'])
    for label, values in cost.items():
        if values:
            lines.append(f"| {label} | {values['seconds']:.3f} | {values['secondsPerFrame']:.3f} |")
    if result['calibration']:
        lines.extend(['', f"{result.get('referenceSpp', 256)}-spp reference precision, recall "
                          'and threshold sweep are in `calibration.json`.'])
    (out / 'issues.md').write_text('\n'.join(lines) + '\n')


def cost(seconds, count):
    return {'seconds': seconds, 'frames': count, 'secondsPerFrame': seconds / count}


def analyze(temporal_dir, spatial_dir, out, thresholds, reference_dirs=(), reference_ranges=(),
            make_video=True, base_report=None, issue_limit=DEFAULT_ISSUE_LIMIT,
            calibration_only=False):
    temporal, spatial = load_metadata(temporal_dir), load_metadata(spatial_dir)
    first, last = checkout_settings(temporal, spatial)
    size = tuple(temporal['settings']['size'])
    w, h = size
    shape = (h, w)
    scan = temporal['scan']
    events = validated_events(scan['events'], size)
    options = temporal['settings'].get('temporal', {})
    radius = options.get('historyRadius', 16)
    has_history = bool((radius if isinstance(radius, int) else radius.get('max', 16))
                       or options.get('postRadius', 3))
    cuts = set(scan['cuts'])
    for cut in options.get('cuts', ()):
        cuts.add(cut if isinstance(cut, int) else math.ceil(cut['time'] * temporal['fps']))
    reference_sources = {}
    reference_seeds = set()
    reference_spp = None
    reference_timing = 0.
    for folder in reference_dirs:
        data = load_metadata(folder)
        ref_settings = data['settings']
        comparable = ('size', 'tracer', 'display', 'render')
        spp = ref_settings['spp']
        if (spp not in REFERENCE_SAMPLES or (reference_spp is not None and reference_spp != spp)
                or ref_settings['seed'] != 'fixed' or data['fps'] != temporal['fps']
                or any(ref_settings.get(k) != temporal['settings'].get(k) for k in comparable)):
            raise ValueError(f'Reference {folder} must use a consistent sample count '
                             f'{REFERENCE_SAMPLES}, a fixed seed and the same view settings.')
        reference_spp = spp
        reference_seeds.add(ref_settings['seedValue'])
        reference_timing += data['seconds']
        for start, stop in data['saved']:
            for index in range(start, stop + 1):
                if index in reference_sources:
                    continue
                expected = temporal['cameras'].get(str(index))
                actual = data['cameras'][str(index)]
                if expected is not None and (
                    actual['fov'] != expected['fov'] or actual['zoom'] != expected['zoom']
                    # Replaying a shot from a different start can accumulate
                    # a few float32 rounding steps in its camera basis.
                    or not np.allclose(actual['transform'], expected['transform'], rtol=0, atol=4e-6)
                ):
                    raise ValueError(f'Reference camera differs at frame {index}.')
                reference_sources[index] = folder
    evaluated = {frame for start, stop in reference_ranges for frame in range(start, stop + 1)}
    if evaluated.difference(reference_sources) or any(not first <= index <= last for index in evaluated):
        raise ValueError('Paired captures and reference must cover every requested evaluation frame.')
    grid = np.indices(shape, dtype=np.float32)
    track_issues = base_report is None and not calibration_only
    if calibration_only and not reference_sources:
        raise ValueError('Calibration requires a reference capture.')
    report = Report(scan, events, temporal.get('materials', {})) if track_issues else None
    review = ReferenceReview(base_report) if base_report is not None else None
    calibration = Calibration(thresholds) if reference_sources else None
    video = Video(out / 'heatmaps.mp4', size, temporal['fps']) if make_video else None
    quick_metrics, fine_metrics = QuickMetrics(has_history), ReferenceMetrics()
    foreground_metrics = ForegroundTrails() if track_issues and has_history else None
    started = monotonic()
    reference_cpu = 0.
    frames = (range(first, last + 1) if track_issues
              else sorted(index for index in reference_sources if first <= index <= last))
    previous_ids = None
    previous_frame = None
    global_counts = [0, 0, 0, 0, 0, 0]
    change_energy = np.zeros(2, dtype=np.float64)
    try:
        for index in frames:
            rgb = image(temporal_dir, index, size)
            signal = display_signal(rgb)
            baseline = display_signal(image(spatial_dir, index, size))
            ids = sidecar(temporal_dir, index, (*shape, 4), 'id.u32', '<u4')
            window = (sidecar(temporal_dir, index, (*shape, 12), 'window.bin', '<u4')
                      if track_issues else None)
            sparkle = (sidecar(temporal_dir, index, (*shape, 4), 'sparkle.f32', '<f4')
                       if track_issues and frame_path(temporal_dir, index, 'sparkle.f32').is_file() else None)
            if previous_frame != index - 1 or index in cuts:
                previous_ids = None
                quick_metrics.reset()
                fine_metrics.reset()
                if report is not None:
                    report.advance(math.inf)
                if foreground_metrics is not None:
                    foreground_metrics.reset()
            warp = None
            if previous_ids is not None:
                motion = sidecar(temporal_dir, index, (*shape, 4), 'motion.f32', '<f4')
                warp = Warp(grid, motion, ids, previous_ids)
            m = quick_metrics.push(signal, baseline, window, warp)
            previous_ids = ids
            previous_frame = index
            flicker_score, ghost_score = detector_scores(m, thresholds)
            foreground_score = ghost_score
            if foreground_metrics is not None:
                foreground, sources = foreground_metrics.push(signal, baseline, ids, warp)
                foreground_score = foreground / thresholds.foreground_trail
            global_counts[0] += int(m.valid.sum())
            global_counts[4] += int(m.established.sum())
            global_counts[5] += int((m.switch_comparable & (m.switch >= thresholds.switch)).sum())
            change_energy += (np.square(m.flicker, where=m.valid, out=np.zeros_like(m.flicker)).sum(dtype=np.float64),
                              np.square(m.oidn_change, where=m.valid, out=np.zeros_like(m.oidn_change)).sum(dtype=np.float64))
            global_counts[1] += int(m.switch_comparable.sum())
            global_counts[2] += int((m.switch_comparable & (m.switch > 0)).sum())
            if m.reversals is not None:
                global_counts[3] += int(m.reversals.sum())
            if warp is not None and report is not None:
                for kind, score, mask in (
                    (TYPES[0], flicker_score, flicker_score >= 1),
                    (TYPES[1], ghost_score, ghost_score >= 1),
                ):
                    report.append(index, kind, score, mask, ids, window, sparkle, m, warp)
                if foreground_metrics is not None:
                    foreground_score *= m.established
                    report.append(index, TYPES[1], foreground_score, foreground_score >= 1,
                                  ids, window, sparkle, m, warp, foreground=sources)
                report.advance(index)
            if video:
                video.frame(rgb, flicker_score * m.valid, np.maximum(ghost_score, foreground_score) * m.valid)
            if index in reference_sources:
                tick = monotonic()
                reference = display_signal(image(reference_sources[index], index, size))
                exact = fine_metrics.push(signal, baseline, reference, warp)
                if exact is not None and (not evaluated or index in evaluated):
                    exclude = np.zeros(shape, bool)
                    for event in events:
                        if not event['first'] <= index <= event['last']:
                            continue
                        box = event.get('box', [0, 0, w, h])
                        x0, y0, x1, y1 = box
                        if 'objects' not in event:
                            exclude[y0:y1, x0:x1] = True
                        else:
                            names = scan['aovNames'].get(str(index), {}).get('objects', [])
                            event_ids = [i for i, name in enumerate(names, 1) if name in event['objects']]
                            exclude[y0:y1, x0:x1] |= np.isin(ids[y0:y1, x0:x1, 0], event_ids)
                    calibration.add(index, m, exact, exclude)
                    if review is not None:
                        review.add(index, ids, exact, exclude, thresholds)
                reference_cpu += monotonic() - tick
            else:
                fine_metrics.reset()
            if (index - first + 1) % 25 == 0:
                print(f'Scanned frames {first}–{index}', flush=True)
        if video:
            video.finish()
    except BaseException:
        if video:
            video.abort()
        raise

    if calibration is not None:
        report_data = calibration.report()
        report_data['seedValue'] = temporal['settings']['seedValue']
        report_data['referenceSeedValues'] = sorted(reference_seeds)
        report_data['referenceSpp'] = reference_spp
        dump_json(out / 'calibration.json', report_data)
    if calibration_only:
        return
    if base_report is not None:
        base_report['calibration'] = 'calibration.json'
        base_report['referenceSpp'] = reference_spp
        for key in ('issues', 'authoredChanges'):
            base_report[key] = review_list(base_report[key], issue_limit)
        base_report['cost']['reference capture'] = cost(reference_timing, len(reference_sources))
        base_report['cost']['reference analysis'] = cost(monotonic() - started, len(reference_sources))
        write_report(out, base_report)
        return base_report
    issues = report.complete()
    plain = [issue for issue in issues if not issue['events']]
    authored = [issue for issue in issues if issue['events']]
    valid, comparable, switches, reversals, established, large_switches = global_counts
    count = last - first + 1
    run_info = {
        'frames': [first, last], 'fps': temporal['fps'], 'size': size, 'backend': temporal['backend'],
        'thresholds': asdict(thresholds), 'cuts': sorted(cuts), 'events': events,
        'counts': {'validMotionPixels': valid, 'establishedSurfacePixels': established,
                   'switchComparablePixels': comparable,
                   'pixelsWithTapSwitches': switches, 'tapSwitchPixelFraction': switches / comparable if comparable else None,
                   'pixelsWithRepeatedTapSwitches': reversals, 'pixelsOverTapSwitchThreshold': large_switches},
        'alignedChangeRms': dict(zip(('temporal', 'oidn'), np.sqrt(change_energy / valid).tolist()))
        if valid else None,
        'settings': temporal['settings'], 'denoiserWeights': scan.get('denoiserWeights'),
        'heatmaps': 'heatmaps.mp4' if make_video else None,
        'calibration': 'calibration.json' if calibration else None,
        'referenceSpp': reference_spp,
        'cost': {
            'temporal capture': cost(temporal['seconds'], count),
            'spatial capture': cost(spatial['seconds'], count),
            'quick analysis and encoding': cost(monotonic() - started - reference_cpu, count),
            'reference capture': cost(reference_timing, len(reference_sources)) if reference_sources else None,
            'reference analysis': cost(reference_cpu, len(reference_sources)) if reference_sources else None,
        },
        'issueGroups': {'issues': len(plain), 'authoredChanges': len(authored)},
        'issues': review_list(plain, issue_limit),
        'authoredChanges': review_list(authored, issue_limit),
    }
    write_report(out, run_info)
    return run_info


def reference_selection(report):
    first, last = report['frames']
    span = min(8, last - first + 1)
    ranges = []

    def add(center):
        start = min(last - span + 1, max(first, center - span // 2))
        end = start + span - 1
        if all(end < a or start > b for a, b in ranges):
            ranges.append((start, end))

    for kind in TYPES:
        for issue in report['issues']:
            if issue['type'] == kind:
                add(issue['peakFrame'])
                break
    # Always retain an independent interval, including when no candidate was found.
    for center in (first + (last - first) // 2, first, last):
        count = len(ranges)
        add(center)
        if len(ranges) > count:
            break
    return sorted(ranges)


def merge_ranges(ranges):
    result = []
    for first, last in sorted(ranges):
        if result and first <= result[-1][1] + 1:
            result[-1] = (result[-1][0], max(last, result[-1][1]))
        else:
            result.append((first, last))
    return result


def capture(args, folder, frames, mode, reference=False, context=None):
    command = ['node', str(args.cli), 'capture', str(args.shot), '-o', str(folder),
               '--frames', range_flag(frames), '--tracer', 'hardware', '--sample-sequence', 'frame',
               '--denoise', mode, '--seed', 'fixed']
    for key in ('size', 'fps', 'bounces', 'seed_value'):
        value = getattr(args, key)
        if value is not None:
            command.extend(('--' + key.replace('_', '-'), str(value)))
    if reference:
        # A zero-radius window takes the same OIDN and presentation path as the
        # filtered arm while preserving the reference frame's independent samples.
        spp = str(args.fine_spp)
        command.extend(('--timing-only', '--spp', spp, '--sample-stride', spp,
                        '--reflection-motion', 'off', '--history-radius', '0', '--post-radius', '0'))
    else:
        for key in ('spp', 'sample_stride'):
            value = getattr(args, key)
            if value is not None:
                command.extend(('--' + key.replace('_', '-'), str(value)))
        if context:
            command.extend(('--context', range_flag(context)))
        if mode == 'temporal':
            command.append('--artifact-scan')
            for key in ('history_radius', 'post_radius', 'reflection_motion'):
                value = getattr(args, key)
                if value is not None:
                    command.extend(('--' + key.replace('_', '-'), str(value)))
        else:
            command.append('--timing-only')
    if args.gpu_lock:
        command = [str(args.gpu_lock), 'D', '--', *command]
    print(f'Capturing {folder.name} frames {range_flag(frames)}', flush=True)
    with (args.output / (folder.name + '.log')).open('w') as stream:
        stream.write(json.dumps(command) + '\n')
        stream.flush()
        subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True)


def command_line():
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('-o', '--output', type=Path, required=True)
    common.add_argument('--thresholds', type=Path, help='JSON overrides for the scan thresholds')
    common.add_argument('--no-video', action='store_true')
    common.add_argument('--max-issues', type=int, default=DEFAULT_ISSUE_LIMIT,
                        help='Maximum issues per report section (0 keeps all qualifying groups)')
    common.add_argument('--fine-frames', type=frame_range, action='append', default=[])
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run', parents=[common], help='Render a shot and analyze it')
    run.add_argument('shot', type=Path)
    run.add_argument('--frames', type=frame_range, required=True)
    run.add_argument('--context', type=frame_range)
    run.add_argument('--fine', action='store_true', help='Render reference intervals')
    run.add_argument('--fine-spp', type=int, choices=REFERENCE_SAMPLES, default=256,
                     help='Reference samples per pixel (default 256)')
    run.add_argument('--cli', type=Path, default=ROOT / 'cli/dist/main.mjs')
    run.add_argument('--gpu-lock', type=Path, default=os.environ.get('MUTRACER_SCAN_GPU_LOCK'))
    run.add_argument('--scratch', type=Path, help='Parent directory for temporary captures')
    for key in ('size', 'fps', 'spp', 'bounces', 'seed-value', 'sample-stride', 'history-radius',
                'post-radius', 'reflection-motion'):
        run.add_argument('--' + key)
    existing = commands.add_parser('analyze', parents=[common], help='Analyze existing paired captures')
    existing.add_argument('temporal', type=Path)
    existing.add_argument('spatial', type=Path)
    existing.add_argument('--reference', type=Path, action='append', default=[])
    existing.add_argument('--calibration-only', action='store_true',
                          help='Score covered reference frames without tracking issues or encoding video')
    args = parser.parse_args()
    if args.max_issues < 0:
        parser.error('--max-issues must be nonnegative.')
    if args.command == 'analyze' and args.calibration_only and not args.reference:
        parser.error('--calibration-only requires --reference.')
    args.output = args.output.resolve()
    if args.command == 'run':
        if (args.fine_frames or args.fine_spp != 256) and not args.fine:
            parser.error('--fine-frames and --fine-spp require --fine.')
        if any(start < args.frames[0] or stop > args.frames[1] for start, stop in args.fine_frames):
            parser.error('Fine intervals must fit within --frames.')
    return args


def main():
    args = command_line()
    thresholds = Thresholds(**(json.loads(args.thresholds.read_text()) if args.thresholds else {}))
    thresholds.check()
    make_video = not args.no_video and not getattr(args, 'calibration_only', False)
    if make_video:
        Video.check()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.command == 'analyze':
        if args.calibration_only:
            analyze(args.temporal, args.spatial, args.output, thresholds, args.reference,
                    args.fine_frames, make_video=False, calibration_only=True)
        else:
            report = analyze(args.temporal, args.spatial, args.output, thresholds, make_video=make_video,
                             issue_limit=0 if args.reference else args.max_issues)
            if args.reference:
                analyze(args.temporal, args.spatial, args.output, thresholds, args.reference,
                        args.fine_frames, make_video=False, base_report=report, issue_limit=args.max_issues)
        return
    if args.scratch:
        args.scratch.mkdir(parents=True, exist_ok=True)
    args.shot, args.cli = args.shot.resolve(), args.cli.resolve()
    if args.gpu_lock:
        args.gpu_lock = args.gpu_lock.resolve()
    with tempfile.TemporaryDirectory(prefix='temporal-scan-', dir=args.scratch) as temporary:
        scratch = Path(temporary)
        temporal, spatial = scratch / 'temporal', scratch / 'spatial'
        capture(args, temporal, args.frames, 'temporal', context=args.context)
        metadata = load_metadata(temporal)
        if not metadata['scan']['denoiserWeights']:
            raise ValueError('Set MUTRACER_OIDN_WEIGHTS to the cleanAuxLarge model and its guide weights.')
        capture(args, spatial, args.frames, 'cleanAuxLarge', context=(metadata['first'], metadata['last']))
        report = analyze(temporal, spatial, args.output, thresholds, make_video=make_video,
                         issue_limit=0 if args.fine else args.max_issues)
        if args.fine:
            ranges = args.fine_frames or reference_selection(report)
            first = args.frames[0]
            references = []
            for start, stop in merge_ranges((max(first, start - 4), stop) for start, stop in ranges):
                folder = scratch / f'reference-{start}-{stop}'
                capture(args, folder, (start, stop), 'temporal', reference=True)
                references.append(folder)
            analyze(temporal, spatial, args.output, thresholds, references, ranges,
                    make_video=False, base_report=report, issue_limit=args.max_issues)


if __name__ == '__main__':
    main()
