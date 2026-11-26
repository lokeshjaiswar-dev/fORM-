export const token = (): string | null => document.cookie || localStorage.getItem('token');
