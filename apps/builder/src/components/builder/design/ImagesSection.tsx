import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { THEME_SCENES } from '@form/renderer';
import type { AssetId, HexColor, Theme, ThemeTokens } from '@form/schema';
import { Button, Label } from '@dmacq/ui';
import { t } from '@/i18n';
import { uid } from '@/lib/utils';
import { fileToThemeImage, storeThemeImage } from '@/components/builder/design/uploads';

const M = defineMessages('builder', {
  'design.backgrounds': 'Page background',
  'design.covers': 'Cover image',
  'design.none': 'None',
  'design.upload': 'Upload',
  'design.upload_failed': 'That file could not be used. Try a JPG or PNG.',
  'design.cover_height': 'Cover height',
  'design.fit_cover': 'Fill',
  'design.fit_contain': 'Fit',
});

const ref = (id: string) => ({ assetId: id as AssetId, decorative: true as const });

export function ImagesSection({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const tokens = theme.tokens;
  const bg = tokens.background?.kind === 'image' ? tokens.background.image.assetId : undefined;
  const cover = tokens.cover?.image.assetId;
  const [error, setError] = useState('');

  const patch = (partial: Partial<ThemeTokens>, dropCover = false) => {
    const next = { ...tokens, ...partial };
    if (dropCover) delete next.cover;
    onChange({ ...theme, tokens: next });
  };
  const pageColor = (typeof tokens.colors.page === 'string' ? tokens.colors.page : '#e8eefc') as HexColor;

  const upload = async (file: File | undefined, kind: 'background' | 'cover') => {
    if (!file) return;
    setError('');
    try {
      const url = await fileToThemeImage(file);
      const id = uid();
      storeThemeImage(id, url);
      if (kind === 'background') patch({ background: { kind: 'image', image: ref(id), fit: 'cover' } });
      else patch({ cover: { image: ref(id), heightPx: tokens.cover?.heightPx ?? 220 } });
    } catch {
      setError(t(M['design.upload_failed']));
    }
  };

  return (
    <div className="space-y-5">
      <SceneRow
        label={t(M['design.backgrounds'])}
        selected={bg}
        onSelect={(id) => patch({ background: id ? { kind: 'image', image: ref(id), fit: tokens.background?.kind === 'image' ? tokens.background.fit : 'cover' } : { kind: 'color', color: pageColor } })}
        onUpload={(file) => void upload(file, 'background')}
      />
      {tokens.background?.kind === 'image' ? (
        <div className="flex gap-2">
          {(['cover', 'contain'] as const).map((fit) => (
            <Button key={fit} type="button" size="sm" variant={tokens.background?.kind === 'image' && tokens.background.fit === fit ? 'default' : 'secondary'} onClick={() => tokens.background?.kind === 'image' && patch({ background: { ...tokens.background, fit } })}>
              {fit === 'cover' ? t(M['design.fit_cover']) : t(M['design.fit_contain'])}
            </Button>
          ))}
        </div>
      ) : null}
      <SceneRow
        label={t(M['design.covers'])}
        selected={cover}
        onSelect={(id) => (id ? patch({ cover: { image: ref(id), heightPx: tokens.cover?.heightPx ?? 220 } }) : patch({}, true))}
        onUpload={(file) => void upload(file, 'cover')}
      />
      {tokens.cover ? (
        <div className="space-y-1.5">
          <Label className="text-sidebar-foreground/80">{t(M['design.cover_height'])}</Label>
          <input
            type="range"
            min={80}
            max={420}
            aria-label={t(M['design.cover_height'])}
            value={tokens.cover.heightPx}
            onChange={(e) => tokens.cover && patch({ cover: { ...tokens.cover, heightPx: Number(e.target.value) } })}
            className="w-full"
          />
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-red-300">{error}</p> : null}
    </div>
  );
}

function SceneRow({ label, selected, onSelect, onUpload }: { label: string; selected?: string; onSelect: (id: string | null) => void; onUpload: (file: File | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section>
      <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-sidebar-muted">{label}</p>
      <div className="grid grid-cols-4 gap-2">
        <Button type="button" variant="outline" size="default" aria-pressed={!selected} pressed={!selected} onClick={() => onSelect(null)} className="aspect-[4/3] h-auto w-full flex-col">
          {t(M['design.none'])}
        </Button>
        {THEME_SCENES.map((scene) => (
          <Button key={scene.id} type="button" variant="outline" aria-label={scene.name} pressed={selected === scene.id} onClick={() => onSelect(scene.id)} className="aspect-[4/3] h-auto w-full overflow-hidden p-0">
            <img alt="" src={scene.url} className="h-full w-full object-cover" />
          </Button>
        ))}
        <Button type="button" variant="outline" aria-label={t(M['design.upload'])} onClick={() => input.current?.click()} className="aspect-[4/3] h-auto w-full flex-col gap-1 border-dashed">
          <ImagePlus className="size-4" />
          {t(M['design.upload'])}
        </Button>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />
    </section>
  );
}
