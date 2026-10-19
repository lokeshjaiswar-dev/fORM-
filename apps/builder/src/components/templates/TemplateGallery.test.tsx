import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { editionSummary, loadEditionConfig } from '@form/config';
import type { Formpack } from '@form/templates';
import TemplateGallery from '@/components/templates/TemplateGallery';
import { useEditionStore } from '@/edition/edition';
import { formFromTemplate, loadSystemPack } from '@/lib/systemPack';
import { formWith } from '@/test/fixtures';

vi.mock('@/lib/systemPack', () => ({ GALLERY_LOCALE: 'en-IN', loadSystemPack: vi.fn(), formFromTemplate: vi.fn() }));

const template = {
  entry: { slug: 'test/event', requiredFeatures: ['field:short_text'] },
  file: {
    payload: {
      kind: 'form',
      estimatedMinutes: 3,
      document: { blocks: {} },
      variables: [
        { name: 'custom.event_name', source: 'prompt', type: 'text', label: 'Event name', required: true, binding: 'bake' },
        { name: 'custom.dietary', source: 'prompt', type: 'boolean', label: 'Ask about dietary needs', required: false, default: false, binding: 'bake' },
        { name: 'org.legal_name', source: 'org_profile', type: 'text', label: 'Organisation', required: true, binding: 'live' },
      ],
      optionalParts: [{ id: 'diet', label: 'Dietary preferences', when: { variable: 'custom.dietary', equals: true }, includes: {} }],
    },
    localizations: [{ locale: 'en-IN', title: 'Event registration', summary: 'Sign people up' }],
    categorySlugs: [],
  },
};
const pack = { templates: [template] } as unknown as Formpack;

beforeEach(() => {
  useEditionStore.setState({ summary: null, source: 'unknown' });
  vi.mocked(loadSystemPack).mockReset();
  vi.mocked(formFromTemplate).mockReset();
});

describe('TemplateGallery', () => {
  it('BL-117: the Use step asks the prompt variables and optional parts, then instantiates with the answers', async () => {
    vi.mocked(loadSystemPack).mockResolvedValue(pack);
    const definition = { ...formWith([]), title: 'Made' };
    vi.mocked(formFromTemplate).mockReturnValue({ definition, warnings: [] });
    const onUse = vi.fn();
    render(<TemplateGallery onUse={onUse} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Event registration/ }));
    expect(screen.getByText('About 3 minutes to fill in')).toBeInTheDocument();
    expect(screen.queryByText('Organisation')).not.toBeInTheDocument();
    expect(screen.getByText(/Includes: Dietary preferences/)).toBeInTheDocument();
    const use = screen.getByRole('button', { name: 'Use template' });
    expect(use).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Event name (required)' }), 'Tech meetup');
    await user.click(screen.getByRole('switch', { name: 'Ask about dietary needs' }));
    await user.click(use);
    expect(vi.mocked(formFromTemplate).mock.calls[0]?.[2]).toMatchObject({ variables: { 'custom.event_name': 'Tech meetup', 'custom.dietary': true } });
    expect(onUse).toHaveBeenCalledWith(definition, 'Event registration');
  });

  it('BL-124: a failed load shows the error once, and a retry that works clears it', async () => {
    vi.mocked(loadSystemPack).mockRejectedValueOnce(new Error('bad signature')).mockResolvedValue(pack);
    render(<TemplateGallery onUse={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Event registration/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('edition matrix: templates the edition cannot run are hidden, with a count (FND-19)', async () => {
    const sheets = {
      ...template,
      entry: { slug: 'test/sheets', requiredFeatures: ['field:short_text', 'integration:google_sheets'] },
      file: { ...template.file, localizations: [{ locale: 'en-IN', title: 'Sheets sync', summary: '' }] },
    };
    vi.mocked(loadSystemPack).mockResolvedValue({ templates: [template, sheets] } as unknown as Formpack);
    const cases: Array<[string, Record<string, string> | null, boolean]> = [
      ['saas', { DEPLOYMENT_MODE: 'saas' }, true],
      ['on-prem with Sheets enabled', { DEPLOYMENT_MODE: 'onprem', INTEGRATIONS_ENABLED: 'google_sheets' }, true],
      ['on-prem', { DEPLOYMENT_MODE: 'onprem' }, false],
      ['air-gapped', { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' }, false],
      ['unknown', null, false],
    ];
    for (const [name, env, shown] of cases) {
      useEditionStore.setState({ summary: env ? editionSummary(loadEditionConfig(env)) : null, source: env ? 'server' : 'unknown' });
      const { unmount } = render(<TemplateGallery onUse={() => {}} onCancel={() => {}} />);
      expect(await screen.findByRole('button', { name: /^Event registration/ }), name).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Sheets sync/ }) !== null, name).toBe(shown);
      expect(screen.queryByText('1 template needs features this installation does not offer.') !== null, name).toBe(!shown);
      unmount();
    }
  });
});
