import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NiceSelect } from '@/components/ui/select';
import { useFormStore } from '@/store/useFormStore';

const PRESETS = ['#111111', '#2563eb', '#7c3aed', '#db2777', '#059669', '#ea580c'];
const FONTS = ['Inter', 'Georgia', 'Mono'] as const;

export function ThemeSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const settings = useFormStore((s) => s.form.settings);
  const updateSettings = useFormStore((s) => s.updateSettings);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize</DialogTitle>
          <DialogDescription>Theme and form settings, matching Tally’s Customize panel.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">Theme</p>
            <ColorRow label="Button" value={settings.themeColor} onChange={(themeColor) => updateSettings({ themeColor })} />
            <ColorRow label="Background" value={settings.backgroundColor} onChange={(backgroundColor) => updateSettings({ backgroundColor })} />
            <ColorRow label="Text" value={settings.textColor} onChange={(textColor) => updateSettings({ textColor })} />
            <ColorRow label="Accent" value={settings.accentColor} onChange={(accentColor) => updateSettings({ accentColor })} />
            <div className="space-y-1.5">
              <Label>Font</Label>
              <NiceSelect
                size="sm"
                value={settings.font}
                onChange={(font) => updateSettings({ font })}
                options={FONTS.map((f) => ({ value: f, label: f }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Logo URL</Label>
              <Input value={settings.logoUrl} onChange={(e) => updateSettings({ logoUrl: e.target.value })} placeholder="https://…" />
            </div>
            <div className="space-y-1.5">
              <Label>Cover image URL</Label>
              <Input value={settings.coverUrl} onChange={(e) => updateSettings({ coverUrl: e.target.value })} placeholder="https://…" />
            </div>
          </section>
          <section className="space-y-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">Form settings</p>
            <div className="space-y-1.5">
              <Label>Submit button</Label>
              <Input value={settings.submitButtonText} onChange={(e) => updateSettings({ submitButtonText: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Thank-you message</Label>
              <Input value={settings.successMessage} onChange={(e) => updateSettings({ successMessage: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Redirect after submit</Label>
              <Input value={settings.redirectUrl} onChange={(e) => updateSettings({ redirectUrl: e.target.value })} placeholder="https://…" />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="progress">Progress bar</Label>
              <Switch id="progress" checked={settings.progressBar} onCheckedChange={(progressBar) => updateSettings({ progressBar })} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="successAnimation">Confetti on submit</Label>
              <Switch
                id="successAnimation"
                checked={settings.successAnimation}
                onCheckedChange={(successAnimation) => updateSettings({ successAnimation })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="closed">Close form</Label>
              <Switch id="closed" checked={settings.closed} onCheckedChange={(closed) => updateSettings({ closed })} />
            </div>
            {settings.closed ? (
              <div className="space-y-1.5">
                <Label>Closed message</Label>
                <Input value={settings.closedMessage} onChange={(e) => updateSettings({ closedMessage: e.target.value })} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Password (optional)</Label>
              <Input type="password" value={settings.password} onChange={(e) => updateSettings({ password: e.target.value })} />
            </div>
          </section>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => updateSettings({ themeColor: c })}
                className="size-7 rounded-full border-2"
                style={{ background: c, borderColor: settings.themeColor === c ? '#111' : 'transparent' }}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-8 cursor-pointer rounded" />
        <Input className="w-28" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}
