import { Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="app-shell">
      <header className="site-header">…</header>
      <main><Outlet /></main>
      <footer className="site-footer">…</footer>
    </div>
  );
}
