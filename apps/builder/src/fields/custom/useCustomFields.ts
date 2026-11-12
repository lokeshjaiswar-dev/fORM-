import { useCallback, useEffect, useState } from 'react';
import { customFields, subscribeCustomFields } from '@/fields/custom/repository';
import type { CustomField } from '@/fields/custom/model';

export function useCustomFields(): { fields: CustomField[] | null; error: string | null; reload: () => void } {
  const [fields, setFields] = useState<CustomField[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    customFields.list().then(
      (list) => {
        setFields(list);
        setError(null);
      },
      () => setError('unreadable'),
    );
  }, []);

  useEffect(() => {
    reload();
    return subscribeCustomFields(reload);
  }, [reload]);

  return { fields, error, reload };
}
