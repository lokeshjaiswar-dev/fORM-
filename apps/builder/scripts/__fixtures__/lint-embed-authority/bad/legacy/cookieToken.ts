// the legacy modules may read cookies and localStorage (the M2 build), under the flag guard
export const token = (): string | null => document.cookie || localStorage.getItem('token');
