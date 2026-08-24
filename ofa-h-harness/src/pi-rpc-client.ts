import { spawn, type ChildProcess } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { clampTimeoutMs } from "./protocol.ts";

export type RpcEvent = { type: string; [k: string]: unknown };

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type RpcSessionState = {
  sessionId?: string;
  isStreaming?: boolean;
  messageCount?: number;
  [k: string]: unknown;
};

export type PromptWaitOptions = {
  /** Settle-only timeout (no abort). Used by tests. */
  settleTimeoutMs?: number;
  /** Abort the turn after this many ms and treat as a job timeout. */
  jobTimeoutMs?: number;
  /** After abort, wait this long for agent_settled. Default 5000. */
  abortGraceMs?: number;
};

function asPromptWaitOptions(settleTimeoutOrOpts?: number | PromptWaitOptions): PromptWaitOptions {
  if (settleTimeoutOrOpts === undefined) return {};
  if (typeof settleTimeoutOrOpts === "number") return { settleTimeoutMs: settleTimeoutOrOpts };
  return settleTimeoutOrOpts;
}

export type PiRpcClientOptions = {
  cwd: string;
  env?: Record<string, string>;
  /** Default: `pi` */
  bin?: string;
  /** Default: `["--mode", "rpc"]` */
  args?: string[];
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (response: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type TurnGeneration = {
  state: "waiting" | "stale";
  settle: () => void;
  reject: (err: Error) => void;
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_CAP = 64 * 1024;

/**
 * Owns one `pi --mode rpc` child: JSONL on stdin/stdout, stdin kept open for
 * the life of the session. Turn completion is `agent_settled` (not the prompt
 * command response — that is only preflight acceptance).
 */
export class PiRpcClient {
  private child: ChildProcess | null = null;
  private stopReading: (() => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  private requestSeq = 0;
  private stderr = "";
  private exitError: Error | null = null;
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly turns = new Map<number, TurnGeneration>();
  private turnGeneration = 0;
  private readonly opts: PiRpcClientOptions;

  constructor(opts: PiRpcClientOptions) {
    this.opts = opts;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  getStderr(): string {
    return this.stderr;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("PiRpcClient already started");
    const bin = this.opts.bin ?? "pi";
    const args = this.opts.args ?? ["--mode", "rpc"];
    const child = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString("utf8");
      this.stderr = (this.stderr + chunk).slice(-STDERR_CAP);
    });

    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const err = new Error(`pi rpc exited (code=${code} signal=${signal}). stderr: ${this.stderr}`);
      this.recordExit(err);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      const err = new Error(`pi rpc spawn error: ${error.message}. stderr: ${this.stderr}`);
      this.recordExit(err);
    });
    child.stdin?.on("error", (error) => {
      if (this.child !== child) return;
      const err = this.exitError ?? new Error(`pi rpc stdin error: ${error.message}. stderr: ${this.stderr}`);
      this.recordExit(err);
    });

    if (!child.stdout) throw new Error("pi rpc stdout not piped");
    this.stopReading = attachJsonlLineReader(child.stdout, (line) => this.handleLine(line));

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`pi rpc spawn error: ${error.message}`));
      };
      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        reject(this.exitError ?? new Error(`pi rpc exited during start (code=${code} signal=${signal})`));
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      if (child.spawnfile && child.pid) {
        resolve();
        return;
      }
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    if (this.exitError) throw this.exitError;
    if (child.exitCode !== null) {
      throw this.exitError ?? new Error(`pi rpc exited during start (code=${child.exitCode})`);
    }
  }

  /**
   * Round-trip `get_state`. Must succeed before the session is advertised WARM.
   */
  async waitUntilWarm(timeoutMs = 90_000): Promise<RpcSessionState> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      if (this.exitError) throw this.exitError;
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const state = await this.getState(Math.min(remaining, this.opts.requestTimeoutMs ?? 60_000));
        return state;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (this.exitError) throw this.exitError;
        await sleep(50);
      }
    }
    throw lastErr ?? new Error("timed out waiting for pi rpc get_state (not WARM)");
  }

  async getState(timeoutMs?: number): Promise<RpcSessionState> {
    const response = await this.send({ type: "get_state" }, timeoutMs);
    if (!response.success) throw new Error(response.error ?? "get_state failed");
    return (response.data ?? {}) as RpcSessionState;
  }

  async getLastAssistantText(timeoutMs?: number): Promise<string | null> {
    const response = await this.send({ type: "get_last_assistant_text" }, timeoutMs);
    if (!response.success) throw new Error(response.error ?? "get_last_assistant_text failed");
    const data = response.data as { text?: string | null } | undefined;
    return data?.text ?? null;
  }

  /** True while an accepted turn has not emitted its generation's settle event. */
  hasUnsettledTurn(): boolean {
    return this.turns.size > 0;
  }

  /**
   * A grace-expired turn stays busy until its stale settle is consumed, or an
   * ordered get_state response proves pi is no longer streaming.
   */
  async readyForPrompt(timeoutMs = 1_500): Promise<boolean> {
    if (!this.hasUnsettledTurn()) return true;
    const state = await this.getState(timeoutMs);
    if (state.isStreaming !== false) return false;
    this.discardStaleGenerations();
    return !this.hasUnsettledTurn();
  }

  /**
   * Subscribe to `agent_settled` BEFORE sending `prompt` (the prompt response
   * is preflight-only and a fast turn can settle before that response is read).
   *
   * Pass a number for a settle-only timeout (no abort). Pass `{ jobTimeoutMs }`
   * to send rpc `{type:"abort"}` when the job budget expires, then wait briefly
   * for settle and return `{ timedOut: true }` instead of hanging.
   */
  async promptAndWait(
    message: string,
    settleTimeoutOrOpts?: number | PromptWaitOptions,
  ): Promise<{ text: string | null; timedOut: boolean }> {
    const opts = asPromptWaitOptions(settleTimeoutOrOpts);
    const jobTimeoutMs =
      opts.jobTimeoutMs !== undefined && opts.jobTimeoutMs > 0 ? clampTimeoutMs(opts.jobTimeoutMs) : undefined;
    const abortGraceMs = opts.abortGraceMs ?? 5_000;
    const generation = ++this.turnGeneration;
    const settled = this.waitForSettled(generation, jobTimeoutMs === undefined ? opts.settleTimeoutMs : undefined);

    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTriggered = false;
    let signalTimeout: (() => void) | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      signalTimeout = resolve;
    });
    if (jobTimeoutMs !== undefined) {
      abortTimer = setTimeout(() => {
        if (settled.settledCleanly) return;
        timeoutTriggered = true;
        signalTimeout?.();
        void this.abort().catch(() => {});
      }, jobTimeoutMs);
    }

    try {
      try {
        const response = await this.send({ type: "prompt", message });
        if (!response.success) {
          settled.cancel();
          throw new Error(response.error ?? "prompt rejected");
        }
      } catch (err) {
        settled.cancel();
        throw err;
      }
      if (jobTimeoutMs === undefined) {
        await settled.promise;
      } else {
        const first = await Promise.race([
          settled.promise.then(() => "settled" as const),
          timeoutPromise.then(() => "timeout" as const),
        ]);
        if (first === "timeout") {
          const settledDuringGrace = await Promise.race([
            settled.promise.then(() => true),
            sleep(abortGraceMs).then(() => false),
          ]);
          if (!settledDuringGrace) settled.abandon();
          const text = await this.getLastAssistantText().catch(() => null);
          return { text, timedOut: true };
        }
      }
      const text = await this.getLastAssistantText();
      return { text, timedOut: timeoutTriggered && !settled.settledCleanly };
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  async abort(timeoutMs = 10_000): Promise<void> {
    const response = await this.send({ type: "abort" }, timeoutMs);
    if (!response.success) throw new Error(response.error ?? "abort failed");
  }

  /**
   * Inject text into the in-flight turn. Fire-and-confirm only: do not
   * register a generation or wait for `agent_settled` — the running
   * `promptAndWait` owns that settle.
   */
  async steer(text: string, timeoutMs?: number): Promise<void> {
    const response = await this.send({ type: "steer", message: text }, timeoutMs);
    if (!response.success) throw new Error(response.error ?? "steer failed");
  }

  /**
   * Send the machine-only replan envelope through prompt preflight. The input
   * hook handles it, so this owns neither a turn generation nor a settle wait.
   */
  async sendReplanControl(text: string, timeoutMs?: number): Promise<void> {
    const response = await this.send({ type: "prompt", message: text, streamingBehavior: "steer" }, timeoutMs);
    if (!response.success) throw new Error(response.error ?? "replan control rejected");
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onExit(listener: (error: Error) => void): () => void {
    if (this.exitError) {
      listener(this.exitError);
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Hard teardown. Closing stdin is pi rpc's documented shutdown path
   * (`stdin end` → shutdown) — only call this when destroying the session.
   */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopReading?.();
    this.stopReading = null;

    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }

    const exited = waitForExit(child);
    const graceful = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
    if (!graceful && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const termed = await Promise.race([exited.then(() => true), sleep(1000).then(() => false)]);
      if (!termed && child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    await Promise.race([exited, sleep(500)]);
    this.child = null;
    const err = new Error("pi rpc client killed");
    this.rejectAll(err);
  }

  private waitForSettled(
    generation: number,
    timeoutMs?: number,
  ): { promise: Promise<void>; cancel: () => void; abandon: () => void; readonly settledCleanly: boolean } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onExit: (() => void) | null = null;
    let finished = false;
    let settledCleanly = false;

    const promise = new Promise<void>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (onExit) this.child?.off("exit", onExit);
        fn();
      };

      this.turns.set(generation, {
        state: "waiting",
        settle: () => {
          settledCleanly = true;
          finish(resolve);
        },
        reject: (err) => finish(() => reject(err)),
      });

      onExit = () => {
        finish(() => reject(this.exitError ?? new Error("pi rpc exited before agent_settled")));
      };
      this.child?.once("exit", onExit);

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.turns.delete(generation);
          finish(() => reject(new Error(`timeout waiting for agent_settled. stderr: ${this.stderr}`)));
        }, clampTimeoutMs(timeoutMs));
      }
    });

    return {
      promise,
      cancel: () => {
        if (finished) return;
        finished = true;
        this.turns.delete(generation);
        if (timer) clearTimeout(timer);
        if (onExit) this.child?.off("exit", onExit);
      },
      abandon: () => {
        const turn = this.turns.get(generation);
        if (!turn || settledCleanly) return;
        turn.state = "stale";
        if (timer) clearTimeout(timer);
        if (onExit) this.child?.off("exit", onExit);
      },
      get settledCleanly() {
        return settledCleanly;
      },
    };
  }

  private handleLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === "extension_ui_request") {
      this.handleExtensionUi(data);
      return;
    }

    if (data.type === "response") {
      const id = typeof data.id === "string" ? data.id : undefined;
      if (id && this.pending.has(id)) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(data as RpcResponse);
        }
        return;
      }
    }

    const event = data as RpcEvent;
    if (event.type === "agent_settled") this.settleOldestGeneration();
    for (const listener of this.listeners) listener(event);
  }

  private settleOldestGeneration(): void {
    const entry = this.turns.entries().next();
    if (entry.done) return;
    const [generation, turn] = entry.value;
    this.turns.delete(generation);
    if (turn.state === "waiting") turn.settle();
  }

  private discardStaleGenerations(): void {
    for (const [generation, turn] of this.turns) {
      if (turn.state === "stale") this.turns.delete(generation);
    }
  }

  /**
   * Headless: auto-cancel dialog methods so a `ctx.ui.select` in the L2 profile
   * cannot hang the job forever. Fire-and-forget methods (setStatus, notify, …)
   * are ignored. Confirmed necessary: a real `get_state` smoke against
   * ofa-orch-h emitted `extension_ui_request` / `setStatus` before the response.
   */
  private handleExtensionUi(req: Record<string, unknown>): void {
    const method = req.method;
    const id = req.id;
    if (typeof method !== "string" || typeof id !== "string") return;
    if (!DIALOG_METHODS.has(method)) return;
    void this.writeRaw({ type: "extension_ui_response", id, cancelled: true }).catch(() => {});
  }

  private async send(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin) throw new Error("PiRpcClient not started");
    if (this.exitError) throw this.exitError;
    if (child.exitCode !== null) {
      const err = new Error(`pi rpc already exited (code=${child.exitCode}). stderr: ${this.stderr}`);
      this.exitError = err;
      throw err;
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new Error(`pi rpc stdin is not writable. stderr: ${this.stderr}`);
    }

    const id = `req_${++this.requestSeq}`;
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for rpc response to ${command.type}. stderr: ${this.stderr}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(serializeJsonLine({ ...command, id }), (err) => {
          if (!err) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private writeRaw(obj: unknown): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return Promise.resolve();
    return new Promise((resolve, reject) => {
      stdin.write(serializeJsonLine(obj), (err) => (err ? reject(err) : resolve()));
    });
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private recordExit(err: Error): void {
    if (this.exitError) return;
    this.exitError = err;
    this.rejectAll(err);
    for (const turn of this.turns.values()) {
      if (turn.state === "waiting") turn.reject(err);
    }
    this.turns.clear();
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    for (const listener of listeners) {
      try {
        listener(err);
      } catch {
        /* ignore observer failures */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
