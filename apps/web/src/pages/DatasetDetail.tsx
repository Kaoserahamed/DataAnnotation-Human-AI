import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiFetch } from '../api';
import { useAuth } from '../auth';

export default function DatasetDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [content, setContent] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const page: any = await apiFetch(`/datasets/${id}/items?limit=50&offset=0`);
    setItems(page.data || []);
    const q: any = await apiFetch(`/datasets/${id}/queue?limit=20&offset=0`);
    setQueue(q.data || []);
  }
  useEffect(() => { load().catch(e => setErr(e.message)); }, [id]);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    try {
      let parsed: any;
      try { parsed = JSON.parse(content); } catch { parsed = { text: content }; }
      await apiFetch(`/datasets/${id}/items`, { method: 'POST', body: JSON.stringify({ items: [{ content: parsed }] }) });
      setContent(''); load();
    } catch (e: any) { setErr(e.message); }
  }

  async function prelabel() {
    try { await apiFetch(`/datasets/${id}/prelabel`, { method: 'POST', body: JSON.stringify({}) }); load(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div>
      <h2>Dataset {id}</h2>
      {err && <p style={{ color: 'red' }}>{err}</p>}
      {user?.role === 'admin' && (
        <>
          <form onSubmit={addItem} style={{ marginBottom: 8 }}>
            <input placeholder='content (text or JSON)' value={content} onChange={e=>setContent(e.target.value)} style={{ width: 400 }} />
            <button type="submit">Add item</button>
          </form>
          <button onClick={prelabel}>Run prelabel</button>
        </>
      )}
      <h3>Items ({items.length})</h3>
      <ul>{items.map((it:any) => <li key={it.id}>{JSON.stringify(it.content).slice(0,80)}</li>)}</ul>
      <h3>Queue</h3>
      <ul>
        {queue.map((e:any) => (
          <li key={e.task.id}>
            <Link to={`/tasks/${e.task.id}`}>Task {e.task.id}</Link> — {e.task.state} (score {e.signals?.acquisitionScore?.toFixed(3)})
          </li>
        ))}
      </ul>
    </div>
  );
}
