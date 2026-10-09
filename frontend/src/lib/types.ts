export interface User {
  id: number;
  email: string;
  username: string;
  display_name: string | null;
}

export type TemplateCategory = "language" | "web" | "gui" | "static" | "framework";

export interface Template {
  slug: string;
  name: string;
  description: string;
  language: string;
  category: TemplateCategory;
  icon: string;
  run: string;
  gui: boolean;
  port: number | null;
}

export type Role = "owner" | "editor" | "viewer";

export interface ReplConfig {
  run: string;
  entrypoint: string | null;
  gui: boolean;
  port: number | null;
}

export interface Repl {
  id: string;
  name: string;
  description: string | null;
  template: string;
  language: string;
  is_public: boolean;
  owner: { id: number; username: string; display_name: string | null };
  role: Role;
  forked_from: string | null;
  created_at: string;
  updated_at: string;
  config: ReplConfig;
}

export type ContainerStatus = "running" | "stopped" | "missing";

export interface FileNode {
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

export interface GitChange {
  path: string;
  status: string;
}

export interface GitStatus {
  branch: string;
  changes: GitChange[];
}

export interface GitCommit {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  date: string;
}

export interface Collaborator {
  user: Omit<User, "email">;
  role: "viewer" | "editor";
}

export interface PortsResponse {
  ports: number[];
  preview_base: string;
}
