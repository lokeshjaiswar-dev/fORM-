import { createContext } from 'react';

/** The repeating-group row a field is rendered in; undefined outside a row. */
export const RowContext = createContext<string | undefined>(undefined);
