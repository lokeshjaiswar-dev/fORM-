import { useEffect, useState } from 'react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Badge, Button, Field, Input } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import { FormError } from '@/pages/auth/AuthLayout';
import { problemText, submit } from '@/pages/auth/util';
import {
  REVIEWER_ROLES,
  addReviewGroupMember,
  createReviewGroup,
  listReviewGroups,
  removeReviewGroupMember,
  updateReviewGroup,
  type MemberRow,
  type ReviewGroup,
} from './orgApi';
import { roleLabel } from './roles';

const M = defineMessages('builder', {
  'review_groups.title': 'Review groups',
  'review_groups.hint': 'A review group is a set of checkers. In a form’s settings you give each part of the form to a group, and one of its members approves or rejects that part.',
  'review_groups.loading': 'Loading review groups…',
  'review_groups.none': 'No review groups yet.',
  'review_groups.name': 'Group name',
  'review_groups.create': 'Create group',
  'review_groups.archived': 'Archived',
  'review_groups.no_members': 'No members yet.',
  'review_groups.cannot_review': 'Cannot review',
  'review_groups.rename_button': 'Rename',
  'review_groups.rename': 'Rename {name}',
  'review_groups.rename_field': 'New name for {name}',
  'review_groups.rename_save': 'Save name',
  'review_groups.rename_cancel': 'Cancel',
  'review_groups.archive_button': 'Archive',
  'review_groups.restore_button': 'Restore',
  'review_groups.archive': 'Archive {name}',
  'review_groups.restore': 'Restore {name}',
  'review_groups.remove_member': 'Remove {email} from {name}',
  'review_groups.remove': 'Remove',
  'review_groups.add_member': 'Add a member to {name}',
  'review_groups.add_placeholder': 'Add a checker…',
  'review_groups.checkers_only': 'Only owners, admins and editors can be checkers.',
});

/** The members who could be added to `group`: active, in a role that can review, and not in it yet. The API decides (422); this only keeps the list short. */
function addable(members: readonly MemberRow[], group: ReviewGroup): MemberRow[] {
  const inGroup = new Set(group.members.map((m) => m.userId));
  return members.filter((m) => m.status === 'active' && REVIEWER_ROLES.includes(m.role) && !inGroup.has(m.userId));
}

/**
 * The org's review groups (WP-2.33): list, create, rename, archive and bring back, and who is in each. Shown to those who
 * manage members; the API repeats that check on every call. Loading them is separate from the member list, so a refusal
 * here never hides the members.
 */
export function ReviewGroups({ members }: { members: readonly MemberRow[] }) {
  const [groups, setGroups] = useState<ReviewGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  // The member list reloads after a role change or a removal, and `canReview` of a group's members follows the role: ask again.
  useEffect(() => {
    let live = true;
    listReviewGroups({ includeArchived: true }).then(
      (all) => live && setGroups(all),
      (err: unknown) => live && setError(problemText(err)),
    );
    return () => {
      live = false;
    };
  }, [members]);

  /** Runs one change, then shows what the server now holds (a group the call returned replaces its row). */
  async function run(work: () => Promise<ReviewGroup | void>) {
    setBusy(true);
    setError(null);
    try {
      const changed = await work();
      if (changed) setGroups((all) => (all ?? []).map((g) => (g.id === changed.id ? changed : g)));
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(async () => {
      const made = await createReviewGroup(name.trim());
      setName('');
      setGroups((all) => [...(all ?? []), made].sort((a, b) => a.name.localeCompare(b.name)));
    });

  const rename = (group: ReviewGroup, next: string) =>
    run(async () => {
      const changed = await updateReviewGroup(group.id, { name: next.trim() });
      setRenaming(null);
      return changed;
    });

  /** The API answers 204, so the row is the group without that member. */
  const takeOut = (group: ReviewGroup, userId: string) =>
    run(async () => {
      await removeReviewGroupMember(group.id, userId);
      return { ...group, members: group.members.filter((m) => m.userId !== userId) };
    });

  return (
    <section aria-label={t(M['review_groups.title'])} className="mt-8">
      <h2 className="text-[15px] font-semibold">{t(M['review_groups.title'])}</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{t(M['review_groups.hint'])}</p>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submit(() => void create())}>
        <div className="min-w-[220px] flex-1">
          <Field label={t(M['review_groups.name'])}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" />
          </Field>
        </div>
        <Button type="submit" disabled={busy || name.trim() === ''}>
          {t(M['review_groups.create'])}
        </Button>
      </form>
      <div className="mt-3">
        <FormError message={error} />
      </div>
      {groups === null ? (
        error ? null : <p className="mt-2 text-[14px] text-muted-foreground">{t(M['review_groups.loading'])}</p>
      ) : groups.length === 0 ? (
        <p className="mt-2 text-[14px] text-muted-foreground">{t(M['review_groups.none'])}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {groups.map((g) => {
            const archived = g.archivedAt !== null;
            const options = addable(members, g);
            return (
              <li key={g.id} className="space-y-2 py-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-3">
                  {renaming?.id === g.id ? (
                    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={submit(() => void rename(g, renaming.name))}>
                      <Input
                        aria-label={t(M['review_groups.rename_field'], { name: g.name })}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                        maxLength={120}
                        required
                        autoFocus
                      />
                      <Button type="submit" size="sm" disabled={busy || renaming.name.trim() === ''}>
                        {t(M['review_groups.rename_save'])}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        {t(M['review_groups.rename_cancel'])}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                      {archived ? (
                        <Badge variant="warning" size="sm">
                          {t(M['review_groups.archived'])}
                        </Badge>
                      ) : null}
                      <Button size="sm" variant="ghost" disabled={busy} aria-label={t(M['review_groups.rename'], { name: g.name })} onClick={() => setRenaming({ id: g.id, name: g.name })}>
                        {t(M['review_groups.rename_button'])}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={t(archived ? M['review_groups.restore'] : M['review_groups.archive'], { name: g.name })}
                        onClick={() => void run(() => updateReviewGroup(g.id, { archived: !archived }))}
                      >
                        {t(archived ? M['review_groups.restore_button'] : M['review_groups.archive_button'])}
                      </Button>
                    </>
                  )}
                </div>
                {g.members.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t(M['review_groups.no_members'])}</p>
                ) : (
                  <ul className="space-y-1">
                    {g.members.map((m) => (
                      <li key={m.userId} className="flex flex-wrap items-center gap-3 text-[13px]">
                        <span className="min-w-0 flex-1 truncate">
                          {m.name ?? m.email} <span className="text-muted-foreground">{m.name ? m.email : ''}</span>
                        </span>
                        <span className="text-muted-foreground">{roleLabel(m.role)}</span>
                        {m.canReview ? null : (
                          <Badge variant="warning" size="sm">
                            {t(M['review_groups.cannot_review'])}
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          aria-label={t(M['review_groups.remove_member'], { email: m.email, name: g.name })}
                          onClick={() => void takeOut(g, m.userId)}
                        >
                          {t(M['review_groups.remove'])}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {!archived ? (
                  <div className="max-w-[320px]">
                    <NiceSelect
                      // The select never holds a choice: a member who was added is gone from its options, so it starts afresh.
                      key={g.members.length}
                      size="sm"
                      aria-label={t(M['review_groups.add_member'], { name: g.name })}
                      placeholder={t(M['review_groups.add_placeholder'])}
                      value=""
                      disabled={busy || options.length === 0}
                      onChange={(userId) => void run(() => addReviewGroupMember(g.id, userId))}
                      options={options.map((m) => ({ value: m.userId, label: m.name ? `${m.name} (${m.email})` : m.email }))}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[12px] text-muted-foreground">{t(M['review_groups.checkers_only'])}</p>
    </section>
  );
}
