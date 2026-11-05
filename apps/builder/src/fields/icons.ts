import {
  AlignLeft, Briefcase, Calendar, CalendarClock, Camera, CheckSquare, ChevronDown, CircleDot, Clock, EyeOff, FilePlus, Files, Gauge, Globe, GraduationCap, Hash, Heading1, Heading2, Heading3, Link, ListFilter, ListPlus,
  ListOrdered, Mail, MapPin, Minus, Paperclip, PenLine, Phone, ShoppingCart, Smile, Square, Star, Table, Text, Type, User, UserPlus, Users, type LucideIcon,
} from 'lucide-react';

/*
 * The registry names a palette entry's icon (`PaletteEntry.icon`, a lucide name); this is the builder's view of
 * those names. A name the builder does not know falls back to a plain square, so a new registry entry never breaks
 * the palette.
 */

export const ICONS: Readonly<Record<string, LucideIcon>> = {
  'user': User,
  'users': Users,
  'map-pin': MapPin,
  'table': Table,
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
  'list-plus': ListPlus,
  'shopping-cart': ShoppingCart,
  'user-plus': UserPlus,
  'graduation-cap': GraduationCap,
  'briefcase': Briefcase,
  'files': Files,
  'calendar-clock': CalendarClock,
  'paperclip': Paperclip,
  'camera': Camera,
  'globe': Globe,
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
