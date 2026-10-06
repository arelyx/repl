import { api } from "@/lib/api";
import type {
  Collaborator,
  ContainerStatus,
  FileContent,
  FileNode,
  GitCommit,
  GitStatus,
  PortsResponse,
  Repl,
  Template,
  User,
} from "@/lib/types";

const r = (id: string) => `/repls/${encodeURIComponent(id)}`;
const q = (path: string) => encodeURIComponent(path);

export const authApi = {
  me: () => api.get<User>("/auth/me"),
  login: (login: string, password: string) => api.post<User>("/auth/login", { login, password }),
  register: (body: { email: string; username: string; password: string; display_name?: string }) =>
    api.post<User>("/auth/register", body),
  logout: () => api.post<void>("/auth/logout"),
};

export const templatesApi = {
  list: () => api.get<Template[]>("/templates"),
};

export const replsApi = {
  list: () => api.get<{ owned: Repl[]; shared: Repl[] }>("/repls"),
  explore: () => api.get<Repl[]>("/explore"),
  create: (body: { name: string; template: string; description?: string; is_public?: boolean }) =>
    api.post<Repl>("/repls", body),
  get: (id: string) => api.get<Repl>(r(id)),
  update: (id: string, body: { name?: string; description?: string; is_public?: boolean }) =>
    api.patch<Repl>(r(id), body),
  remove: (id: string) => api.del<void>(r(id)),
  fork: (id: string, name?: string) => api.post<Repl>(`${r(id)}/fork`, name ? { name } : {}),

  start: (id: string) => api.post<{ status: ContainerStatus }>(`${r(id)}/start`),
  stop: (id: string) => api.post<{ status: ContainerStatus }>(`${r(id)}/stop`),
  status: (id: string) => api.get<{ status: ContainerStatus }>(`${r(id)}/status`),
  ports: (id: string) => api.get<PortsResponse>(`${r(id)}/ports`),

  files: (id: string) => api.get<FileNode[]>(`${r(id)}/files`),
  readFile: (id: string, path: string) =>
    api.get<FileContent>(`${r(id)}/files/content?path=${q(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    api.put<{ path: string; size: number }>(`${r(id)}/files/content`, { path, content }),
  createFile: (id: string, path: string, type: "file" | "dir") =>
    api.post<unknown>(`${r(id)}/files`, { path, type }),
  rename: (id: string, from: string, to: string) =>
    api.post<unknown>(`${r(id)}/files/rename`, { from, to }),
  deleteFile: (id: string, path: string) => api.del<void>(`${r(id)}/files?path=${q(path)}`),
  upload: (id: string, file: File, dir: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("dir", dir);
    return api.post<unknown>(`${r(id)}/files/upload`, fd);
  },
  downloadUrl: (id: string) => `/api/v1${r(id)}/download`,

  gitStatus: (id: string) => api.get<GitStatus>(`${r(id)}/git/status`),
  gitLog: (id: string, limit = 50) => api.get<GitCommit[]>(`${r(id)}/git/log?limit=${limit}`),
  gitCommit: (id: string, message: string) => api.post<unknown>(`${r(id)}/git/commit`, { message }),
  gitDiff: (id: string, sha?: string) =>
    api.get<{ diff: string }>(`${r(id)}/git/diff${sha ? `?sha=${q(sha)}` : ""}`),
  gitRestore: (id: string, sha: string, path?: string) =>
    api.post<unknown>(`${r(id)}/git/restore`, path ? { sha, path } : { sha }),

  collaborators: (id: string) => api.get<Collaborator[]>(`${r(id)}/collaborators`),
  addCollaborator: (id: string, username: string, role: "viewer" | "editor") =>
    api.post<unknown>(`${r(id)}/collaborators`, { username, role }),
  removeCollaborator: (id: string, userId: number) =>
    api.del<void>(`${r(id)}/collaborators/${userId}`),
};
