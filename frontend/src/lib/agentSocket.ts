/**
 * A JSON-over-WebSocket connection to the in-container agent (§5), with
 * automatic reconnect. Messages: client → {type:"input"|"resize"|"start"|"stop"},
 * agent → {type:"output"|"status"}.
 */
export type AgentMessage =
  | { type: "output"; data: string }
  | { type: "status"; running: boolean; exitCode: number | null; command: string }
  | { type: string; [k: string]: unknown };

export type SocketState = "connecting" | "open" | "closed";

export class AgentSocket {
  private ws: WebSocket | null = null;
  private disposed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private handlers: {
      onMessage: (msg: AgentMessage) => void;
      onState: (state: SocketState) => void;
    },
    private opts: { reconnect: boolean } = { reconnect: true },
  ) {
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    this.handlers.onState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onState("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        this.handlers.onMessage(JSON.parse(ev.data));
      } catch {
        this.handlers.onMessage({ type: "output", data: ev.data });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onState("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (this.disposed || !this.opts.reconnect) return;
    const delay = Math.min(10000, 500 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Force a fresh connection now (e.g. "Reconnect" button). */
  reconnect() {
    if (this.timer) clearTimeout(this.timer);
    this.retry = 0;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
