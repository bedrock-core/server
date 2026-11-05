import { describe, expect, it } from 'vitest';
import type { AddonManifest } from '../src/manifest';
import { validateManifest } from '../src/manifest';

const authored = {
  format_version: 3,
  namespace: 'studio_addon',
  header: { name: 'pack.name', description: 'pack.description', version: '1.2.3', uuid: 'pack-uuid' },
  modules: [{ type: 'script', uuid: 'script-uuid', entry: 'scripts/main.js' }],
  metadata: { authors: ['First', 'Second'], license: 'MIT' },
  dependencies: [
    { uuid: 'resource', version: '1.2.3' },
    { uuid: 'library', version: '2.0.0', namespace: 'studio_library' },
    { module_name: '@minecraft/server', version: '2.10.0' },
  ],
  optionalDependencies: [{ uuid: 'extra', version: '3.0.0', namespace: 'studio_extra' }],
  thumbnail: 'textures/studio_addon/thumbnail',
} satisfies AddonManifest;

describe('addon manifest identity', () => {
  it('retains the complete native authored shape without adding display fields', () => {
    const manifest = validateManifest(authored);

    expect(manifest).toEqual(authored);
    expect(manifest.header.name).toBe('pack.name');
    expect(manifest.header.description).toBe('pack.description');
    expect(manifest.header.uuid).toBe('pack-uuid');
    expect(manifest.metadata?.authors).toEqual(['First', 'Second']);
    expect(manifest.dependencies?.[1]).toMatchObject({ uuid: 'library', version: '2.0.0', namespace: 'studio_library' });
    expect(manifest.optionalDependencies?.[0]).toEqual({ uuid: 'extra', version: '3.0.0', namespace: 'studio_extra' });
    expect(manifest).not.toHaveProperty('packName');
    expect(manifest).not.toHaveProperty('icon');
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.header)).toBe(true);
    expect(Object.isFrozen(manifest.metadata?.authors)).toBe(true);
    expect(Object.isFrozen(manifest.dependencies?.[1])).toBe(true);
    expect(Object.isFrozen(manifest.optionalDependencies?.[0])).toBe(true);
    expect(Object.isFrozen(authored)).toBe(false);
  });

  it('keeps custom display keys and native string versions', () => {
    const manifest = validateManifest({ ...authored, header: { name: 'custom.name', version: '1.2.3' } });

    expect(manifest.header).toMatchObject({ name: 'custom.name', version: '1.2.3' });
    expect(manifest.namespace).toBe('studio_addon');
  });

  it('rejects flat identity metadata, reserved namespaces and conflicting requirements', () => {
    expect(() => validateManifest({ creator: 'old', pack: 'identity', packName: 'Old', version: '1.0.0' })).toThrow(/namespace/);
    expect(() => validateManifest({ namespace: 'addon', packName: 'Display', version: '1.0.0' })).toThrow(/header is required/);
    expect(() => validateManifest({ ...authored, namespace: 'minecraft' })).toThrow(/reserved/);
    expect(() => validateManifest({ ...authored, dependencies: [{ uuid: 'self', version: '1.0.0', namespace: 'studio_addon' }] })).toThrow(/own namespace/);
    expect(() => validateManifest({ ...authored, optionalDependencies: [{ uuid: 'library', version: '2.0.0', namespace: 'studio_library' }] })).toThrow(/both required and optional/);
    expect(() => validateManifest({ ...authored, optionalDependencies: ['studio_extra'] })).toThrow(/native dependency objects/);
    expect(() => validateManifest({ ...authored, dependencies: ['studio_library'] })).toThrow(/native dependency objects/);
    expect(() => validateManifest({ ...authored, dependencies: [{ namespace: 'studio_library' }] })).toThrow(/must resolve to a native uuid or module_name/);
  });

  it('requires v3 manifests and string versions for every native version field', () => {
    expect(() => validateManifest({ ...authored, format_version: 2 })).toThrow(/format_version 3/);
    expect(() => validateManifest({ ...authored, header: { ...authored.header, version: [1, 2, 3] } })).toThrow(/header.version/);
    expect(() => validateManifest({ ...authored, header: { ...authored.header, min_engine_version: [1, 26, 50] } })).toThrow(/header.min_engine_version/);
    expect(() => validateManifest({ ...authored, header: { ...authored.header, base_game_version: [1, 26, 50] } })).toThrow(/header.base_game_version/);
    expect(() => validateManifest({ ...authored, header: { ...authored.header, pack_optimization_version: [1, 0, 0] } })).toThrow(/header.pack_optimization_version/);
    expect(() => validateManifest({ ...authored, modules: [{ type: 'script', version: [1, 2, 3] }] })).toThrow(/module version/);
    expect(() => validateManifest({ ...authored, dependencies: [{ uuid: 'resource', version: [1, 2, 3] }] })).toThrow(/dependencies version/);
    expect(() => validateManifest({ ...authored, optionalDependencies: [{ uuid: 'extra', version: [1, 2, 3] }] })).toThrow(/optionalDependencies version/);
  });

  it('requires versioned native dependencies at registration', () => {
    const references: NonNullable<AddonManifest['dependencies']> = [
      { module_name: '@minecraft/server' },
      { namespace: 'studio_library' },
    ];

    expect(() => validateManifest({ ...authored, dependencies: [references[0]] })).toThrow(/dependencies version/);
    expect(() => validateManifest({ ...authored, optionalDependencies: [references[1]] })).toThrow(/must resolve to a native uuid or module_name/);
    expect(() => validateManifest({ ...authored, dependencies: [{ pack: 'library' }] })).toThrow(/dependency.pack is not supported/);
    expect(() => validateManifest({ ...authored, dependencies: [{ module: '@minecraft/server' }] })).toThrow(/use module_name/);
    expect(() => validateManifest({ ...authored, dependencies: [{ uuid: 'library', module_name: '@minecraft/server', version: '1.0.0' }] })).toThrow(/must resolve to a native uuid or module_name/);
    expect(() => validateManifest({ ...authored, dependencies: [{ module_name: '@minecraft/server', version: '2.10.0', namespace: 'studio_library' }] })).toThrow(/require a native pack uuid/);
    expect(() => validateManifest({ ...authored, optionalDependencies: [{ uuid: 'extra' }] })).toThrow(/optionalDependencies version/);
  });

  it('preserves current native v3 settings, subpacks and generation metadata', () => {
    const input = {
      ...authored,
      header: { ...authored.header, base_game_version: '1.26.50', pack_optimization_version: '1.0.0', platform_locked: false },
      metadata: { ...authored.metadata, generated_with: { builder: ['1.0.0'] }, product_type: 'addon' },
      subpacks: [{ folder_name: 'high', name: 'High detail', memory_performance_tier: 5 }],
      settings: [
        { type: 'label', text: 'Select a detail level' },
        { type: 'toggle', text: 'Enable detail', name: 'detail', default: true },
        { type: 'slider', text: 'Intensity', name: 'intensity', min: 0, max: 10, step: 1, default: 5 },
        { type: 'dropdown', text: 'Preset', name: 'preset', options: [{ name: 'low', text: 'Low' }, { name: 'high', text: 'High' }], default: 'high' },
      ],
      capabilities: ['pbr'],
      has_education_metadata: false,
    } satisfies AddonManifest;
    const manifest = validateManifest(input);

    expect(manifest.header.base_game_version).toBe('1.26.50');
    expect(manifest.subpacks).toEqual(input.subpacks);
    expect(manifest.settings).toEqual(input.settings);
    expect(manifest.metadata?.generated_with).toEqual({ builder: ['1.0.0'] });
  });
});
