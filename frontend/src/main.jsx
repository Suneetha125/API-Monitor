import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import App from './App.jsx';
import './styles.css';

const root = createRoot(document.getElementById('root'));
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

root.render(publishableKey
  ? <React.StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <App />
      </ClerkProvider>
    </React.StrictMode>
  : <main className="auth-configuration-error">
      <h1>Authentication is not configured</h1>
      <p>Set VITE_CLERK_PUBLISHABLE_KEY and rebuild the frontend.</p>
    </main>
);
