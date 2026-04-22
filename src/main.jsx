import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ConfigApp from './ConfigApp.jsx';

const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {label === 'config' ? <ConfigApp /> : <App />}
  </React.StrictMode>
);
