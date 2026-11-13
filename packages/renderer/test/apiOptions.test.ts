import { describe, expect, it, vi } from 'vitest';
import type { ApiOptions, SafeUrl } from '@form/schema';
import { displayOptionPath, fetchApiOptions, guessMapping, mapApiOptions, pickFromTree } from '../src/controls/apiOptions.ts';

const url = 'https://hr.example.com/cities' as SafeUrl;

describe('mapApiOptions', () => {
  it('maps an array of objects using label and value keys', () => {
    const config: ApiOptions = { url, itemsPath: 'data.cities', collectionKind: 'array', labelKey: 'name', valueKey: 'id' };
    expect(mapApiOptions({ data: { cities: [{ id: 'mum', name: 'Mumbai' }, { id: 'del', name: 'Delhi' }] } }, config)).toEqual([
      { id: 'mum', label: 'Mumbai' },
      { id: 'del', label: 'Delhi' },
    ]);
  });

  it('maps a string array as itself', () => {
    const config: ApiOptions = { url, itemsPath: '', collectionKind: 'array', labelKey: '$self', valueKey: '$self' };
    expect(mapApiOptions(['Mumbai', 'Delhi'], config)).toEqual([
      { id: 'Mumbai', label: 'Mumbai' },
      { id: 'Delhi', label: 'Delhi' },
    ]);
  });

  it('maps a key/value object using $key', () => {
    const config: ApiOptions = { url, itemsPath: '', collectionKind: 'map', labelKey: '$self', valueKey: '$key' };
    expect(mapApiOptions({ mum: 'Mumbai', del: 'Delhi' }, config)).toEqual([
      { id: 'mum', label: 'Mumbai' },
      { id: 'del', label: 'Delhi' },
    ]);
  });
});

describe('pickFromTree', () => {
  const cities = { data: { cities: [{ id: 'mum', name: 'Mumbai' }, { id: 'del', name: 'Delhi' }] } };

  it('reads a field on an item as the list plus that field', () => {
    expect(pickFromTree(cities, 'data.cities[0].name')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: 'name' });
    expect(pickFromTree(cities, 'data.cities[0].id')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: 'id' });
  });

  it('treats a clicked list as the whole item', () => {
    expect(pickFromTree(cities, 'data.cities', 'list')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: '$self' });
  });

  it('uses the map key or the map value', () => {
    const mapped = { mum: 'Mumbai', del: 'Delhi' };
    expect(pickFromTree(mapped, 'mum', 'leaf')).toEqual({ itemsPath: '', collectionKind: 'map', field: '$self' });
    expect(pickFromTree(mapped, 'mum', 'entryKey')).toEqual({ itemsPath: '', collectionKind: 'map', field: '$key' });
  });
});

describe('displayOptionPath', () => {
  it('shows a response path with [] for the list', () => {
    expect(displayOptionPath('data.cities', 'name')).toBe('response.data.cities[].name');
    expect(displayOptionPath('', '$self')).toBe('response[]');
  });
});

describe('pickFromTree', () => {
  const cities = { data: { cities: [{ id: 'mum', name: 'Mumbai' }, { id: 'del', name: 'Delhi' }] } };

  it('reads a field on an item as the list plus that field', () => {
    expect(pickFromTree(cities, 'data.cities[0].name')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: 'name' });
    expect(pickFromTree(cities, 'data.cities[0].id')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: 'id' });
  });

  it('treats a clicked list as the whole item', () => {
    expect(pickFromTree(cities, 'data.cities', 'list')).toEqual({ itemsPath: 'data.cities', collectionKind: 'array', field: '$self' });
  });

  it('uses the map key or the map value', () => {
    const mapped = { mum: 'Mumbai', del: 'Delhi' };
    expect(pickFromTree(mapped, 'mum', 'leaf')).toEqual({ itemsPath: '', collectionKind: 'map', field: '$self' });
    expect(pickFromTree(mapped, 'mum', 'entryKey')).toEqual({ itemsPath: '', collectionKind: 'map', field: '$key' });
  });
});

describe('displayOptionPath', () => {
  it('shows a response path with [] for the list', () => {
    expect(displayOptionPath('data.cities', 'name')).toBe('response.data.cities[].name');
    expect(displayOptionPath('', '$self')).toBe('response[]');
  });
});

describe('guessMapping', () => {
  it('prefers name/id on objects and $key on maps', () => {
    expect(guessMapping('array', false, ['id', 'name'])).toEqual({ labelKey: 'name', valueKey: 'id' });
    expect(guessMapping('map', true, [])).toEqual({ labelKey: '$self', valueKey: '$key' });
    expect(guessMapping('array', true, [])).toEqual({ labelKey: '$self', valueKey: '$self' });
  });
});

describe('fetchApiOptions', () => {
  it('GETs the URL and maps the selected array', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { cities: [{ id: 'mum', name: 'Mumbai' }] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config: ApiOptions = { url, method: 'GET', itemsPath: 'data.cities', collectionKind: 'array', labelKey: 'name', valueKey: 'id' };
    await expect(fetchApiOptions(config)).resolves.toEqual([{ id: 'mum', label: 'Mumbai' }]);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }));
    vi.unstubAllGlobals();
  });
});
