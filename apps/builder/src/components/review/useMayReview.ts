import { useEffect, useState } from 'react';
import { canReviewIn } from '@/persistence/reviewsApi';

/**
 * Whether the member's role in `org` grants `submissions.review` (WP-2.33), asked of the API (`GET /v1/org` lists what the role
 * grants) and false until it has answered, for another org than the one asked, and when it cannot be read: an entry that
 * leads to the review queue is shown only to someone the queue would answer, never on a guess.
 */
export function useMayReview(org: string | null): boolean {
  const [asked, setAsked] = useState<{ org: string; granted: boolean } | null>(null);
  useEffect(() => {
    if (org === null) return;
    let live = true;
    canReviewIn(org).then(
      (granted) => live && setAsked({ org, granted }),
      () => live && setAsked({ org, granted: false }),
    );
    return () => {
      live = false;
    };
  }, [org]);
  return org !== null && asked?.org === org && asked.granted;
}
