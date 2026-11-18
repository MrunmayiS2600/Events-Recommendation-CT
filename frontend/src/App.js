import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link } from 'react-router-dom';
import Wizard from './pages/Wizard';
import TrainingAdmin from './pages/TrainingAdmin';
import './App.css';

// ─── Sliding pill theme toggle ──────────────────────────────────────────────
function ThemeToggle({ theme, onToggle }) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      aria-label="Toggle theme"
    >
      <span className="icon-moon" aria-hidden>☾</span>
      <span className="icon-sun" aria-hidden>☼</span>
      <span className="knob">{theme === 'dark' ? '☾' : '☼'}</span>
    </button>
  );
}

// ─── Top header ─────────────────────────────────────────────────────────────
function Header({ theme, onToggle }) {
  return (
    <header className="header">
      <Link to="/" className="header-brand" aria-label="CT Operator home">
        <span className="header-brand-mark" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="ctlogo-grad" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ff6a3d" />
                <stop offset="50%" stopColor="#ff2e80" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
              <linearGradient id="ctlogo-shine" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="white" stopOpacity="0.28" />
                <stop offset="60%" stopColor="white" stopOpacity="0" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="32" height="32" rx="9" fill="url(#ctlogo-grad)" />
            <rect x="0" y="0" width="32" height="32" rx="9" fill="url(#ctlogo-shine)" />
            <path
              d="M19 8 L11 17.5 H15.5 L13 24 L21 14.5 H16.5 L19 8 Z"
              fill="white"
              stroke="white"
              strokeWidth="0.6"
              strokeLinejoin="round"
            />
            <circle cx="24.5" cy="8.5" r="1.4" fill="white" opacity="0.95" />
          </svg>
        </span>
        <span className="header-brand-name">CT<span>/Operator</span></span>
      </Link>

      <nav className="header-nav">
        <NavLink to="/"         end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>Setup</NavLink>
        <NavLink to="/training"     className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>Training</NavLink>
      </nav>

      <div className="header-right">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          className="icon-btn"
          title="Docs"
          aria-label="Docs"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </a>
        <ThemeToggle theme={theme} onToggle={onToggle} />
      </div>
    </header>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────
function Shell() {
  const [theme, setTheme] = useState(() => localStorage.getItem('ct_theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ct_theme', theme);
  }, [theme]);

  // Cursor-aware orb: writes mouse position to CSS vars on <body>.
  useEffect(() => {
    let raf = 0;
    let pending = null;
    const onMove = (e) => {
      pending = { x: (e.clientX / window.innerWidth) * 100, y: (e.clientY / window.innerHeight) * 100 };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        if (pending) {
          document.body.style.setProperty('--mx', `${pending.x}%`);
          document.body.style.setProperty('--my', `${pending.y}%`);
        }
        raf = 0;
      });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => { window.removeEventListener('mousemove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="app-shell">
      <Header theme={theme} onToggle={toggle} />
      <main className="main-content">
        <Routes>
          <Route path="/"         element={<Wizard />} />
          <Route path="/training" element={<TrainingAdmin />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
