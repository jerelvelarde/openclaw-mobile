// Renderer entry point. Mounts <App /> into #root.
//
// We use React 18's createRoot API — no concurrent mode flags or strict
// mode here yet; the shell is too thin to need them.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('renderer: #root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
