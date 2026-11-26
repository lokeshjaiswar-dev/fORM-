import { toast } from 'sonner';
import { CopyLink } from '@/components/CopyLink';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dmacq/ui';
import type { PublishState } from '@/components/builder/header/usePublish';

/** After Publish: the live link, or why the form could not be published. */
export function ShareDialog({ state }: { state: PublishState }) {
  const { shareOpen, setShareOpen, link, error, clearError } = state;
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
          <CopyLink
            link={link}
            label="Share link"
            onCopied={() => {
              clearError();
              toast('Link copied');
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
