import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';

export default function ProjectDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [project, setProject] = useState<any>(null);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const p: any = await apiFetch(`/projects/${id}`);
    setProject(p.project);
    const d: any = await apiFetch(`/projects/${id}/datasets`);
    setDatasets(d.data);
  }
  useEffect(() => { load().catch(e => setErr(e.message)); }, [id]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/projects/${id}/datasets`, { method: 'POST', body: JSON.stringify({ name }) });
      setName(''); load();
    } catch (e: any) { setErr(e.message); }
  }

  if (!project) return <p>Loading...</p>;
  return (
    <div>
      <h2>{project.name}</h2>
      <p>{project.description}</p>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {user?.role === 'admin' && (
        <form onSubmit={create} style={{ marginBottom: 16 }}>
          <input placeholder="dataset name" value={name} onChange={e=>setName(e.target.value)} />
          <button type="submit">Create dataset</button>
        </form>
      )}
      <h3>Datasets</h3>
      <ul>
        {datasets.map(d => (
          <li key={d.id}><Link to={`/datasets/${d.id}`}>{d.name}</Link></li>
        ))}
      </ul>
    </div>
  );
}
