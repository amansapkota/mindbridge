const TOKEN_KEY = "mindbridge_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));

  // A 401 from the login call means "wrong credentials" — surface the server's
  // message. A 401 from anything else means the session died, so drop the token
  // and let the router's auth gate take over rather than half-rendering a page.
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    clearToken();
    if (!location.pathname.startsWith("/login")) location.href = "/login";
    throw new ApiError(401, body.error || "Your session expired — please sign in again");
  }
  if (!res.ok) {
    throw new ApiError(res.status, body.error || body.errors?.join(", ") || res.statusText, body.errors);
  }
  return body;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
};
