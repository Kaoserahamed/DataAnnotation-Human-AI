import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from './api';

interface User { id: string; email: string; name: string; role: string; }
interface AuthCtx { user: User | null; token: string | null; login: (email: string, password: string) => Promise<void>; register: (input: any) => Promise<void>; logout: () => void; }

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!token) { setUser(null); return; }
    apiFetch('/auth/me').then((r: any) => setUser(r.user)).catch(() => { localStorage.removeItem('token'); setToken(null); setUser(null); });
  }, [token]);

  async function login(email: string, password: string) {
    const r: any = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    localStorage.setItem('token', r.token);
    setToken(r.token);
    setUser(r.user);
  }

  async function register(input: any) {
    const r: any = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(input) });
    // auto-login not possible without password? register returns user only; prompt login
    return r;
  }

  function logout() {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }

  return <Ctx.Provider value={{ user, token, login, register, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() { return useContext(Ctx); }
