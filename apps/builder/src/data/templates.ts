import type { FormSchema } from '@/types/form';
import { createBlock } from '@/lib/fields';
import { defaultSettings } from '@/lib/defaultSettings';
import { uid } from '@/lib/utils';

function schema(
  title: string,
  description: string,
  types: Parameters<typeof createBlock>[0][],
  labels: string[],
): FormSchema {
  const blocks = types.map((type, i) => {
    const block = createBlock(type, i);
    block.label = labels[i] ?? block.label;
    return block;
  });

  return {
    id: uid(),
    title,
    description,
    blocks,
    settings: { ...defaultSettings(), successMessage: 'Thanks — we received your response.' },
  };
}

export const TEMPLATES: { id: string; name: string; description: string; schema: FormSchema }[] = [
  {
    id: 'contact',
    name: 'Contact Us',
    description: 'Name, email, and a message.',
    schema: schema(
      'Contact us',
      'We usually reply within one business day.',
      ['heading', 'paragraph', 'text', 'email', 'long_text'],
      ['Contact us', 'Tell us how we can help.', 'Full name', 'Email', 'Message'],
    ),
  },
  {
    id: 'feedback',
    name: 'Customer Feedback',
    description: 'Rating plus comments.',
    schema: schema(
      'How was your experience?',
      'Your feedback helps us improve.',
      ['heading', 'rating', 'multiple_choice', 'long_text', 'email'],
      ['Share your feedback', 'Overall rating', 'Would you recommend us?', 'What could be better?', 'Email (optional)'],
    ),
  },
  {
    id: 'event',
    name: 'Event Registration',
    description: 'RSVP with guest details.',
    schema: schema(
      'Event registration',
      'Reserve your seat.',
      ['heading', 'text', 'email', 'dropdown', 'number', 'date'],
      ['Join us', 'Full name', 'Email', 'Ticket type', 'Number of guests', 'Preferred date'],
    ),
  },
  {
    id: 'nps',
    name: 'NPS survey',
    description: 'Score, comment, and optional contact.',
    schema: schema(
      'How likely are you to recommend us?',
      'Takes about 30 seconds.',
      ['heading', 'nps', 'page_break', 'long_text', 'email'],
      ['Your feedback', 'Score from 0–10', 'What is the main reason for your score?', 'Email (optional)'],
    ),
  },
  {
    id: 'job',
    name: 'Job Application',
    description: 'Collect applicants and resumes.',
    schema: schema(
      'Apply to join the team',
      'We review every application.',
      ['heading', 'text', 'email', 'dropdown', 'long_text', 'file_upload'],
      ['Job application', 'Full name', 'Email', 'Role', 'Why you?', 'Resume'],
    ),
  },
];
