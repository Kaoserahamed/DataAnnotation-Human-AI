import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';
import { REVIEW_VERDICTS } from '../lib/labels';

export default function TaskView() {
  const { id } = useParams();
  const { user } = useAuth();
  const [task, setTask] = useState<any>(null);
  const [label, setLabel] = useState('');
  const [verdict, setVerdict] = useState('correct');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    const r: any = await apiFetch(`/tasks/${id}`);
    setTask(r.task);
    setLabel('');
    setVerdict('correct');
  }
  useEffect(() => { load().catch(e => setErr(e.message)); }, [id]);

  function buildLabel(): unknown {
    try {
      const parsed = JSON.parse(label);
      return parsed;
    } catch {
      // categorical: { label: <raw> }
      return { label: label };
    }
  }

  async function annotate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/tasks/${id}/annotate`, { method: 'POST', body: JSON.stringify({ label: buildLabel() }) });
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
      <pre className="pre">{JSON.stringify(task.content, null, 2)}</pre>
      <p className="small">AI label: {JSON.stringify(task.aiLabel)} (conf {task.aiConfidence})</p>
      {err && <p className="err">{err}</p>}
      {msg && <p className="ok">{msg}</p>}
      {(user?.role === 'annotator' || user?.role === 'reviewer' || user?.role === 'admin') && (
        <form onSubmit={annotate} className="card">
          <h3>Annotate</h3>
          <textarea value={label} onChange={e=>setLabel(e.target.value)} rows={4} placeholder='label value or JSON' />
          <button className="primary" type="submit">Submit annotation</button>
        </form>
      )}
      {(user?.role === 'reviewer' || user?.role === 'admin') && (
        <form onSubmit={review} className="card">
          <h3>Review</h3>
          <select value={verdict} onChange={e=>setVerdict(e.target.value)}>
            {REVIEW_VERDICTS.map((v: string) => <option key={v} value={v}>{v}</option>)}
          </select>
          <button className="primary" type="submit">Submit review</button>
        </form>
      )}
    </div>
  );
}
