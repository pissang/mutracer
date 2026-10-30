import { getSpotLightRadiance, getSpotLightShapingFluxFactor } from '../../src/renderer/lightsUtil.js';
import { describe, expect, it } from 'vitest';
import SpotLight from '../../src/scene/SpotLight';
import { IESParseError, parseIESProfile } from '../../src/scene/IESProfile';
import { packLightsToBuffer } from '../../src/renderer/lightsUtil';
import {
  estimateAnalyticLightPower,
  packIESProfiles,
  sphereSolidAnglePdf
} from '../../src/renderer/lightSampling';
import sampleLightWGSL from '../../src/renderer/wgsl/chunks/sampleLight.wgsl';
import sampleLightGLSL from '../../src/renderer/glsl/chunks/sampleLight.glsl';
import intersectLightWGSL from '../../src/renderer/wgsl/chunks/intersect.wgsl';
import intersectLightGLSL from '../../src/renderer/glsl/chunks/intersect.glsl';

function makeIES(horizontalAngles = [0, 90], rows = [[100, 50, 0], [20, 10, 0]]) {
  return [
    'IESNA:LM-63-1995',
    '[TEST] deterministic',
    'TILT=NONE',
    `1 1000 1 3 ${horizontalAngles.length} 1 1 0 0 0`,
    '1 1 10',
    '0 45 90',
    horizontalAngles.join(' '),
    rows.flat().join(' ')
  ].join('\n');
}

describe('spot light and IES semantics', () => {
  it('strictly parses Type C data and peak-normalizes it', () => {
    const profile = parseIESProfile(makeIES(), 'fixture.ies');
    expect(profile.peakCandela).toBe(100);
    expect(profile.evaluateAngles(0, 0)).toBe(1);
    expect(profile.evaluateAngles(45, 0)).toBe(0.5);
    expect(profile.evaluateAngles(0, -90)).toBeCloseTo(0.2);
    expect(profile.evaluateAngles(0, 90)).toBeCloseTo(0.2);
    expect(Math.max(...profile.data)).toBe(1);
  });

  it('applies 0..90 Type C symmetry and profile rotation at boundaries', () => {
    const profile = parseIESProfile(makeIES());
    expect(profile.evaluateAngles(0, 45)).toBeCloseTo(profile.evaluateAngles(0, -45));
    expect(profile.evaluateAngles(0, 135)).toBeCloseTo(profile.evaluateAngles(0, 45));
    const unrotated = profile.sampleBaked(0.35, 0.1, 0);
    const rotatedDirection = profile.sampleBaked(0.35, 0.1 + Math.PI / 2, Math.PI / 2);
    expect(rotatedDirection).toBeCloseTo(unrotated, 6);
    expect(profile.sampleBaked(Math.PI / 2, -Math.PI)).toBeGreaterThanOrEqual(0);
    expect(profile.sampleBaked(Math.PI / 2, Math.PI)).toBeGreaterThanOrEqual(0);
    const row = 13;
    const rowCenter = ((row + 0.5) / 128 - 0.5) * 2 * Math.PI;
    const wrappedAxis = 0.5 * (profile.data[row * 128 + 127] + profile.data[row * 128]);
    expect(profile.sampleBaked(0, rowCenter)).toBeCloseTo(wrappedAxis, 6);
  });

  it('rejects malformed, tilted, and non-Type-C profiles without fallback', () => {
    expect(() => parseIESProfile(makeIES().replace('TILT=NONE', 'TILT=INCLUDE'), 'tilted.ies')).toThrow(IESParseError);
    expect(() => parseIESProfile(makeIES().replace('3 2 1 1', '3 2 2 1'), 'type-b.ies')).toThrow(/Type C/);
    expect(() => parseIESProfile(makeIES() + '\n999', 'extra.ies')).toThrow(/data size/);
  });

  it('packs sphere radiance, cone shaping, profile index, and finite PDFs', () => {
    const profile = parseIESProfile(makeIES());
    const light = (() => { const light = new SpotLight({color: [1, 0.5, 0.25], intensity: 20, radius: 0.5, innerAngle: 30, outerAngle: 45, iesProfile: profile}); const p = [1, 2, 3], d = [0, -2, 0]; light.position = [p[0], p[1], p[2]]; light.lookAt([p[0]+d[0], p[1]+d[1], p[2]+d[2]]); const angle = -(90) * Math.PI / 180; const m = light.transform, x = Array.from(m.slice(0,3)), y = Array.from(m.slice(4,7)); for(let i=0;i<3;i++){m[i]=x[i]*Math.cos(angle)+y[i]*Math.sin(angle);m[4+i]=y[i]*Math.cos(angle)-x[i]*Math.sin(angle);}return light; })();
    const packedProfiles = packIESProfiles([light]);
    const data = packLightsToBuffer([light], [-1], [1], [1], packedProfiles.offsets);
    expect(data[4]).toBeCloseTo(20 / (Math.PI * 0.25));
    expect(Array.from(data.slice(8, 11))).toEqual([0, -1, 0]);
    expect(data[12]).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(data[13]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(data[14]).toBe(0);
    expect(data[20]).toBeCloseTo(0); expect(data[21]).toBeCloseTo(0); expect(data[22]).toBeCloseTo(1);
    expect(data[15]).toBe(0);
    expect(data[16]).toBeCloseTo(0.5);
    expect(data[17]).toBeCloseTo(Math.PI);
    expect(data[18]).toBe(4);
    for (const distance of [0.25, 1, 2, 10]) {
      expect(Number.isFinite(sphereSolidAnglePdf(distance, light.radius))).toBe(true);
      expect(sphereSolidAnglePdf(distance, light.radius)).toBeGreaterThan(0);
    }
  });

  it('keeps inverse-square far-field behavior and cone shaping power', () => {
    const light = (() => { const light = new SpotLight({color: [1, 1, 1], intensity: 40, radius: 0.01, innerAngle: 20, outerAngle: 30}); const p = [0, 0, 0], d = [0, 0, -1]; light.position = [p[0], p[1], p[2]]; light.lookAt([p[0]+d[0], p[1]+d[1], p[2]+d[2]]); return light; })();
    const farIrradiance = (distance: number) => getSpotLightRadiance(light) / sphereSolidAnglePdf(distance, light.radius);
    expect(farIrradiance(4) / farIrradiance(8)).toBeCloseTo(4, 3);
    expect(estimateAnalyticLightPower(light)).toBeGreaterThan(0);
    expect(Number.isFinite(estimateAnalyticLightPower(light))).toBe(true);
  });

  it('preserves small sphere solid angles without cancellation', () => {
    for (const radius of [.05, .005, .001]) {
      for (const distance of [2, 4, 8]) {
        // Independent half-angle identity, accurate even for narrow cones.
        const halfAngleSine = Math.sin(Math.asin(radius / distance) / 2);
        const solidAngle = 4 * Math.PI * halfAngleSine * halfAngleSine;
        expect(sphereSolidAnglePdf(distance, radius) * solidAngle).toBeCloseTo(1, 14);
      }
    }
    expect(sphereSolidAnglePdf(.5, 1)).toBe(1 / (4 * Math.PI));
    expect(sphereSolidAnglePdf(1, 1)).toBe(1 / (4 * Math.PI));
  });

  it('integrates the inner-to-outer cosine smoothstep for spot selection power', () => {
    const smoothstep = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (const [innerAngle, outerAngle] of [[30, 45], [0, 60], [45, 45], [5, 170]]) {
      const cosOuter = Math.cos(outerAngle * Math.PI / 180), cosInner = Math.cos(innerAngle * Math.PI / 180);
      // Midpoint rule over cos(theta); the sphere has measure 2 in cos(theta).
      let integral = 0;
      const steps = 20000;
      for (let i = 0; i < steps; i++) {
        const mu = -1 + (i + 0.5) * 2 / steps;
        const cone = cosInner > cosOuter ? smoothstep(cosOuter, cosInner, mu) : Number(mu >= cosOuter);
        integral += cone * 2 / steps;
      }
      const light = new SpotLight({innerAngle, outerAngle});
      expect(getSpotLightShapingFluxFactor(light)).toBeCloseTo(integral / 2, 4);
    }
  });

  it('supports point-spot delta units and preserves angular shader shaping', () => {
    const light = (() => { const light = new SpotLight({color: [1, 1, 1], intensity: 40, radius: 0, innerAngle: 20, outerAngle: 30}); const p = [0, 0, 0], d = [0, 0, -1]; light.position = [p[0], p[1], p[2]]; light.lookAt([p[0]+d[0], p[1]+d[1], p[2]+d[2]]); return light; })();
    expect(getSpotLightRadiance(light)).toBe(40);
    const packed = packLightsToBuffer([light], [-1], [1], [1]);
    expect(Array.from(packed.slice(4, 7))).toEqual([40, 40, 40]);
    expect(packed.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(estimateAnalyticLightPower(light))).toBe(true);
    expect(sampleLightWGSL).toContain('(*lightSample).isDelta = true');
    expect(sampleLightWGSL).toContain('evaluateSpotEmissionMultiplier');
    expect(sampleLightGLSL).toContain('result.isDelta = true');
    expect(sampleLightGLSL).toContain('evaluateSpotEmissionMultiplier');
    expect(intersectLightWGSL({ hasDisplacement: false })).toContain(
      'light.radiusOrSpread <= 0.0'
    );
    expect(intersectLightGLSL.main).toContain('light.radius <= 0.0');
  });

  it('wires spot sampling through both shader backends', () => {
    expect(sampleLightWGSL).toContain('evaluateSpotEmissionMultiplier');
    expect(sampleLightWGSL).toContain('lightType == SPOT_LIGHT');
    expect(sampleLightGLSL).toContain('evaluateSpotEmissionMultiplier');
    expect(sampleLightGLSL).toContain('lightType == SPOT_LIGHT');
  });
});
