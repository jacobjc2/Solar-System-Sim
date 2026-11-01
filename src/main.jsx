import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

/**
 * Entry point: mounts <App /> into #root. StrictMode double-mounts components in
 * development, which checks that Simulation#attach cleans up after itself.
 */

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
