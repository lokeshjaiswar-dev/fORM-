import { describe, expect, it } from 'vitest';
import { canReview, REVIEWER_ROLES } from './roles';

describe('who may check responses (WP-2.33)', () => {
  it('is owner, admin and editor, as the API grants submissions.review, and nobody else', () => {
    expect([...REVIEWER_ROLES]).toEqual(['owner', 'admin', 'editor']);
    for (const role of ['owner', 'admin', 'editor']) expect(canReview(role), role).toBe(true);
    for (const role of ['creator', 'data_collaborator', 'data_viewer', 'viewer', 'nonsense']) expect(canReview(role), role).toBe(false);
  });
});
