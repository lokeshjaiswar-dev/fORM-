import { visibilityOfBlock, xWithVisibility } from '@form/registry/profiles/dms-v1';
import type { FieldBlock } from '@form/schema';
import { ToggleRow } from '@/components/builder/inspector/parts';
import { useCanRevealFields } from '@/embed/master/revealContext';
import { updateBlock } from '@/state/actions';

/* Plain English, like the rest of the embed pages: the builder message catalog (packages/i18n) is not part of this lane's files. */
const TEXT = {
  hidden: 'Hidden field',
  hiddenHint: 'People who cannot reveal fields never see this field, in the form, in lists or in records. DMS keeps its values.',
  secret: 'Secret field',
  secretHint: 'Shown as \u2022\u2022\u2022\u2022\u2022\u2022 to everyone. The value can be replaced here but not read back.',
} as const;

/**
 * The two DMS visibility settings of a field (profile dms-v1, SEC-DESIGN 5.2-5.3): hidden and secret, stored as the first-class `x-dms`
 * keys `is_hidden` / `is_secret` and written to DMS with the field. Shown only when the signed-in user may change them
 * (`can.reveal_fields`: the master's creator, an owner or an administrator): dms-api refuses anyone else with FIELD_VISIBILITY_FORBIDDEN,
 * so for them the toggles are not offered at all. A non-revealer's save still carries the flags it was given, unchanged.
 */
export function DmsVisibilitySettings({ block }: { block: FieldBlock }) {
  const canReveal = useCanRevealFields();
  if (!canReveal) return null;
  const { hidden, secret } = visibilityOfBlock(block);
  return (
    <div className="space-y-4" data-testid="dms-visibility-settings">
      <ToggleRow label={TEXT.hidden} hint={TEXT.hiddenHint} checked={hidden} onChange={(on) => updateBlock(block.id, { x: xWithVisibility(block, { hidden: on }) })} />
      <ToggleRow label={TEXT.secret} hint={TEXT.secretHint} checked={secret} onChange={(on) => updateBlock(block.id, { x: xWithVisibility(block, { secret: on }) })} />
    </div>
  );
}
