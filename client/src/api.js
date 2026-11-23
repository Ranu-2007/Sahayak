import axios from 'axios';

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api', timeout: 10000, withCredentials: true });

export async function signIn(email, password) {
  const { data } = await api.post('/auth/login', { email, password });
  return data.user;
}
export async function registerAccount(details) {
  const { data } = await api.post('/auth/register', details);
  return data.user;
}
export async function signOut() { await api.post('/auth/logout'); }
export default api;
