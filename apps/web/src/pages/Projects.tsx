import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';

export default function Projects() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const r: any = await apiFetch('/projects');
    setProjects(r.data);
  }
  useEffect(() => { load().catch(e => setErr(e.message)); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/projects', { method: 'POST', body: JSON.stringify({ name, description: desc }) });
      setName(''); setDesc(''); load();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div>
      <h2>Projects</h2>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {user?.role === 'admin' && (
        <form onSubmit={create} style={{ marginBottom: 16 }}>
          <input placeholder="project name" value={name} onChange={e=>setName(e.target.value)} />
          <input placeholder="description" value={desc} onChange={e=>setDesc(e.target.value)} />
          <button type="submit">Create</button>
        </form>
      )}
      <ul>
        {projects.map(p => (
          <li key={p.id}><Link to={`/projects/${p.id}`}>{p.name}</Link> — {p.description}</li>
        ))}
      </ul>
    </div>
  );
}
