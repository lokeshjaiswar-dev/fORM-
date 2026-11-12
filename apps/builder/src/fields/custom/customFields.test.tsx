import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BUILDER_LOCALE } from '@/i18n';
import { defaultCustomConfig, parseCustomField, type CustomField } from '@/fields/custom/model';
import { MemoryCustomFieldRepository, customFields, saveLibraryField, setCustomFieldRepository } from '@/fields/custom/repository';
import { FieldsPage } from '@/pages/FieldsPage';
import { FieldEditorPage } from '@/pages/FieldEditorPage';
import { tilesFromCustomFields } from '@/fields/tiles';

function sample(over: Partial<CustomField> = {}): CustomField {
  const now = '2026-11-12T10:00:00.000Z';
  return {
    id: 'emp',
    name: 'Employee code',
    icon: 'hash',
    keywords: ['staff'],
    baseType: 'short_text',
    config: { ...defaultCustomConfig('short_text', BUILDER_LOCALE), maxLength: 8, preset: 'alphanumeric' },
    required: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('custom field library', () => {
  let memory: MemoryCustomFieldRepository;

  beforeEach(() => {
    memory = new MemoryCustomFieldRepository();
    setCustomFieldRepository(memory);
  });

  it('accepts a named field with registry config and rejects an unknown type', () => {
    expect(parseCustomField(sample())?.name).toBe('Employee code');
    expect(parseCustomField({ ...sample(), baseType: 'nps' })).toBeNull();
    expect(parseCustomField({ ...sample(), config: { minLength: -1 } })).toBeNull();
  });

  it('lists saved fields and deletes them', async () => {
    await customFields.save(sample());
    render(
      <MemoryRouter>
        <FieldsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Employee code')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete field' }));
    expect(await screen.findByText(/No custom fields yet/)).toBeInTheDocument();
    expect(memory.records.size).toBe(0);
  });

  it('creates a field from the editor', async () => {
    render(
      <MemoryRouter initialEntries={['/fields/new']}>
        <Routes>
          <Route path="/fields/:id" element={<FieldEditorPage />} />
          <Route path="/fields" element={<p>list</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'New field' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'GSTIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save field' }));
    expect([...memory.records.values()][0]).toMatchObject({ name: 'GSTIN', baseType: 'short_text' });
  });

  it('updates a library field with the same name and type instead of duplicating it', async () => {
    const first = await saveLibraryField({
      name: 'Code',
      icon: 'hash',
      keywords: [],
      baseType: 'short_text',
      config: { maxLength: 4 },
      required: false,
    });
    const second = await saveLibraryField({
      name: 'Code',
      icon: 'hash',
      keywords: [],
      baseType: 'short_text',
      config: { maxLength: 8 },
      required: true,
    });
    expect(second.id).toBe(first.id);
    expect(memory.records.size).toBe(1);
    expect(memory.records.get(first.id)?.config).toMatchObject({ maxLength: 8 });
  });

  it('turns a library field into a palette tile in Your fields', () => {
    const [tile] = tilesFromCustomFields([sample()]);
    expect(tile).toMatchObject({
      kind: 'block',
      id: 'custom.emp',
      category: 'snippets',
      label: 'Employee code',
      required: true,
      choice: { type: 'short_text', configOverrides: expect.objectContaining({ maxLength: 8, preset: 'alphanumeric' }) },
    });
  });
});
