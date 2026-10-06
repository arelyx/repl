export const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function buildError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json();
    let msg = "An error occurred";
    if (typeof body.detail === "string") msg = body.detail;
    else if (Array.isArray(body.detail) && body.detail[0]?.msg) msg = body.detail[0].msg;
    else if (body.detail?.message) msg = body.detail.message;
    return new ApiError(response.status, msg);
  } catch {
    return new ApiError(response.status, `${response.status} ${response.statusText}`);
  }
}

/** Cookie-authenticated fetch wrapper. The auth cookie is httpOnly; JS never sees a token. */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) throw await buildError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function wsBase(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}
