import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';
import { TASK_TYPES, CATEGORICAL_TASK_TYPES, type TaskType } from '../lib/labels';

const CATEGORICAL: Set<string> = new Set(CATEGORICAL_TASK_TYPES as readonly string[]);

export default function ProjectDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [project, setProject] = useState<any>(null);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('text_classification');
  const [categories, setCategories] = useState('');
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
      const labelSchema = CATEGORICAL.has(taskType) && categories
        ? { categories: categories.split('\n').map(c => c.trim()).filter(Boolean) }
        : {};
      await apiFetch(`/projects/${id}/datasets`, { method: 'POST', body: JSON.stringify({ name, taskType, labelSchema }) });
      setName(''); setCategories(''); load();
    } catch (e: any) { setErr(e.message); }
  }

  if (!project) return <p>Loading...</p>;
  return (
    <div>
      <h2>{project.name}</h2>
      <p>{project.description}</p>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {user?.role === 'admin' && (
        <form onSubmit={create} className="card">
          <h3>Create dataset</h3>
          <input placeholder="dataset name" value={name} onChange={e=>setName(e.target.value)} />
          <select value={taskType} onChange={e=>setTaskType(e.target.value as TaskType)}>
            {TASK_TYPES.map((t: string) => <option key={t} value={t}>{t}</option>)}
          </select>
          {CATEGORICAL.has(taskType) && (
            <textarea placeholder="categories (one per line)" value={categories} onChange={e=>setCategories(e.target.value)} rows={4} />
          )}
          <button className="primary" type="submit">Create dataset</button>
        </form>
      )}
      <h3>Datasets</h3>
      <ul className="list">
        {datasets.map(d => (
          <li key={d.id}><Link to={`/datasets/${d.id}`}>{d.name}</Link> — {d.taskType}</li>
        ))}
      </ul>
    </div>
  );
}
