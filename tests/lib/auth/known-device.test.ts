import { describe, it, expect } from 'vitest';
import { KNOWN_DEVICE_MAX_ENTRIES, knownDeviceFor, withKnownDevice } from '@/lib/auth/known-device';

describe('v1.58.1: known-device cookie value', () => {
  it('mints a value that verifies for the same username (case and spacing normalised) only', () => {
    const value = withKnownDevice(undefined, 'alex');
    const id = knownDeviceFor(value, ' Alex ');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(knownDeviceFor(value, 'sam')).toBeNull();
  });

  it('reuses the verified device id for the same username', () => {
    const first = withKnownDevice(undefined, 'alex');
    const second = withKnownDevice(first, 'alex');
    expect(knownDeviceFor(second, 'alex')).toBe(knownDeviceFor(first, 'alex'));
    expect(second.split('~')).toHaveLength(1);
  });

  it('keeps another user entry and both verify', () => {
    const value = withKnownDevice(withKnownDevice(undefined, 'alex'), 'sam');
    expect(knownDeviceFor(value, 'alex')).not.toBeNull();
    expect(knownDeviceFor(value, 'sam')).not.toBeNull();
    expect(value.split('~')).toHaveLength(2);
  });

  it('ignores a tampered mac, garbage and oversized values', () => {
    const value = withKnownDevice(undefined, 'alex');
    const [id, mac] = value.split('.');
    const flipped = `${id}.${(mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)}`;
    expect(knownDeviceFor(flipped, 'alex')).toBeNull();
    expect(knownDeviceFor('not-a-cookie', 'alex')).toBeNull();
    expect(knownDeviceFor('~~.~', 'alex')).toBeNull();
    expect(knownDeviceFor(undefined, 'alex')).toBeNull();
    expect(knownDeviceFor(`${'x'.repeat(1030)}~${value}`, 'alex')).toBeNull();
  });

  it('caps at five entries, newest first', () => {
    let value: string | undefined;
    for (const name of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']) value = withKnownDevice(value, name);
    expect(value!.split('~')).toHaveLength(KNOWN_DEVICE_MAX_ENTRIES);
    expect(knownDeviceFor(value, 'u7')).not.toBeNull();
    expect(knownDeviceFor(value, 'u1')).toBeNull();
  });
});
