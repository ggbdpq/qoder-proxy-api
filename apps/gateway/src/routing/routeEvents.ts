// 路由事件：网关"正在做的决定"。控制台路由页、用量统计、日志都只消费这一种语言。
// 事件里只放路由元数据：不放 prompt、回复正文、工具参数、Key、上游原始错误正文。
// 契约见 02-接口契约 §2；实现（环形缓冲 + 订阅）由 WP6 提供。

export type MemberRef = { providerId: string; model: string };
export type CandidateState = "ready" | "resting" | "skipped";

export type RouteEvent =
  | {
      type: "request.start";
      requestId: string;
      at: number;
      agent: string;
      alias: string;
      groupId: string | null;
      protocol: string;
    }
  | {
      type: "route.decision";
      requestId: string;
      at: number;
      strategy: "ordered" | "smart" | "direct";
      candidates: Array<MemberRef & { state: CandidateState; reason: string; restUntil?: number }>;
    }
  | { type: "upstream.attempt"; requestId: string; at: number; member: MemberRef; attempt: number }
  | { type: "upstream.firstByte"; requestId: string; at: number; member: MemberRef; ms: number }
  | {
      type: "upstream.failed";
      requestId: string;
      at: number;
      member: MemberRef;
      code: string;
      status?: number;
      restUntil?: number;
      reroutable: boolean;
    }
  | {
      type: "reroute";
      requestId: string;
      at: number;
      from: MemberRef;
      to: MemberRef;
      reason: string;
    }
  | {
      type: "request.end";
      requestId: string;
      at: number;
      outcome: "ok" | "error" | "cancelled";
      member: MemberRef | null;
      ms: number;
      reroutes: number;
      errorCode?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };

export type SequencedRouteEvent = RouteEvent & { seq: number };
export type RouteEventListener = (event: SequencedRouteEvent) => void;

// 总线给每条事件加进程内单调递增的 seq；订阅方异常不得影响数据面。
export interface RouteEventBus {
  emit(event: RouteEvent): void;
  since(seq: number): SequencedRouteEvent[];
  subscribe(listener: RouteEventListener): () => void;
}
