import {
  AlignLeft, Calendar, CheckSquare, ChevronDown, CircleDot, Clock, EyeOff, FilePlus, Gauge, Hash, Heading1, Heading2, Heading3, Link, ListFilter,
  ListOrdered, Mail, Minus, Paperclip, PenLine, Phone, Smile, Square, Star, Text, Type, type LucideIcon,
} from 'lucide-react';

/*
 * The registry names a palette entry's icon (`PaletteEntry.icon`, a lucide name); this is the builder's view of
 * those names. A name the builder does not know falls back to a plain square, so a new registry entry never breaks
 * the palette.
 */

export const ICONS: Readonly<Record<string, LucideIcon>> = {
  'type': Type,
  'align-left': AlignLeft,
  'mail': Mail,
  'phone': Phone,
  'hash': Hash,
  'link': Link,
  'circle-dot': CircleDot,
  'chevron-down': ChevronDown,
  'check-square': CheckSquare,
  'list-filter': ListFilter,
  'calendar': Calendar,
  'clock': Clock,
  'star': Star,
  'gauge': Gauge,
  'smile': Smile,
  'list-ordered': ListOrdered,
  'paperclip': Paperclip,
  'pen-line': PenLine,
  'eye-off': EyeOff,
  'heading-1': Heading1,
  'heading-2': Heading2,
  'heading-3': Heading3,
  'text': Text,
  'minus': Minus,
  'file-plus': FilePlus,
};

export const iconFor = (name: string): LucideIcon => ICONS[name] ?? Square;
