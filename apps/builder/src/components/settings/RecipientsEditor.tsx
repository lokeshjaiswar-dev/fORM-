import { useState } from 'react';
import { X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { EmailAddressSchema, type Recipient } from '@form/schema';
import { Button, Input } from '@dmacq/ui';
import { t } from '@/i18n';
import { NiceSelect } from '@/components/NiceSelect';
import { addRecipient, emailFields, fieldRecipient, memberRecipient, recipientKey, ROLE_RECIPIENTS, type DraftFacts, type RoleRecipient } from '@/components/settings/notificationsModel';
import type { OrgMember } from '@/persistence/notificationsApi';

const M = defineMessages('builder', {
  'recipients.label': 'Send to',
  'recipients.none': 'Nobody yet. The email is not sent until it has a recipient.',
  'recipients.address': 'Email address',
  'recipients.add_address': 'Add address',
  'recipients.bad_address': 'That is not an email address.',
  'recipients.add_member': 'Add a member',
  'recipients.add_member_placeholder': 'Add a member…',
  'recipients.add_role': 'Add a group',
  'recipients.add_role_placeholder': 'Add a group…',
  'recipients.role.form_owner': 'The form’s owner',
  'recipients.role.org_admins': 'The organisation’s owners and admins',
  'recipients.remove': 'Remove {who}',
  'recipients.unknown_member': 'A member who is no longer here',
  'recipients.unknown_field': 'A field that is no longer in the form',
  'recipients.email_field': 'Respondent’s email field',
  'recipients.email_field_placeholder': 'Choose the field that holds their email…',
  'recipients.email_field_hint': 'The email goes to the address the respondent typed in this field.',
  'recipients.no_email_field': 'The form has no email field. Add one in the builder, then come back here.',
  'recipients.external_hint': 'Anyone outside the people who can already read responses needs the data.route permission to be added.',
});

/** The text a recipient is shown as: an address, a member's name and email, a group, or the field it reads. */
function describe(r: Recipient, members: readonly OrgMember[], facts: DraftFacts): string {
  switch (r.kind) {
    case 'email':
      return r.address;
    case 'member': {
      const m = members.find((x) => x.userId === r.userId);
      return m ? (m.name ? `${m.name} (${m.email})` : m.email) : t(M['recipients.unknown_member']);
    }
    case 'field':
      return facts.fields.find((f) => f.id === r.blockId)?.label ?? t(M['recipients.unknown_field']);
    default:
      return r.role === 'form_owner' ? t(M['recipients.role.form_owner']) : r.role === 'org_admins' ? t(M['recipients.role.org_admins']) : r.role;
  }
}

interface Props {
  kind: 'owner' | 'autoresponder';
  value: readonly Recipient[];
  onChange: (next: Recipient[]) => void;
  members: readonly OrgMember[] | null;
  facts: DraftFacts;
}

/**
 * Who an email goes to. A reply to the respondent (an autoresponder) goes to one of the form's email fields: the address
 * the respondent typed in. An email to the team goes to fixed addresses, members of the org and groups (the form's owner,
 * the org's admins). The server decides what each needs: an address or a member who cannot already read responses is routing
 * answers outside, which takes `data.route` and is refused (403) without it.
 */
export function RecipientsEditor({ kind, value, onChange, members, facts }: Props) {
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState(false);
  const known = members ?? [];
  const taken = new Set(value.map(recipientKey));

  if (kind === 'autoresponder') {
    const fields = emailFields(facts);
    const current = value.find((r) => r.kind === 'field');
    return (
      <div className="space-y-1.5">
        <span className="block text-[13px] font-medium text-foreground">{t(M['recipients.email_field'])}</span>
        <div className="max-w-[360px]">
          <NiceSelect
            aria-label={t(M['recipients.email_field'])}
            placeholder={t(M['recipients.email_field_placeholder'])}
            value={current?.kind === 'field' ? current.blockId : ''}
            disabled={fields.length === 0}
            onChange={(id) => onChange([fieldRecipient(id)])}
            options={[
              ...(current?.kind === 'field' && !fields.some((f) => f.id === current.blockId) ? [{ value: current.blockId, label: describe(current, known, facts) }] : []),
              ...fields.map((f) => ({ value: f.id, label: f.label })),
            ]}
          />
        </div>
        <p className="text-[12px] text-muted-foreground">{fields.length === 0 ? t(M['recipients.no_email_field']) : t(M['recipients.email_field_hint'])}</p>
      </div>
    );
  }

  const addAddress = () => {
    const next = EmailAddressSchema.safeParse(address.trim());
    if (!next.success) {
      setAddressError(true);
      return;
    }
    onChange(addRecipient(value, { kind: 'email', address: next.data }));
    setAddress('');
    setAddressError(false);
  };

  const addable = known.filter((m) => m.status === 'active' && !taken.has(`member:${m.userId}`));
  const roles = ROLE_RECIPIENTS.filter((r) => !taken.has(`role:${r}`));

  return (
    <div className="space-y-2">
      <span className="block text-[13px] font-medium text-foreground">{t(M['recipients.label'])}</span>
      {value.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t(M['recipients.none'])}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((r) => {
            const who = describe(r, known, facts);
            return (
              <li key={recipientKey(r)} className="inline-flex max-w-full items-center gap-1 rounded bg-surface-subtle px-1.5 py-0.5 text-[13px]">
                <span className="truncate">{who}</span>
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1"
                  aria-label={t(M['recipients.remove'], { who })}
                  onClick={() => onChange(value.filter((x) => recipientKey(x) !== recipientKey(r)))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        noValidate
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addAddress();
        }}
      >
        <Input type="email" className="min-w-[220px] flex-1" aria-label={t(M['recipients.address'])} placeholder={t(M['recipients.address'])} value={address} maxLength={254} aria-invalid={addressError || undefined} onChange={(e) => { setAddress(e.target.value); setAddressError(false); }} />
        <Button type="submit" size="sm" variant="outline" disabled={address.trim() === ''}>
          {t(M['recipients.add_address'])}
        </Button>
      </form>
      {addressError ? (
        <p role="alert" className="text-[12px] text-destructive">
          {t(M['recipients.bad_address'])}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <div className="w-[240px]">
          <NiceSelect
            key={`member-${value.length}`}
            size="sm"
            aria-label={t(M['recipients.add_member'])}
            placeholder={t(M['recipients.add_member_placeholder'])}
            value=""
            disabled={addable.length === 0}
            onChange={(userId) => onChange(addRecipient(value, memberRecipient(userId)))}
            options={addable.map((m) => ({ value: m.userId, label: m.name ? `${m.name} (${m.email})` : m.email }))}
          />
        </div>
        <div className="w-[260px]">
          <NiceSelect
            key={`role-${value.length}`}
            size="sm"
            aria-label={t(M['recipients.add_role'])}
            placeholder={t(M['recipients.add_role_placeholder'])}
            value=""
            disabled={roles.length === 0}
            onChange={(role) => onChange(addRecipient(value, { kind: 'role', role: role as RoleRecipient }))}
            options={roles.map((r) => ({ value: r, label: t(r === 'form_owner' ? M['recipients.role.form_owner'] : M['recipients.role.org_admins']) }))}
          />
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">{t(M['recipients.external_hint'])}</p>
    </div>
  );
}
