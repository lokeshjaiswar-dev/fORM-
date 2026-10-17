import type { FormSettings } from '@/types/form';

export const defaultSettings = (): FormSettings => ({
  submitButtonText: 'Submit',
  successMessage: 'Thanks for your response!',
  themeColor: '#111111',
  backgroundColor: '#ffffff',
  textColor: '#111111',
  accentColor: '#2383e2',
  font: 'Inter',
  progressBar: false,
  redirectUrl: '',
  closed: false,
  closedMessage: 'This form is no longer accepting responses.',
  password: '',
  logoUrl: '',
  coverUrl: '',
  successAnimation: true,
});
