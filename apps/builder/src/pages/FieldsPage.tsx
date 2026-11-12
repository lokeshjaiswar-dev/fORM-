import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Shapes, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { BUILDER_LOCALE } from '@/i18n';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import { WorkspaceNav } from '@/components/WorkspaceNav';
import { customFields } from '@/fields/custom/repository';
import { useCustomFields } from '@/fields/custom/useCustomFields';
import type { CustomField } from '@/fields/custom/model';
import { tileOf } from '@/fields/tiles';

const M = defineMessages('builder', {
  'fields.title': 'Fields',
  'fields.new': 'New field',
  'fields.empty': 'No custom fields yet. Save a reusable field with its validation and settings.',
  'fields.unreadable': 'Saved fields could not be read.',
  'fields.delete_title': 'Delete this field?',
  'fields.delete_body': '“{name}” will be removed from this browser. Forms that already use it keep their copy.',
  'fields.delete': 'Delete field',
});

const dateTime = new Intl.DateTimeFormat(BUILDER_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function savedWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : ` · ${dateTime.format(at)}`;
}

export function FieldsPage() {
  const navigate = useNavigate();
  const { fields, error } = useCustomFields();
  const [removing, setRemoving] = useState<CustomField | null>(null);

  async function confirmDelete() {
    if (!removing) return;
    const id = removing.id;
    setRemoving(null);
    await customFields.remove(id);
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
      <WorkspaceNav />
      <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">{t(M['fields.title'])}</h1>
      <div className="mt-6">
        <Button onClick={() => navigate('/fields/new')}>
          <Plus /> {t(M['fields.new'])}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-[14px] text-destructive">
          {t(M['fields.unreadable'])}
        </p>
      ) : null}
      {fields === null ? null : fields.length === 0 ? (
        <p className="mt-10 text-[15px] text-muted-foreground">{t(M['fields.empty'])}</p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {fields.map((field) => (
            <li key={field.id} className="-mx-2 flex items-center gap-2 rounded-[6px] px-2 py-3 hover:bg-state-hover">
              <Link to={`/fields/${field.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <Shapes className="size-4 shrink-0 text-text-subtle" />
                <span className="min-w-0 flex-1 truncate text-[15px]">{field.name}</span>
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  {tileOf(field.baseType)?.label ?? field.baseType}
                  {savedWhen(field.updatedAt)}
                </span>
              </Link>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => setRemoving(field)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(M['fields.delete_title'])}</DialogTitle>
            <DialogDescription>{t(M['fields.delete_body'], { name: removing?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmDelete()}>
              {t(M['fields.delete'])}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
