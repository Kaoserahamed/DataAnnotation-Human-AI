import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';

export default function TaskView() {
  const { id } = useParams();
  const { user } = useAuth();
  const [task, setTask] = useState<any>(null);
  const [label, setLabel] = useState('');
  const [verdict, setVerdict] = useState('accept');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    const r: any = await apiFetch(`/tasks/${id}`);
    setTask(r.task);
  }
  useEffect(() => { load().catch(e => setErr(e.message)); }, [id]);

  async function annotate(e: React.FormEvent) {
    e.preventDefault();
    try {
      let parsed: any;
      try { parsed = JSON.parse(label); } catch { parsed = { text: label }; }
      await apiFetch(`/tasks/${id}/annotate`, { method: 'POST', body: JSON.stringify({ label: parsed }) });
      setMsg('Annotated'); load();
    } catch (e: any) { setErr(e.message); }
  }

  async function review(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/tasks/${id}/review`, { method: 'POST', body: JSON.stringify({ verdict }) });
      setMsg('Reviewed'); load();
    } catch (e: any) { setErr(e.message); }
  }

  if (!task) return <p>Loading...</p>;
  return (
    <div>
      <h2>Task {task.id}</h2>
      <p>State: {task.state} | Type: {task.taskType}</p>
      <pre style={{ background: '#f5f5f5', padding: 8 }}>{JSON.stringify(task.content, null, 2)}</pre>
      <p>AI label: <code>{JSON.stringify(task.aiLabel)}</code> (conf {task.aiConfidence})</p>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {msg && <p style={{ color: 'green' }}>{msg}</p>}
      {(user?.role === 'annotator' || user?.role === 'reviewer' || user?.role === 'admin') && (
        <form onSubmit={annotate} style={{ marginBottom: 16 }}>
          <h3>Annotate</h3>
          <textarea value={label} onChange={e=>setLabel(e.target.value)} rows={4} style={{ width: '100%' }} placeholder='label JSON' />
          <button type="submit">Submit annotation</button>
        </form>
      )}
      {(user?.role === 'reviewer' || user?.role === 'admin') && (
        <form onSubmit={review}>
          <h3>Review</h3>
          <select value={verdict} onChange={e=>setVerdict(e.target.value)}>
            <option value="accept">accept</option>
            <option value="reject">reject</option>
            <option value="needs_correction">needs_correction</option>
          </select>
          <button type="submit">Submit review</button>
        </form>
      )}
    </div>
  );
}
