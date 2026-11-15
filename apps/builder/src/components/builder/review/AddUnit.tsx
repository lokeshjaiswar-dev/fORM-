import { useState } from 'react';
import { Plus } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Button } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import { addUnit } from '@/components/builder/review/reviewActions';
import type { TargetOption } from '@/components/builder/review/reviewModel';

const M = defineMessages('builder', {
  'review_add.label': 'Part of the form to check',
  'review_add.placeholder': 'Choose a page or section break…',
  'review_add.button': 'Add review unit',
  'review_add.none': 'Every page and section break already has a review unit. Add a page, or a Section break field, to make another.',
});

/** Picks a page or a section break that has no unit yet and makes one from it. */
export function AddUnit({ options }: { options: TargetOption[] }) {
  const [choice, setChoice] = useState('');
  if (options.length === 0) return <p className="text-[12px] text-muted-foreground">{t(M['review_add.none'])}</p>;
  const picked = options.find((o) => o.value === choice);
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <NiceSelect
          // Radix keeps showing the last choice when the value goes back to none, so a unit that was added starts the select afresh.
          key={options.length}
          size="sm"
          aria-label={t(M['review_add.label'])}
          placeholder={t(M['review_add.placeholder'])}
          value={picked?.value ?? ''}
          onChange={setChoice}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={!picked}
        onClick={() => {
          if (!picked) return;
          addUnit(picked);
          setChoice('');
        }}
      >
        <Plus className="size-3.5" />
        {t(M['review_add.button'])}
      </Button>
    </div>
  );
}
