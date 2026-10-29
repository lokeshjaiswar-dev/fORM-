import type { NamePart } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const AUTO: Partial<Record<NamePart, string>> = {
  prefix: 'honorific-prefix',
  first: 'given-name',
  middle: 'additional-name',
  last: 'family-name',
  suffix: 'honorific-suffix',
};

const LABELS = {
  prefix: 'name.prefix',
  first: 'name.first',
  middle: 'name.middle',
  last: 'name.last',
  suffix: 'name.suffix',
} as const;

export function FullName({ block, field }: ControlProps<'full_name'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const attrs = inputAttrs(field);
  const value = answer.value ?? {};
  const setPart = (part: NamePart, next: string) => {
    const merged = { ...value, [part]: next };
    const empty = block.config.parts.every((p) => !(merged[p] ?? '').trim());
    answer.set(empty ? undefined : merged);
  };
  return (
    <div className="fr-name">
      {block.config.parts.map((part) => {
        const label = block.config.sublabels?.[part] || t(MESSAGES[LABELS[part]]);
        const id = `${field.ids.input}-${part}`;
        return (
          <label key={part} className="fr-name-part" htmlFor={id}>
            <span>{label}</span>
            <input
              id={id}
              className="fr-input"
              type="text"
              autoComplete={AUTO[part]}
              value={value[part] ?? ''}
              placeholder={block.config.placeholders?.[part]}
              onChange={(e) => setPart(part, e.target.value)}
              onBlur={answer.onBlur}
              {...attrs}
            />
          </label>
        );
      })}
    </div>
  );
}
