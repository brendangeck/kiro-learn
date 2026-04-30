import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import { applyTheme } from '@cloudscape-design/components/theming';
import { kiroLearnTheme } from './theme.js';
import App from './App.js';

applyTheme({ theme: kiroLearnTheme });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
