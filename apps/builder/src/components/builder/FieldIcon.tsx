import {
  Calendar,
  CheckSquare,
  CircleDot,
  Heading,
  Mail,
  Paperclip,
  Star,
  Hash,
  Type,
  AlignLeft,
  ChevronDown,
  Text,
  Minus,
  FilePlus,
  PartyPopper,
  Phone,
  Link,
  PenLine,
  ListOrdered,
  Clock,
  Gauge,
  Smile,
  EyeOff,
  ListFilter,
} from 'lucide-react';
import type { FieldType } from '@/types/form';
import { cn } from '@/lib/utils';

const ICONS: Record<FieldType, typeof Type> = {
  heading: Heading,
  heading_2: Heading,
  heading_3: Heading,
  paragraph: Text,
  divider: Minus,
  page_break: FilePlus,
  thank_you: PartyPopper,
  text: Type,
  long_text: AlignLeft,
  email: Mail,
  number: Hash,
  phone: Phone,
  url: Link,
  signature: PenLine,
  dropdown: ChevronDown,
  multiple_choice: CircleDot,
  checkbox: CheckSquare,
  multi_select: ListFilter,
  date: Calendar,
  time: Clock,
  rating: Star,
  linear_scale: Gauge,
  nps: Smile,
  ranking: ListOrdered,
  file_upload: Paperclip,
  hidden: EyeOff,
};

const TILE: Record<FieldType, string> = {
  heading: 'bg-[#e3e2e0] text-[#787774]',
  heading_2: 'bg-[#e3e2e0] text-[#787774]',
  heading_3: 'bg-[#e3e2e0] text-[#787774]',
  paragraph: 'bg-[#eee9da] text-[#9f6b53]',
  divider: 'bg-[#e3e2e0] text-[#787774]',
  page_break: 'bg-[#d3e5ef] text-[#337ea9]',
  thank_you: 'bg-[#dbeddb] text-[#448361]',
  text: 'bg-[#d3e5ef] text-[#337ea9]',
  long_text: 'bg-[#d3e5ef] text-[#337ea9]',
  email: 'bg-[#fadec9] text-[#d9730d]',
  phone: 'bg-[#fadec9] text-[#d9730d]',
  url: 'bg-[#fadec9] text-[#d9730d]',
  signature: 'bg-[#f5e0e9] text-[#c14c8a]',
  number: 'bg-[#e8deee] text-[#9065b0]',
  dropdown: 'bg-[#dbeddb] text-[#448361]',
  multiple_choice: 'bg-[#dbeddb] text-[#448361]',
  checkbox: 'bg-[#dbeddb] text-[#448361]',
  multi_select: 'bg-[#dbeddb] text-[#448361]',
  date: 'bg-[#f5e0e9] text-[#c14c8a]',
  time: 'bg-[#f5e0e9] text-[#c14c8a]',
  rating: 'bg-[#fdecc8] text-[#dfab01]',
  linear_scale: 'bg-[#fdecc8] text-[#dfab01]',
  nps: 'bg-[#fdecc8] text-[#dfab01]',
  ranking: 'bg-[#e8deee] text-[#9065b0]',
  file_upload: 'bg-[#ffe2dd] text-[#d44c47]',
  hidden: 'bg-[#e3e2e0] text-[#787774]',
};

export function FieldTile({ type }: { type: FieldType }) {
  const Icon = ICONS[type];
  return (
    <span className={cn('inline-flex size-[22px] shrink-0 items-center justify-center rounded-[4px]', TILE[type])}>
      <Icon className="size-3.5" />
    </span>
  );
}
