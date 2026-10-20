// Qoder Gateway 自定义编码与请求签名。
// 协议事实来源：公开协议参考实现，
// 已与该参考实现做差分验证（见 test/gateway/codec.test.js）。
// 私有协议随时可能漂移（计划文档 U3 风险），此模块是唯一允许知道这些细节的地方。
import { createHash } from "node:crypto";

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

const S2C = new Map([...STD_ALPHABET].map((ch, i) => [ch, CUSTOM_ALPHABET[i]]));
S2C.set("=", CUSTOM_PAD);
const C2S = new Map([...S2C.entries()].map(([std, custom]) => [custom, std]));

// b64 字符重排：a = n/3，结果 = 尾段 + 中段 + 头段。encode/decode 同一置换（自逆）。
function rearrange(str: string): string {
  const n = str.length;
  const a = Math.floor(n / 3);
  return str.slice(n - a) + str.slice(a, n - a) + str.slice(0, a);
}

export function encode(plaintext: Buffer | string): string {
  const std = Buffer.from(plaintext).toString("base64");
  return [...rearrange(std)]
    .map((ch) => {
      const mapped = S2C.get(ch);
      if (!mapped) throw new Error(`char out of alphabet: ${JSON.stringify(ch)}`);
      return mapped;
    })
    .join("");
}

export function decode(encoded: string): Buffer {
  const mappedStr = [...encoded]
    .map((ch) => {
      const mapped = C2S.get(ch);
      if (!mapped) throw new Error(`char out of custom alphabet: ${JSON.stringify(ch)}`);
      return mapped;
    })
    .join("");
  return Buffer.from(rearrange(mappedStr), "base64");
}

export const APPCODE = "cosy";
// 参考实现默认值 base64("war, war never changes")；可用环境变量覆盖。
const DEFAULT_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";

export function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

// 认证类请求签名：MD5("cosy&<secret>&<date>")，date 为 RFC1123 GMT。
export function signAuthDate(date: string, secret = DEFAULT_SECRET): string {
  return md5Hex(`${APPCODE}&${secret}&${date}`);
}

export function rfc1123Now(): string {
  return new Date().toUTCString();
}
