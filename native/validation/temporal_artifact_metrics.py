"""Pixel measurements for an offline temporal artifact scan."""

from dataclasses import dataclass

import numpy as np
from scipy import ndimage


SURFACE_OBSERVATIONS = 5


def display_signal(rgb):
    r, g, b = np.moveaxis(rgb.astype(np.float32), -1, 0)
    return np.stack((.2126 * r + .7152 * g + .0722 * b, .5 * (r - g), .5 * (b - g)), -1)


def magnitude(signal):
    return np.max(np.abs(signal), axis=-1)


def patch_rms(signal):
    return np.sqrt(np.maximum(0, ndimage.uniform_filter(signal * signal, 3)))


class Warp:
    """Current-to-previous correspondence using the center AOV and matching IDs."""

    def __init__(self, grid, motion, ids, previous_ids):
        h, w = ids.shape[:2]
        y, x = grid
        mx, my, _, flags = np.ascontiguousarray(np.moveaxis(motion, -1, 0))
        finite = np.isfinite(mx) & np.isfinite(my)
        u, v = x + np.where(finite, mx, 0), y + np.where(finite, my, 0)
        inside = (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
        u, v = np.clip(u, 0, w - 1), np.clip(v, 0, h - 1)
        floor_u, floor_v = np.floor(u), np.floor(v)
        i, j = floor_u.astype(np.int32), floor_v.astype(np.int32)
        fu, fv = u - floor_u, v - floor_v
        k, l = np.minimum(i + 1, w - 1), np.minimum(j + 1, h - 1)
        self.nearest = (np.rint(v).astype(np.int32), np.rint(u).astype(np.int32))
        self.corners = []
        weight_sum = np.zeros((h, w), np.float32)
        for row, col, fraction in ((j, i, (1 - fu) * (1 - fv)), (j, k, fu * (1 - fv)),
                                    (l, i, (1 - fu) * fv), (l, k, fu * fv)):
            same = np.all(previous_ids[row, col, :3] == ids[..., :3], axis=-1)
            weight = fraction.astype(np.float32) * same
            self.corners.append((row, col, weight))
            weight_sum += weight
        self.valid = (finite & inside & (flags == 3) & (weight_sum >= .6)
                      & np.all(previous_ids[self.nearest][..., :3] == ids[..., :3], axis=-1))
        self.inverse_weight = np.where(self.valid, 1 / np.maximum(weight_sum, 1e-6), 0)
        self.changed_screen_id = np.any(ids[..., :3] != previous_ids[..., :3], axis=-1)
        self.travel = np.hypot(mx, my)

    def sample(self, pixels):
        result = np.zeros_like(pixels)
        for y, x, weight in self.corners:
            result += pixels[y, x] * weight[..., None]
        return result * self.inverse_weight[..., None]


_BIT_COUNTS = np.array([n.bit_count() for n in range(256)], dtype=np.uint8)


def count_bits(mask):
    return _BIT_COUNTS[np.ascontiguousarray(mask).view(np.uint8).reshape(*mask.shape, 4)].sum(-1)


def tap_switches(warp, current, previous, previous_changes=None):
    prior = previous[warp.nearest]
    eligible = current[..., :2] & prior[..., :2]
    changed = ((current[..., 2:4] ^ prior[..., 2:4]) |
               (current[..., 4:6] ^ prior[..., 4:6])) & eligible
    available = count_bits(eligible).sum(-1)
    count = count_bits(changed).sum(-1)
    comparable = warp.valid & (available >= 2)
    flips = np.where(comparable[..., None], changed, 0)
    reversals = (None if previous_changes is None
                 else np.any(flips & previous_changes[warp.nearest], axis=-1))
    return np.where(comparable, count / np.maximum(1, available), 0).astype(np.float32), comparable, flips, reversals


def dominant_channel(signal):
    channel = np.argmax(np.abs(signal), axis=-1)[..., None]
    sign = np.sign(np.take_along_axis(signal, channel, axis=-1)[..., 0])
    return channel, sign


def signed_support(evidence, channel, sign):
    return sign * np.take_along_axis(evidence, channel, axis=-1)[..., 0]


@dataclass
class Measurements:
    flicker: np.ndarray
    oidn_change: np.ndarray
    ghost: np.ndarray
    switch: np.ndarray
    switch_comparable: np.ndarray
    valid: np.ndarray
    reversals: np.ndarray | None
    established: np.ndarray
    moving: np.ndarray
    oidn_noise: np.ndarray
    corroborated_ghost: np.ndarray


class QuickMetrics:
    def __init__(self, history=True):
        self.history = history
        self.ring = []
        self.previous_changes = None
        self.surface_age = None
        self.spatial_variance = None

    def reset(self):
        self.ring.clear()
        self.previous_changes = None
        self.surface_age = None
        self.spatial_variance = None

    def push(self, temporal, spatial, window, warp):
        residual = temporal - spatial
        zeros = np.zeros(temporal.shape[:2], dtype=np.float32)
        invalid = np.zeros(zeros.shape, dtype=bool)
        valid = invalid if warp is None else warp.valid
        flicker, spatial_change, ghost, corroborated_ghost, switch = (zeros,) * 5
        variance = zeros
        age = np.ones(zeros.shape, dtype=np.uint8)
        moving = invalid
        comparable = invalid
        older = None
        reversals = None
        if self.ring and warp is not None:
            age += np.where(valid, self.surface_age[warp.nearest], 0)
            np.minimum(age, SURFACE_OBSERVATIONS, out=age)
            moving = (warp.travel >= .35) | ndimage.maximum_filter(warp.changed_screen_id, 5)
            previous_t, previous_s, previous_window, old_residuals, deltas = self.ring[-1]
            t_s, s_s = np.split(warp.sample(np.concatenate((previous_t, previous_s), axis=-1)), 2, axis=-1)
            dt = (temporal - t_s) * valid[..., None]
            ds = (spatial - s_s) * valid[..., None]
            flicker, spatial_change = patch_rms(magnitude(dt)), patch_rms(magnitude(ds))
            switch, comparable, self.previous_changes, reversals = tap_switches(
                warp, window, previous_window, self.previous_changes)
            older = np.where(valid[..., None], old_residuals[0][warp.nearest], 0)
            if deltas is not None:
                # A reversal or change in slope adds evidence of flicker. Keep
                # a first-difference term for motion whose track lasts two frames.
                old_t, old_s, old_valid = deltas
                along_track = valid & old_valid[warp.nearest]
                t_innovation = patch_rms(magnitude(dt - old_t[warp.nearest]) * .5 * along_track)
                s_innovation = patch_rms(magnitude(ds - old_s[warp.nearest]) * .5 * along_track)
                prior = self.spatial_variance[warp.nearest]
                variance = np.where(along_track, .25 * s_innovation ** 2 + .75 * prior, 0)
                flicker = np.where(along_track, .65 * flicker + .35 * t_innovation, flicker)
                spatial_change = np.where(along_track, .65 * spatial_change + .35 * s_innovation,
                                          spatial_change)
            if self.history and len(self.ring) >= 2 and len(old_residuals) == 2:
                older_again = np.where(valid[..., None], old_residuals[1][warp.nearest], 0)
                channel, sign = dominant_channel(residual)
                persistent = np.minimum(signed_support(older, channel, sign),
                                        signed_support(older_again, channel, sign))
                # An old appearance at the same screen position is evidence of a
                # lagged image. Compare against the motion-aligned old appearance
                # too, so stable bias on a tracked surface has little support.
                lag = zeros.copy()
                current = signed_support(spatial, channel, sign)
                for _, old_s, *_ in self.ring:
                    trail = signed_support(old_s, channel, sign) - current
                    lag = np.maximum(lag, trail)
                same_surface_change = signed_support(s_s, channel, sign) - current
                excess = np.maximum(0, lag - np.maximum(0, same_surface_change))
                ghost = np.minimum(magnitude(residual), np.minimum(persistent, 2 * excess))
                # The lag hypothesis should survive an independent observation of the
                # current surface. An OIDN-only error can make a stable temporal output
                # disagree with the current OIDN image while matching its aligned neighbor.
                independent_error = signed_support(temporal - s_s, channel, sign)
                corroborated = np.minimum(ghost, 1.5 * independent_error)
                corroborated_ghost = patch_rms(np.maximum(0, corroborated) * moving * valid)
                ghost = patch_rms(np.maximum(0, ghost) * moving)
        else:
            dt = ds = None
        residuals = (residual,) if older is None else (residual, older)
        self.ring.append((temporal, spatial, window, residuals, (dt, ds, valid) if dt is not None else None))
        self.ring = self.ring[-3:]
        self.surface_age, self.spatial_variance = age, variance
        return Measurements(flicker, spatial_change, ghost, switch, comparable, valid, reversals,
                            age >= SURFACE_OBSERVATIONS, moving, np.sqrt(variance), corroborated_ghost)


class ReferenceMetrics:
    """A five-frame trailing mean along valid surface trajectories."""

    def __init__(self, length=5):
        self.length = length
        self.history = None
        self.previous = None

    def reset(self):
        self.history = None
        self.previous = None

    def push(self, temporal, spatial, reference, warp):
        error = temporal - reference
        direct_error = spatial - reference
        zeros = np.zeros(error.shape[:2], np.float32)
        depth = np.ones(error.shape[:2], np.uint8)
        errors = error[..., None, :]
        result = None
        if self.history is not None and warp is not None:
            previous_errors, previous_depth = self.history
            depth += np.where(warp.valid, previous_depth[warp.nearest], 0)
            depth = np.minimum(depth, self.length)
            errors = np.concatenate((errors, previous_errors[warp.nearest]), axis=2)[:, :, :self.length]
            if errors.shape[2] == self.length:
                valid = depth == self.length
                low = errors.mean(axis=2)
                high = error - low
                channel, sign = dominant_channel(low)
                sign_support = np.median(np.stack([signed_support(errors[..., i, :], channel, sign)
                                                   for i in range(self.length)]), axis=0)
                flicker = patch_rms(magnitude(high) * valid)
                appearance = np.zeros_like(zeros)
                aligned = warp.sample(self.previous[-1]) - reference
                for old in self.previous:
                    appearance = np.maximum(appearance, signed_support(old - reference, channel, sign))
                trail = np.maximum(0, appearance - np.maximum(0, signed_support(aligned, channel, sign)))
                larger_error = np.maximum(0, magnitude(error) - magnitude(direct_error))
                moving = (warp.travel >= .35) | ndimage.maximum_filter(warp.changed_screen_id, 5)
                ghost = patch_rms(np.maximum(0, np.minimum.reduce(
                    (magnitude(low), 2 * trail, larger_error, 2 * sign_support))) * valid * moving)
                result = flicker, ghost, valid, magnitude(low)
        self.history = errors, depth
        self.previous = (([] if self.previous is None else self.previous[-2:]) + [reference])
        return result


class ForegroundTrails:
    """Corroborate a bright trail with an earlier foreground footprint."""

    def __init__(self):
        self.history = []
        self.previous_residual = None
        self.older_residual = None

    def reset(self):
        self.history.clear()
        self.previous_residual = None
        self.older_residual = None

    def push(self, temporal, spatial, ids, warp):
        y = spatial[..., 0].copy()
        objects = ids[..., 0].copy()
        error = temporal[..., 0] - y
        local = ndimage.gaussian_filter(error, 1.1) - ndimage.gaussian_filter(error, 10.)
        score = np.zeros_like(y)
        sources = np.zeros_like(objects)
        older = None
        if warp is not None and self.previous_residual is not None:
            older = np.where(warp.valid, self.previous_residual[warp.nearest], 0)
            if len(self.history) >= 3 and self.older_residual is not None:
                oldest = np.where(warp.valid, self.older_residual[warp.nearest], 0)
                old_y = self.history[-1][0]
                aligned = warp.sample(old_y[..., None])[..., 0]
                footprint = np.zeros_like(y)
                for previous_y, previous_ids in self.history:
                    delta = previous_y - y
                    prefer = (previous_ids != objects) & (delta > footprint)
                    footprint = np.where(prefer, delta, footprint)
                    sources = np.where(prefer, previous_ids, sources)
                evidence = np.maximum(0, footprint - np.maximum(0, aligned - y))
                score = np.maximum(0, np.minimum.reduce((local, 1.25 * older, 1.5 * oldest, .1 * evidence)))
                score *= warp.valid
        self.history.append((y, objects))
        self.history = self.history[-10:]
        self.previous_residual, self.older_residual = local, older
        return score, sources
