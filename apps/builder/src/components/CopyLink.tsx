import { useEffect, useRef, useState, type ReactNode } from 'react';
import { defineMessages } from '@form/i18n';
import { Button, Input } from '@dmacq/ui';
import { t } from '@/i18n';
import { clipboardAvailable, copyText } from '@/lib/copyText';
import { modKey } from '@/components/Tooltip';

const M = defineMessages('builder', {
  'copy_link.copy': 'Copy',
  'copy_link.copied': 'Copied',
  'copy_link.hint': 'Press {key}+C to copy the link.',
});

/**
 * A link in a read-only field with a Copy button. When the browser has no Clipboard API (plain http on a LAN IP) or
 * refuses it, the link stays selected in the field with a "Press Ctrl+C to copy" hint, so the person can copy it by hand.
 */
export function CopyLink({ link, label, copyLabel, icon, compact, onCopied }: {
  link: string;
  /** Accessible name of the field. */
  label: string;
  /** Text of the button; defaults to "Copy". */
  copyLabel?: string;
  icon?: ReactNode;
  /** A small outlined button, for a link shown inside a notice. */
  compact?: boolean;
  onCopied?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState(() => !clipboardAvailable());
  const [copied, setCopied] = useState(false);

  const select = () => {
    input.current?.focus();
    input.current?.select();
  };

  /* Without a clipboard the link is the thing to act on: select it as soon as it shows (and again when it changes). */
  useEffect(() => {
    setCopied(false);
    if (manual) select();
  }, [link, manual]);

  async function copy() {
    if (manual) {
      select();
      return;
    }
    if (await copyText(link)) {
      setCopied(true);
      onCopied?.();
    } else {
      setManual(true);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input ref={input} readOnly value={link} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" {...(compact ? { size: 'sm', variant: 'outline' } : {})} onClick={() => void copy()}>
          {icon}
          {copied ? t(M['copy_link.copied']) : (copyLabel ?? t(M['copy_link.copy']))}
        </Button>
      </div>
      {manual ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          {t(M['copy_link.hint'], { key: modKey() })}
        </p>
      ) : null}
    </div>
  );
}
