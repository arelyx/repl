import { ErrorCodes } from "./protocol";

/** Monaco's CancellationToken has this shape; so does the one we build in tests. */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const isCancelled = (e: unknown) =>
  e instanceof RpcError && (e.code === ErrorCodes.RequestCancelled || e.code === ErrorCodes.ContentModified);

type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  sub?: { dispose(): void };
}

/**
 * JSON-RPC 2.0 over a WebSocket where every text frame is exactly one message
 * (the agent's bridge adds and strips LSP's Content-Length framing).
 */
export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private requestHandler: RequestHandler = () => {
    throw new RpcError(ErrorCodes.MethodNotFound, "method not found");
  };
  private notificationHandler: NotificationHandler = () => {};
  private closeListeners: ((ev: { code: number; reason: string }) => void)[] = [];

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatch(msg);
    });
    ws.addEventListener("close", (ev) => this.handleClose(ev.code, ev.reason));
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  onRequest(h: RequestHandler) {
    this.requestHandler = h;
  }
  onNotification(h: NotificationHandler) {
    this.notificationHandler = h;
  }
  onClose(cb: (ev: { code: number; reason: string }) => void) {
    this.closeListeners.push(cb);
  }

  private send(msg: object) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...msg }));
    return true;
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  request<R>(method: string, params?: unknown, token?: CancelToken): Promise<R> {
    if (!this.isOpen) return Promise.reject(new RpcError(ErrorCodes.InternalError, "connection closed"));
    if (token?.isCancellationRequested) return Promise.reject(new RpcError(ErrorCodes.RequestCancelled, "cancelled"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (token) {
        // Superseded requests (Monaco cancels the token) are cancelled server-side too.
        p.sub = token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.notify("$/cancelRequest", { id });
          reject(new RpcError(ErrorCodes.RequestCancelled, "cancelled"));
        });
      }
      this.pending.set(id, p);
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private dispatch(msg: Record<string, unknown>) {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    if (typeof msg.method === "string") {
      if (hasId) void this.answer(msg.id as number | string, msg.method, msg.params);
      else {
        try {
          this.notificationHandler(msg.method, msg.params);
        } catch (e) {
          console.error("lsp: notification handler failed", msg.method, e);
        }
      }
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(msg.id as number);
    if (!p) return;
    this.pending.delete(msg.id as number);
    p.sub?.dispose();
    if (msg.error) {
      const err = msg.error as { code: number; message: string; data?: unknown };
      p.reject(new RpcError(err.code, err.message, err.data));
    } else {
      p.resolve(msg.result ?? null);
    }
  }

  private async answer(id: number | string, method: string, params: unknown) {
    try {
      const result = await this.requestHandler(method, params);
      this.send({ id, result: result === undefined ? null : result });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : ErrorCodes.InternalError;
      this.send({ id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  private handleClose(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.sub?.dispose();
      p.reject(new RpcError(ErrorCodes.InternalError, "connection closed"));
    }
    this.pending.clear();
    for (const cb of this.closeListeners) cb({ code, reason });
  }

  close() {
    try {
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
    this.handleClose(1000, "client closed");
  }
}
