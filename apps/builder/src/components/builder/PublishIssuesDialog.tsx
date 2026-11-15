import { useMemo } from 'react';
import { defineMessages } from '@form/i18n';
import type { BlockId } from '@form/schema';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dmacq/ui';
import { t } from '@/i18n';
import { blockText } from '@/lib/definition';
import type { PublishIssueView } from '@/persistence/publishApi';
import { currentDoc } from '@/state/documentStore';

const M = defineMessages('builder', {
  'publish.blocked_title': 'This form cannot be published yet',
  'publish.blocked_description': '{count, plural, one {# problem needs} other {# problems need}} fixing before this form can go live.',
  'publish.warnings_title': 'Publish with warnings?',
  'publish.warnings_description': 'These do not stop publishing, but they are worth a look first.',
  'publish.form_level': 'The form as a whole',
  'publish.untitled': 'Untitled block',
  'publish.error': 'Error',
  'publish.warning': 'Warning',
  'publish.go_to_field': 'Go to field',
  'publish.go_to_named': 'Go to field “{name}”',
  'publish.more': '{count, plural, one {# more problem is} other {# more problems are}} not shown.',
  'publish.anyway': 'Publish anyway',
  'publish.close': 'Close',
});

/** The block a JSON pointer such as `/blocks/<id>/config/pattern` points into, or null for a form-level path. */
function blockOfPath(path: string): string | null {
  const [, root, id] = path.split('/');
  return root === 'blocks' && id ? id.replaceAll('~1', '/').replaceAll('~0', '~') : null;
}

interface Group {
  /** The block id, or null for the issues that belong to the form as a whole. */
  blockId: string | null;
  issues: PublishIssueView[];
}

/** Issues grouped by the block they are about, in the order the server listed them; the form-level ones last. */
function groupIssues(issues: readonly PublishIssueView[]): Group[] {
  const groups = new Map<string | null, PublishIssueView[]>();
  for (const issue of issues) {
    const key = blockOfPath(issue.path);
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const wholeForm = groups.get(null);
  groups.delete(null);
  return [...[...groups].map(([blockId, list]) => ({ blockId, issues: list })), ...(wholeForm ? [{ blockId: null, issues: wholeForm }] : [])];
}

export interface PublishIssuesDialogProps {
  /** Null while the dialog is closed. */
  issues: PublishIssueView[] | null;
  /** How many issues the server found (it lists the first 200). */
  issueCount: number;
  /** An error is among them: the form cannot be published, and the dialog only lists what to fix. Without one it asks for confirmation. */
  blocked: boolean;
  busy?: boolean;
  onClose: () => void;
  /** Publish despite the warnings (only offered when nothing blocks). */
  onPublishAnyway: () => void;
  /** Selects the block and opens its inspector; false when the block is not in the document. */
  onGoToField: (blockId: BlockId) => void;
}

/**
 * What stops (or may trouble) a publish, grouped by block, each with a way to jump to the field (WP-1.07: unsafe
 * regex, a redirect that is not http(s), a logic cycle and the rest of the server's checks). With only warnings it is
 * the publish confirmation.
 */
export function PublishIssuesDialog({ issues, issueCount, blocked, busy = false, onClose, onPublishAnyway, onGoToField }: PublishIssuesDialogProps) {
  const groups = useMemo(() => (issues ? groupIssues(issues) : []), [issues]);
  const doc = currentDoc();
  const hidden = issues ? Math.max(0, issueCount - issues.length) : 0;

  return (
    <Dialog open={issues !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t(blocked ? M['publish.blocked_title'] : M['publish.warnings_title'])}</DialogTitle>
          <DialogDescription>
            {blocked
              ? t(M['publish.blocked_description'], { count: issues?.filter((i) => i.severity === 'error').length ?? 0 })
              : t(M['publish.warnings_description'])}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {groups.map((group) => {
            const block = group.blockId ? doc.blocks[group.blockId as BlockId] : undefined;
            const name = group.blockId === null ? t(M['publish.form_level']) : blockText(block) || t(M['publish.untitled']);
            return (
              <section key={group.blockId ?? 'form'} aria-label={name} className="rounded-[6px] border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate text-[14px] font-medium">
                    {name}
                    {block ? <span className="ml-1.5 text-[12px] font-normal text-text-subtle">{block.type}</span> : null}
                  </h3>
                  {block ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t(M['publish.go_to_named'], { name })}
                      onClick={() => onGoToField(group.blockId as BlockId)}
                    >
                      {t(M['publish.go_to_field'])}
                    </Button>
                  ) : null}
                </div>
                <ul className="mt-2 space-y-1.5 text-[14px]">
                  {group.issues.map((issue, i) => (
                    <li key={`${issue.code}-${issue.path}-${i}`}>
                      <span className={issue.severity === 'error' ? 'font-medium text-destructive' : 'font-medium text-muted-foreground'}>
                        {t(issue.severity === 'error' ? M['publish.error'] : M['publish.warning'])}
                      </span>
                      : {issue.message} <code className="text-[12px] text-text-subtle">{issue.code}</code>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {hidden > 0 ? <p className="text-[13px] text-muted-foreground">{t(M['publish.more'], { count: hidden })}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t(M['publish.close'])}
          </Button>
          {blocked ? null : (
            <Button type="button" disabled={busy} onClick={onPublishAnyway}>
              {t(M['publish.anyway'])}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
