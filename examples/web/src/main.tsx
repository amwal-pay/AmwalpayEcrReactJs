import { EcrProvider } from '@amwalpay/ecr-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';
import './root.css';

// Same origin as the Node server (or the Vite dev server, which forwards /api to it).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EcrProvider>
      <App />
    </EcrProvider>
  </StrictMode>,
);
