// Gateway 认证：PAT → jobToken 交换、refreshToken 续期、每请求 Bearer 构建。
// 协议事实来源：公开协议参考实现。
// RSA/AES 均使用 node:crypto，不引入第三方依赖。
import { randomUUID, createCipheriv, publicEncrypt, constants } from "node:crypto";
import { ProviderError, ERROR_CODES } from "../../core/errors.ts";
import { encode, md5Hex, signAuthDate, rfc1123Now } from "./codec.ts";

// 网关用于包裹 tempKey 的固定 RSA 公钥（参考实现与官方客户端同源）。
const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const COSY_VERSION = "0.1.43";
// 提前刷新余量（参考实现同量级）：到期前 10 分钟触发续期。
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface GatewayRegion {
  name: string;
  base: string;
}

export const GATEWAY_REGIONS = {
  cn: { name: "cn", base: "https://gateway.qoder.com.cn" },
};

export interface GatewayEndpoints {
  jobToken: string;
  userStatus: string;
  modelList: string;
  chatSse: string;
}

// jobToken 响应字段（公开协议参考实现）；未声明字段按 unknown 读取。
export interface GatewayJobToken {
  name?: unknown;
  id?: unknown;
  userType?: unknown;
  securityOauthToken?: unknown;
  refreshToken?: unknown;
  expireTime?: unknown;
}

export interface GatewayIdentity {
  name: string;
  aid: string;
  uid: string;
  yxUid: string;
  organizationId: string;
  organizationName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
}

export interface GatewayMachineInfo {
  machineId: string;
  machineToken: string;
  machineType: string;
}

export interface GatewaySession {
  identity: GatewayIdentity;
  cosyKey: string;
  machineId: string;
  machineToken: string;
  machineType: string;
  refreshToken: string;
  securityOauthToken: string;
  expireTimeMs: number;
}

export function gatewayEndpoints(region: GatewayRegion = GATEWAY_REGIONS.cn): GatewayEndpoints {
  return {
    jobToken: `${region.base}/algo/api/v3/user/jobToken?Encode=1`,
    userStatus: `${region.base}/algo/api/v3/user/status?Encode=1`,
    modelList: `${region.base}/algo/api/v2/model/list?Encode=1`,
    chatSse: `${region.base}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
  };
}

function signaturePath(fullUrl: string): string {
  const path = new URL(fullUrl).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

function aesEncryptCbc(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function rsaEncrypt(plain: Buffer): Buffer {
  return publicEncrypt({ key: SERVER_PUBKEY_PEM, padding: constants.RSA_PKCS1_PADDING }, plain);
}

// 一次请求的 Bearer token：Bearer COSY.<payload_b64>.<md5 签名>。
// 每请求新的 tempKey/payload；签名覆盖 body 与路径，防篡改。
export function buildBearer({
  identity,
  date,
  body,
  pathSig,
  requestId = randomUUID(),
}: {
  identity: GatewayIdentity;
  date: string;
  body: string;
  pathSig: string;
  requestId?: string;
}): { bearer: string; cosyKey: string } {
  const tempKey = Buffer.from(randomUUID().replaceAll("-", "").slice(0, 16), "ascii");
  const cosyKey = rsaEncrypt(tempKey).toString("base64");
  const authPayload = JSON.stringify({
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yxUid,
    organization_id: identity.organizationId,
    organization_name: identity.organizationName,
    user_type: identity.userType,
    security_oauth_token: identity.securityOauthToken,
    refresh_token: identity.refreshToken,
  });
  const info = aesEncryptCbc(Buffer.from(authPayload, "utf8"), tempKey).toString("base64");
  const payloadJson = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        cosyVersion: COSY_VERSION,
        ideVersion: "",
        info,
        requestId,
        version: "v1",
      }).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64");
  const sig = md5Hex([payloadB64, cosyKey, date, body, pathSig].join("\n"));
  return { bearer: `Bearer COSY.${payloadB64}.${sig}`, cosyKey };
}

export function authRequestHeaders({
  machineId,
  machineToken,
  machineType,
  date,
  signature,
}: GatewayMachineInfo & { date: string; signature: string }): Record<string, string> {
  return {
    "cosy-machinetoken": machineToken,
    "cosy-machinetype": machineType,
    "login-version": "v2",
    appcode: "cosy",
    accept: "application/json",
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-clienttype": "5",
    date,
    signature,
    "content-type": "application/json",
    "cosy-machineid": machineId,
    "user-agent": "Go-http-client/2.0",
  };
}

export function bearerRequestHeaders({
  sess,
  date,
  bearer,
  accept,
}: {
  sess: GatewaySession;
  date: string;
  bearer: string;
  accept: string;
}): Record<string, string> {
  return {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": sess.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": sess.identity.uid,
    "cosy-key": sess.cosyKey,
    accept,
    authorization: bearer,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": sess.machineId,
    "cosy-machinetoken": sess.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
  };
}

// jobToken 响应 → identity + 会话材料。expireTime 为毫秒时间戳。
export function sessionFromJobToken(
  jt: GatewayJobToken,
  { machineId, machineToken, machineType }: GatewayMachineInfo,
): GatewaySession {
  const identity: GatewayIdentity = {
    name: String(jt.name ?? ""),
    aid: String(jt.id ?? ""),
    uid: String(jt.id ?? ""),
    yxUid: "",
    organizationId: "",
    organizationName: "",
    userType: String(jt.userType ?? "personal_standard"),
    securityOauthToken: String(jt.securityOauthToken ?? ""),
    refreshToken: String(jt.refreshToken ?? ""),
  };
  const tempKey = Buffer.from(randomUUID().replaceAll("-", "").slice(0, 16), "ascii");
  return {
    identity,
    cosyKey: rsaEncrypt(tempKey).toString("base64"),
    machineId,
    machineToken,
    machineType,
    refreshToken: identity.refreshToken,
    securityOauthToken: identity.securityOauthToken,
    expireTimeMs: Number(jt.expireTime) || 0,
  };
}

// Gateway 认证状态机：cold exchange → READY；近过期走 refresh；refresh 被拒回退 cold。
// single-flight：并发请求共享同一次交换/续期，避免惊群。
export class GatewayAuth {
  pat: string;
  fetch: typeof globalThis.fetch;
  region: GatewayRegion;
  machine: GatewayMachineInfo;
  requestTimeoutMs: number;
  session: GatewaySession | null;
  inFlight: Promise<GatewaySession> | null;

  constructor({
    pat,
    fetchImpl = globalThis.fetch,
    region = GATEWAY_REGIONS.cn,
    machine,
    requestTimeoutMs = 600000,
  }: {
    pat?: string;
    fetchImpl?: typeof globalThis.fetch;
    region?: GatewayRegion;
    machine?: Partial<GatewayMachineInfo>;
    requestTimeoutMs?: number;
  } = {}) {
    if (!pat || !String(pat).trim()) {
      throw new ProviderError(
        ERROR_CODES.PROVIDER_AUTH_ERROR,
        "QODER_GATEWAY_PAT is empty; gateway provider requires a personal access token",
      );
    }
    this.pat = String(pat).trim();
    this.fetch = fetchImpl;
    this.region = region;
    this.requestTimeoutMs = requestTimeoutMs;
    this.machine = {
      machineId: machine?.machineId ?? randomUUID(),
      machineToken: machine?.machineToken ?? randomUUID(),
      machineType: machine?.machineType ?? "windows_amd64",
    };
    this.session = null;
    this.inFlight = null;
  }

  // 返回可用会话；必要时先交换/续期。并发调用共享同一次 in-flight 操作。
  async ensureSession(): Promise<GatewaySession> {
    if (this.session && !this.needsRefresh()) return this.session;
    if (!this.inFlight) {
      this.inFlight = this.renew().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  needsRefresh(): boolean {
    if (!this.session) return true;
    const expire = this.session.expireTimeMs;
    if (!expire) return true;
    return Date.now() > expire - REFRESH_MARGIN_MS;
  }

  async renew(): Promise<GatewaySession> {
    const hasTokens = Boolean(this.session?.refreshToken);
    try {
      const jt = await this.exchangeJobToken({
        refreshToken: hasTokens ? (this.session?.refreshToken ?? "") : "",
        securityOauthToken: hasTokens ? (this.session?.securityOauthToken ?? "") : "",
        needRefresh: hasTokens,
      });
      this.session = sessionFromJobToken(jt, this.machine);
      return this.session;
    } catch (error) {
      if (hasTokens) {
        // refresh 被拒 → 回退 cold exchange 一次；再失败才算真实错误。
        const jt = await this.exchangeJobToken({
          refreshToken: "",
          securityOauthToken: "",
          needRefresh: false,
        });
        this.session = sessionFromJobToken(jt, this.machine);
        return this.session;
      }
      throw toProviderAuthError(error);
    }
  }

  async exchangeJobToken({
    refreshToken,
    securityOauthToken,
    needRefresh,
    signal,
  }: {
    refreshToken?: string;
    securityOauthToken?: string;
    needRefresh?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<GatewayJobToken> {
    const inner = {
      personalToken: this.pat,
      securityOauthToken: securityOauthToken ?? "",
      refreshToken: refreshToken ?? "",
      needRefresh: Boolean(needRefresh),
      authInfo: {},
    };
    const outer = { payload: JSON.stringify(inner), encodeVersion: "1" };
    const date = rfc1123Now();
    const signature = signAuthDate(date);
    const headers = authRequestHeaders({ ...this.machine, date, signature });
    // 认证交换与数据请求同受 requestTimeoutMs 约束；缺它时上游静默会无限挂住。
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetch(gatewayEndpoints(this.region).jobToken, {
        method: "POST",
        headers,
        body: encode(Buffer.from(JSON.stringify(outer, undefined, 0), "utf8")).toString(),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      if (!signal?.aborted && timeoutSignal.aborted) {
        throw new ProviderError(
          ERROR_CODES.PROVIDER_TIMEOUT,
          `gateway auth timeout after ${this.requestTimeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(
        response.status === 401 || response.status === 403
          ? ERROR_CODES.PROVIDER_AUTH_ERROR
          : ERROR_CODES.PROVIDER_UNAVAILABLE,
        `gateway jobToken exchange failed: HTTP ${response.status} ${detail}`,
        { status: response.status },
      );
    }
    return response.json();
  }

  // 请求用 Bearer headers 组装（client.js 消费）。
  requestHeaders(
    session: GatewaySession,
    {
      body,
      fullUrl,
      accept = "application/json",
    }: { body: string; fullUrl: string; accept?: string },
  ): Record<string, string> {
    const date = String(Math.floor(Date.now() / 1000));
    const pathSig = signaturePath(fullUrl);
    const { bearer, cosyKey } = buildBearer({
      identity: session.identity,
      date,
      body,
      pathSig,
    });
    return bearerRequestHeaders({
      sess: { ...session, cosyKey },
      date,
      bearer,
      accept,
    });
  }
}

function toProviderAuthError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(ERROR_CODES.PROVIDER_AUTH_ERROR, errorText(error), {
    cause: error,
  });
}

// 等价于原 `error?.message || String(error)`（v0.1 动态取值；message 字段实践为 string）。
function errorText(error: unknown): string {
  return (errorField(error, "message") || String(error)) as string;
}

// 宽松 JSON 记录：动态取值的统一读取形状（值保持 unknown，消费处自行窄化）。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// unknown error 的诊断字段读取：非对象时与原可选链一样得到 undefined。
function errorField(error: unknown, field: string): unknown {
  return isRecord(error) ? error[field] : undefined;
}
