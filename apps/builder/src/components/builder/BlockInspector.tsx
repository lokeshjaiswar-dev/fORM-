import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { Input, Label } from '@/components/ui/input';
import { NiceSelect } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useFormStore } from '@/store/useFormStore';
import { uid } from '@/lib/utils';
import { isContentBlock } from '@/lib/fields';
import { patternError } from '@/lib/zodFromBlocks';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import type { LogicOperator } from '@/types/form';
import { LOGIC_OPERATORS, operatorNeedsValue } from '@/lib/logic';
import { labelText } from '@/lib/v1html';

const TABS = ['Customize', 'Logic', 'Validations'] as const;

export function BlockInspector() {
  const inspectorOpen = useFormStore((s) => s.inspectorOpen);
  const inspectorWidth = useFormStore((s) => s.inspectorWidth);
  const setInspectorWidth = useFormStore((s) => s.setInspectorWidth);
  const activeBlockId = useFormStore((s) => s.activeBlockId);
  const form = useFormStore((s) => s.form);
  const closeInspector = useFormStore((s) => s.closeInspector);
  const updateBlock = useFormStore((s) => s.updateBlock);
  const [resizing, setResizing] = useState(false);
  const block = form.blocks.find((b) => b.id === activeBlockId);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Customize');

  useEffect(() => {
    setTab('Customize');
  }, [activeBlockId]);

  const open = inspectorOpen && !!block;

  if (!block) {
    return <aside className="w-0 shrink-0 overflow-hidden border-l border-transparent" />;
  }

  const choice =
    block.type === 'dropdown' ||
    block.type === 'multiple_choice' ||
    block.type === 'checkbox' ||
    block.type === 'multi_select' ||
    block.type === 'ranking';
  const numeric = block.type === 'number' || block.type === 'text' || block.type === 'long_text';
  const otherFields = form.blocks.filter((b) => b.id !== block.id && !isContentBlock(b.type));

  function moveOption(from: number, to: number) {
    const options = [...(block!.options ?? [])];
    if (to < 0 || to >= options.length) return;
    const [item] = options.splice(from, 1);
    options.splice(to, 0, item);
    updateBlock(block!.id, { options });
  }

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-l bg-white',
        open ? 'border-[var(--notion-border)]' : 'border-transparent',
        !resizing && 'transition-[width,border-color] duration-300 ease-out',
      )}
      style={{ width: open ? inspectorWidth : 0 }}
    >
      <button
        type="button"
        aria-label="Resize settings"
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-zinc-300"
        onMouseDown={(e) => {
          e.preventDefault();
          setResizing(true);
          const startX = e.clientX;
          const startW = inspectorWidth;
          function move(ev: MouseEvent) {
            setInspectorWidth(startW + (startX - ev.clientX));
          }
          function up() {
            setResizing(false);
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          }
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: inspectorWidth }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">Block settings</h2>
          <p className="text-[12px] capitalize text-[var(--notion-text-muted)]">{block.type.replaceAll('_', ' ')}</p>
        </div>
        <Tooltip content="Close settings">
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-[4px] hover:bg-[var(--notion-hover)]"
            onClick={closeInspector}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
      </div>

      <div className="flex gap-1 border-b border-[var(--notion-border)] px-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-2 py-2 text-[12px] font-medium',
              tab === t
                ? 'border-[#111] text-[#111]'
                : 'border-transparent text-[var(--notion-text-muted)] hover:text-[#111]',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {tab === 'Validations' && (
          <>
            {isContentBlock(block.type) ? (
              <p className="text-[13px] text-[var(--notion-text-muted)]">Content blocks don’t have validation.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <Label htmlFor="required">Required</Label>
                  <Switch
                    id="required"
                    checked={!!block.validation?.required}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { validation: { ...block.validation, required: checked } })
                    }
                  />
                </div>
                {numeric && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={block.type === 'number' ? 'Min' : 'Min chars'}>
                      <Input
                        type="number"
                        value={block.validation?.min ?? ''}
                        onChange={(e) =>
                          updateBlock(block.id, {
                            validation: {
                              ...block.validation,
                              min: e.target.value === '' ? undefined : Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field label={block.type === 'number' ? 'Max' : 'Max chars'}>
                      <Input
                        type="number"
                        value={block.validation?.max ?? ''}
                        onChange={(e) =>
                          updateBlock(block.id, {
                            validation: {
                              ...block.validation,
                              max: e.target.value === '' ? undefined : Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                  </div>
                )}
                {(block.type === 'text' || block.type === 'long_text' || block.type === 'email') && (
                  <Field label="Pattern (regex)" error={patternError(block.validation?.pattern)}>
                    <Input
                      value={block.validation?.pattern ?? ''}
                      onChange={(e) =>
                        updateBlock(block.id, { validation: { ...block.validation, pattern: e.target.value || undefined } })
                      }
                      placeholder="e.g. ^[A-Z].+"
                    />
                  </Field>
                )}
                <Field label="Error message">
                  <Input
                    value={block.validation?.errorMessage ?? ''}
                    onChange={(e) =>
                      updateBlock(block.id, {
                        validation: { ...block.validation, errorMessage: e.target.value || undefined },
                      })
                    }
                    placeholder="This field is required"
                  />
                </Field>
              </>
            )}
          </>
        )}

        {tab === 'Logic' && (
          <>
            <div className="flex items-center justify-between">
              <Label htmlFor="logic">Conditional logic</Label>
              <Switch
                id="logic"
                checked={!!block.logic?.enabled}
                onCheckedChange={(checked) =>
                  updateBlock(block.id, { logic: { ...block.logic, enabled: checked, action: block.logic?.action ?? 'show' } })
                }
              />
            </div>
            {block.logic?.enabled && (
              <>
                <Field label="This block should">
                  <NiceSelect
                    size="sm"
                    value={block.logic.action ?? 'show'}
                    onChange={(action) =>
                      updateBlock(block.id, { logic: { ...block.logic, action: action as 'show' | 'hide' } })
                    }
                    options={[
                      { value: 'show', label: 'Show' },
                      { value: 'hide', label: 'Hide' },
                    ]}
                  />
                </Field>
                <Field label="When">
                  <NiceSelect
                    size="sm"
                    value={block.logic.sourceBlockId ?? ''}
                    onChange={(sourceBlockId) => updateBlock(block.id, { logic: { ...block.logic, sourceBlockId } })}
                    placeholder="Select a question"
                    options={otherFields.map((b) => ({
                      value: b.id,
                      label: labelText(b.label) || b.type,
                    }))}
                  />
                </Field>
                <Field label="Operator">
                  <NiceSelect
                    size="sm"
                    value={block.logic.operator ?? 'equals'}
                    onChange={(operator) =>
                      updateBlock(block.id, { logic: { ...block.logic, operator: operator as LogicOperator } })
                    }
                    options={LOGIC_OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Field>
                {operatorNeedsValue(block.logic.operator) && (
                  <Field label="Value">
                    <Input
                      value={block.logic.value ?? ''}
                      onChange={(e) => updateBlock(block.id, { logic: { ...block.logic, value: e.target.value } })}
                    />
                  </Field>
                )}
              </>
            )}
            {!block.logic?.enabled && (
              <p className="text-[13px] leading-relaxed text-[var(--notion-text-muted)]">
                Show or hide this block based on answers to earlier questions.
              </p>
            )}
          </>
        )}

        {tab === 'Customize' && (
          <>
            <Field label="Block width">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1">
                {(['full', 'half'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={cn(
                      'rounded-md px-2 py-1.5 text-[13px] font-medium capitalize',
                      (block.customize?.width ?? 'full') === w ? 'bg-white shadow-sm' : 'text-zinc-500 hover:text-[#111]',
                    )}
                    onClick={() => {
                      updateBlock(block.id, { customize: { ...block.customize, width: w, besidePrevious: false } });
                      if (w === 'full') {
                        const next = form.blocks[form.blocks.findIndex((b) => b.id === block.id) + 1];
                        if (next?.customize?.besidePrevious) {
                          updateBlock(next.id, { customize: { ...next.customize, besidePrevious: false } });
                        }
                      }
                    }}
                  >
                    {w}
                  </button>
                ))}
              </div>
              <p className="pt-1 text-[12px] text-[var(--notion-text-muted)]">
                Half keeps this field on its own row. Drag another field onto it to sit beside it.
              </p>
            </Field>
            {!isContentBlock(block.type) && (
              <>
                <Field label="Placeholder">
                  <Input
                    value={block.placeholder ?? ''}
                    onChange={(e) => updateBlock(block.id, { placeholder: e.target.value })}
                    placeholder="Shown inside the input"
                  />
                </Field>
                <Field label="Helper text">
                  <Input value={block.helpText ?? ''} onChange={(e) => updateBlock(block.id, { helpText: e.target.value })} placeholder="Hint below the question" />
                </Field>
                <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Look</p>
                <ColorField
                  label="Question color"
                  value={block.customize?.labelColor ?? '#111111'}
                  onChange={(labelColor) => updateBlock(block.id, { customize: { ...block.customize, labelColor } })}
                />
                <ColorField
                  label="Answer color"
                  value={block.customize?.inputTextColor ?? '#111111'}
                  onChange={(inputTextColor) => updateBlock(block.id, { customize: { ...block.customize, inputTextColor } })}
                />
                <ColorField
                  label="Input background"
                  value={block.customize?.inputBg ?? '#ffffff'}
                  onChange={(inputBg) => updateBlock(block.id, { customize: { ...block.customize, inputBg } })}
                />
                <ColorField
                  label="Border"
                  value={block.customize?.borderColor ?? '#e4e4e7'}
                  onChange={(borderColor) => updateBlock(block.id, { customize: { ...block.customize, borderColor } })}
                />
                <ColorField
                  label="Placeholder color"
                  value={block.customize?.placeholderColor ?? '#a1a1aa'}
                  onChange={(placeholderColor) => updateBlock(block.id, { customize: { ...block.customize, placeholderColor } })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Question size">
                    <Input
                      type="number"
                      min={12}
                      max={48}
                      value={block.customize?.labelSize ?? 22}
                      onChange={(e) =>
                        updateBlock(block.id, { customize: { ...block.customize, labelSize: Number(e.target.value) || 22 } })
                      }
                    />
                  </Field>
                  <Field label="Input size">
                    <Input
                      type="number"
                      min={12}
                      max={24}
                      value={block.customize?.inputSize ?? 15}
                      onChange={(e) =>
                        updateBlock(block.id, { customize: { ...block.customize, inputSize: Number(e.target.value) || 15 } })
                      }
                    />
                  </Field>
                </div>
                <Field label="Question weight">
                  <NiceSelect
                    size="sm"
                    value={block.customize?.labelWeight ?? 'semibold'}
                    onChange={(labelWeight) =>
                      updateBlock(block.id, {
                        customize: { ...block.customize, labelWeight: labelWeight as 'normal' | 'medium' | 'semibold' | 'bold' },
                      })
                    }
                    options={[
                      { value: 'normal', label: 'Regular' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'semibold', label: 'Semibold' },
                      { value: 'bold', label: 'Bold' },
                    ]}
                  />
                </Field>
                <Field label="Align">
                  <NiceSelect
                    size="sm"
                    value={block.customize?.align ?? 'left'}
                    onChange={(align) =>
                      updateBlock(block.id, { customize: { ...block.customize, align: align as 'left' | 'center' } })
                    }
                    options={[
                      { value: 'left', label: 'Left' },
                      { value: 'center', label: 'Center' },
                    ]}
                  />
                </Field>
                <Field label="Default value">
                  <Input
                    value={block.customize?.defaultValue ?? ''}
                    onChange={(e) =>
                      updateBlock(block.id, { customize: { ...block.customize, defaultValue: e.target.value } })
                    }
                  />
                </Field>
                <Field label="Prefix">
                  <Input
                    value={block.customize?.prefix ?? ''}
                    onChange={(e) => updateBlock(block.id, { customize: { ...block.customize, prefix: e.target.value } })}
                    placeholder="$"
                  />
                </Field>
                <Field label="Suffix">
                  <Input
                    value={block.customize?.suffix ?? ''}
                    onChange={(e) => updateBlock(block.id, { customize: { ...block.customize, suffix: e.target.value } })}
                    placeholder="kg"
                  />
                </Field>
                <div className="flex items-center justify-between">
                  <Label htmlFor="hideLabel">Hide label</Label>
                  <Switch
                    id="hideLabel"
                    checked={!!block.customize?.hideLabel}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { customize: { ...block.customize, hideLabel: checked } })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="disabled">Disabled</Label>
                  <Switch
                    id="disabled"
                    checked={!!block.customize?.disabled}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { customize: { ...block.customize, disabled: checked } })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="autoFocus">Autofocus</Label>
                  <Switch
                    id="autoFocus"
                    checked={!!block.customize?.autoFocus}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { customize: { ...block.customize, autoFocus: checked } })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="showCharCount">Character count</Label>
                  <Switch
                    id="showCharCount"
                    checked={!!block.customize?.showCharCount}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { customize: { ...block.customize, showCharCount: checked } })
                    }
                  />
                </div>
              </>
            )}
            {(block.type === 'rating' || block.type === 'linear_scale' || block.type === 'nps') && (
              <>
                {block.type === 'rating' && (
                  <Field label="Max stars">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={block.customize?.ratingMax ?? 5}
                      onChange={(e) =>
                        updateBlock(block.id, {
                          customize: { ...block.customize, ratingMax: Math.min(10, Math.max(1, Math.round(Number(e.target.value)) || 5)) },
                        })
                      }
                    />
                  </Field>
                )}
                {block.type === 'linear_scale' && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Scale min">
                        <Input
                          type="number"
                          value={block.customize?.scaleMin ?? 1}
                          onChange={(e) =>
                            updateBlock(block.id, { customize: { ...block.customize, scaleMin: Number(e.target.value) } })
                          }
                        />
                      </Field>
                      <Field label="Scale max">
                        <Input
                          type="number"
                          value={block.customize?.scaleMax ?? 5}
                          onChange={(e) =>
                            updateBlock(block.id, { customize: { ...block.customize, scaleMax: Number(e.target.value) } })
                          }
                        />
                      </Field>
                    </div>
                    <Field label="Min label">
                      <Input
                        value={block.customize?.scaleMinLabel ?? ''}
                        onChange={(e) =>
                          updateBlock(block.id, { customize: { ...block.customize, scaleMinLabel: e.target.value } })
                        }
                      />
                    </Field>
                    <Field label="Max label">
                      <Input
                        value={block.customize?.scaleMaxLabel ?? ''}
                        onChange={(e) =>
                          updateBlock(block.id, { customize: { ...block.customize, scaleMaxLabel: e.target.value } })
                        }
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            {choice && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Options</Label>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[12px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]"
                    onClick={() => {
                      const n = (block.options?.length ?? 0) + 1;
                      updateBlock(block.id, {
                        options: [...(block.options ?? []), { id: uid(), label: `Option ${n}`, value: `option_${n}` }],
                      });
                    }}
                  >
                    <Plus className="size-3" /> Add
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {(block.options ?? []).map((opt, i) => (
                    <li key={opt.id} className="flex items-center gap-1">
                      <div className="flex flex-col">
                        <button type="button" onClick={() => moveOption(i, i - 1)}>
                          <ChevronUp className="size-3" />
                        </button>
                        <button type="button" onClick={() => moveOption(i, i + 1)}>
                          <ChevronDown className="size-3" />
                        </button>
                      </div>
                      <Input
                        value={opt.label}
                        onChange={(e) => {
                          const options = (block.options ?? []).map((o, idx) =>
                            idx === i
                              ? { ...o, label: e.target.value, value: e.target.value.toLowerCase().replace(/\s+/g, '_') }
                              : o,
                          );
                          updateBlock(block.id, { options });
                        }}
                      />
                      <button
                        type="button"
                        className="flex size-7 items-center justify-center rounded-[4px] text-[var(--notion-text-muted)] hover:bg-red-50 hover:text-red-500"
                        onClick={() =>
                          updateBlock(block.id, { options: (block.options ?? []).filter((o) => o.id !== opt.id) })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                    </ul>
                <div className="flex items-center justify-between">
                  <Label htmlFor="otherOption">Other option</Label>
                  <Switch
                    id="otherOption"
                    checked={!!block.customize?.otherOption}
                    onCheckedChange={(checked) =>
                      updateBlock(block.id, { customize: { ...block.customize, otherOption: checked } })
                    }
                  />
                </div>
              </div>
            )}
            {block.type === 'file_upload' && (
              <div className="flex items-center justify-between">
                <Label htmlFor="allowMultiple">Allow multiple files</Label>
                <Switch
                  id="allowMultiple"
                  checked={!!block.customize?.allowMultiple}
                  onCheckedChange={(checked) =>
                    updateBlock(block.id, { customize: { ...block.customize, allowMultiple: checked } })
                  }
                />
              </div>
            )}
            {isContentBlock(block.type) && (
              <>
                <p className="text-[13px] text-[var(--notion-text-muted)]">Edit the copy on the page. Style it here.</p>
                <ColorField
                  label="Text color"
                  value={block.customize?.labelColor ?? '#111111'}
                  onChange={(labelColor) => updateBlock(block.id, { customize: { ...block.customize, labelColor } })}
                />
                <Field label="Size">
                  <Input
                    type="number"
                    min={12}
                    max={64}
                    value={block.customize?.labelSize ?? (block.type === 'heading' ? 32 : 16)}
                    onChange={(e) =>
                      updateBlock(block.id, { customize: { ...block.customize, labelSize: Number(e.target.value) || 16 } })
                    }
                  />
                </Field>
                <Field label="Align">
                  <NiceSelect
                    size="sm"
                    value={block.customize?.align ?? 'left'}
                    onChange={(align) =>
                      updateBlock(block.id, { customize: { ...block.customize, align: align as 'left' | 'center' } })
                    }
                    options={[
                      { value: 'left', label: 'Left' },
                      { value: 'center', label: 'Center' },
                    ]}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </div>
      </div>
    </aside>
  );
}

function Field({ label, error, children }: { label: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[12px] text-[var(--notion-text-muted)]">{label}</Label>
      {children}
      {error ? <p className="text-[12px] text-[#eb5757]">{error}</p> : null}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-[12px] text-[var(--notion-text-muted)]">{label}</Label>
      <div className="flex items-center gap-1.5">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-7 cursor-pointer rounded border border-zinc-200" />
        <Input className="w-[92px]" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}
