import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app">
      <header className="header">
        <Link to="/" className="brand">HAAP</Link>
        <nav className="nav">
          <Link to="/" className="nav-link">Projects</Link>
          {user && <span className="user-chip">{user.name} · {user.role}</span>}
          <button className="nav-link" onClick={() => { logout(); nav('/login'); }}>Logout</button>
        </nav>
      </header>
      <main><Outlet /></main>
    </div>
  );
}
