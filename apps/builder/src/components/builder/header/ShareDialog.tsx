import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from '@dmacq/ui';
import type { PublishState } from '@/components/builder/header/usePublish';

/** After Publish: the live link, or why the form could not be published, and a preview link that works without the API. */
export function ShareDialog({ state }: { state: PublishState }) {
  const { shareOpen, setShareOpen, link, error, copyLink, copyPreviewLink } = state;
  return (
    <Dialog open={shareOpen} onOpenChange={setShareOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{link ? 'Share form' : 'Publish form'}</DialogTitle>
          <DialogDescription>
            {link
              ? 'Anyone with this link can fill the form on a phone or another computer. They do not need to sign in.'
              : 'Publish this form to get a link you can open on any device.'}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-[14px] text-destructive">
            {error}
          </p>
        ) : null}
        {link ? (
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="Share link" />
            <Button type="button" onClick={() => void copyLink()}>
              Copy
            </Button>
          </div>
        ) : null}
        {/* Works without the API: the form travels inside the link, so a colleague on this network can try it. */}
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-[14px] font-medium">Preview link</p>
          <p className="text-[13px] text-muted-foreground">
            Opens a read-only copy of this form, as it is now, on any device on your network. Answers are not saved.
          </p>
          <Button type="button" variant="outline" onClick={() => void copyPreviewLink()}>
            Copy preview link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
