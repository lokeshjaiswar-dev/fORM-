import './csp.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'sonner/dist/styles.css';
import './index.css';
import App from './App.tsx';
import { loadEdition } from './edition/edition.ts';

void loadEdition();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
