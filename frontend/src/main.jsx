import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/clerk-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dark } from '@clerk/themes';
import { Toaster } from 'sonner';
import './styles/global.css';
import App from './App.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const clerkAppearance = {
  baseTheme: dark,
  variables: {
    colorBackground:      '#18181b',
    colorInputBackground: '#27272a',
    colorText:            '#fafafa',
    colorTextSecondary:   '#a1a1aa',
    colorPrimary:         '#6366f1',
    colorDanger:          '#ef4444',
    borderRadius:         '8px',
    fontSize:             '15px',
  },
  elements: {
    card: {
      backgroundColor: '#18181b',
      borderColor: '#3f3f46',
      border: '1px solid #3f3f46',
    },
    userButtonPopoverCard: {
      backgroundColor: '#18181b',
      borderColor: '#3f3f46',
      border: '1px solid #3f3f46',
    },
    userButtonPopoverActions: {
      backgroundColor: '#18181b',
    },
    userButtonPopoverActionButton: {
      color: '#fafafa',
      '&:hover': {
        backgroundColor: '#27272a',
      },
    },
    userButtonPopoverActionButtonText: {
      color: '#fafafa',
    },
    userButtonPopoverActionButtonIcon: {
      color: '#a1a1aa',
    },
    userButtonPopoverFooter: {
      display: 'none',
    },
    userPreviewMainIdentifier: {
      color: '#fafafa',
    },
    userPreviewSecondaryIdentifier: {
      color: '#a1a1aa',
    },
    avatarBox: {
      width: '32px',
      height: '32px',
    },
  },
};

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#18181b',
                border: '1px solid #3f3f46',
                color: '#fafafa',
              },
            }}
          />
        </BrowserRouter>
      </QueryClientProvider>
    </ClerkProvider>
  </StrictMode>,
);
