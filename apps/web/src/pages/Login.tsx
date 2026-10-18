import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await login(email, password); nav('/'); } catch (e: any) { setErr(e.message); }
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 360, margin: '40px auto' }}>
      <h2>Login</h2>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      <input placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} style={{ width:'100%', marginBottom:8 }} />
      <input placeholder="password" type="password" value={password} onChange={e=>setPassword(e.target.value)} style={{ width:'100%', marginBottom:8 }} />
      <button type="submit">Login</button>
      <p><Link to="/register">Register first account</Link></p>
    </form>
  );
}
