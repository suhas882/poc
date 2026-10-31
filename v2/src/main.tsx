import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { AppStateProvider, initialTheme } from './state/AppState';
import '@fontsource-variable/public-sans/wght.css';
import '@fontsource-variable/source-serif-4/wght.css';
import './styles/app.css';

// Apply the saved theme before first paint (no inline script: the CSP forbids it).
document.documentElement.dataset.theme = initialTheme();

// Each page is its own chunk, so the first visit only downloads the page it needs.
const RequestPlan = lazy(() => import('./pages/RequestPlan'));
const SearchResults = lazy(() => import('./pages/SearchResults'));
const Evaluation = lazy(() => import('./pages/Evaluation'));

const Loading = () => <div className="page-loading" role="status">Loading…</div>;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppStateProvider>
        <ToastProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Suspense fallback={<Loading />}><RequestPlan /></Suspense>} />
              <Route path="search" element={<Suspense fallback={<Loading />}><SearchResults /></Suspense>} />
              <Route path="evaluation" element={<Suspense fallback={<Loading />}><Evaluation /></Suspense>} />
              {/* v1 URLs keep working */}
              <Route path="index.html" element={<Navigate to="/" replace />} />
              <Route path="search.html" element={<Navigate to="/search" replace />} />
              <Route path="evaluation.html" element={<Navigate to="/evaluation" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AppStateProvider>
    </BrowserRouter>
  </StrictMode>
);
