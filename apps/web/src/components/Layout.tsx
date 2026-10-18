import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Link to="/" style={{ fontWeight: 700, textDecoration: 'none', color: '#111' }}>HAAP</Link>
        <nav style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link to="/">Projects</Link>
          {user && <span>{user.name} ({user.role})</span>}
          <button onClick={() => { logout(); nav('/login'); }}>Logout</button>
        </nav>
      </header>
      <main><Outlet /></main>
    </div>
  );
}
