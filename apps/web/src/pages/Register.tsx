import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiFetch } from '../api';

export default function Register() {
  const nav = useNavigate();
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'annotator' });
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 12) {
      setErr('password must be at least 12 characters');
      return;
    }
    try { await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(form) }); nav('/login'); }
    catch (e: any) { setErr(e.message); }
  }
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={submit} style={{ maxWidth: 360, margin: '40px auto' }}>
      <h2>Register</h2>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      <input placeholder="name" value={form.name} onChange={set('name')} style={{ width:'100%', marginBottom:8 }} />
      <input placeholder="email" value={form.email} onChange={set('email')} style={{ width:'100%', marginBottom:8 }} />
      <input placeholder="password (min 12 chars)" type="password" value={form.password} onChange={set('password')} style={{ width:'100%', marginBottom:8 }} />
      <select value={form.role} onChange={set('role')} style={{ width:'100%', marginBottom:8 }}>
        <option value="admin">admin</option>
        <option value="annotator">annotator</option>
        <option value="reviewer">reviewer</option>
      </select>
      <button type="submit">Register</button>
      <p><Link to="/login">Back to login</Link></p>
    </form>
  );
}
