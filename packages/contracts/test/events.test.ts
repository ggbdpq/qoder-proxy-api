import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RouteEvent, RouteGroup } from "../src/index.ts";

// fixture 来自骨架 e2e 的 /admin/events 原始输出：Codex → group/daily → Kimi 429 → 改道 DeepSeek。
const fixture: unknown[] = JSON.parse(
  readFileSync(new URL("./fixtures/route-events.json", import.meta.url), "utf8"),
);

test("contracts: 骨架 e2e 产出的 8 个路由事件全部 safeParse 成功", () => {
  assert.equal(fixture.length, 8);
  for (const [i, event] of fixture.entries()) {
    const result = RouteEvent.safeParse(event);
    assert.ok(result.success, `events[${i}]: ${result.error?.message}`);
  }
});

test("contracts: 未知事件类型和缺字段的事件被拒绝", () => {
  assert.equal(
    RouteEvent.safeParse({ type: "upstream.retry", requestId: "r", at: 1 }).success,
    false,
  );
  assert.equal(
    RouteEvent.safeParse({
      type: "reroute",
      requestId: "r",
      at: 1,
      from: { providerId: "a", model: "m" },
    }).success,
    false,
  );
});

test("contracts: RouteGroup 按 02 §4 校验 id、maxAttempts 与成员去重", () => {
  const group = {
    id: "daily-coding",
    name: "日常编码",
    strategy: "ordered",
    enabled: true,
    members: [
      { providerId: "kimi", model: "kimi-k2" },
      { providerId: "deepseek", model: "deepseek-chat" },
    ],
  };
  assert.equal(RouteGroup.parse(group).maxAttempts, 3);
  assert.equal(RouteGroup.safeParse({ ...group, id: "Daily" }).success, false);
  assert.equal(RouteGroup.safeParse({ ...group, maxAttempts: 6 }).success, false);
  assert.equal(RouteGroup.safeParse({ ...group, members: [] }).success, false);
  assert.equal(
    RouteGroup.safeParse({ ...group, members: [group.members[0], group.members[0]] }).success,
    false,
  );
});
