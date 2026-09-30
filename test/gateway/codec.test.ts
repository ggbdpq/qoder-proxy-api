import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode, signAuthDate } from "../../src/providers/gateway/codec.ts";

// golden 值由公开协议参考实现的 Python 版本生成，
// 本机差分验证一致（2026-09-29）。协议属逆向工程产物，随时可能漂移。
test("gateway codec: encode matches the python reference implementation", () => {
  const cases = [
    ["", ""],
    ["a", "$p$#"],
    ["ab", "$SB#"],
    ["abc", "MSK#"],
    ["abcd", "$$KMD_#S"],
    ["hello, world", "bNO%zHqrBZJPHFru"],
  ];
  for (const [plain, expected] of cases) {
    assert.equal(encode(Buffer.from(plain, "utf8")), expected);
  }
});

test("gateway codec: multi-byte utf8 roundtrip", () => {
  const text = "你好，世界！含 emoji 🎉";
  const encoded = encode(Buffer.from(text, "utf8"));
  assert.equal(decode(encoded).toString("utf8"), text);
});

test("gateway codec: json payload golden", () => {
  const payload = JSON.stringify(
    { payload: '{"personalToken":"x"}', encodeVersion: "1" },
    undefined,
    0,
  );
  assert.equal(
    encode(Buffer.from(payload, "utf8")),
    "Fh#(WzDFDLNEj)u(I*l*B%BEw$Wh#S%au(tLuLf*lLf*mgf*e,BrBOmYKf#xLru(gzBMn*m.f*NHFYN(",
  );
});

test("gateway codec: auth date signature golden", () => {
  assert.equal(signAuthDate("Tue, 29 Sep 2026 12:00:00 GMT"), "cbbb4b907f733402e8e236806685d3e5");
});
