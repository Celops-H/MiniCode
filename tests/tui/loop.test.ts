/**
 * 层 2（reducer 可纯函数化部分）：/connect 弹窗 key 输入态的状态流转。
 * 交互链：/connect 打开供应商弹窗（loop 副作用）→ Enter 选中供应商进 key 输入态（loop modal-confirm）
 * → 字符键入弹窗内 key 缓冲（本文件 reducer）→ Enter 提交写配置（loop submitConnectKey，写配置行为
 * 由 connect.test 覆盖）→ 成功仅请求 reconfigure 保持同会话（runTui 返回信号，运行链真机核实）。
 * 本文件覆盖可纯函数断言的部分：key 缓冲增删、与普通输入态的隔离。
 */
import { it, expect, describe } from "vitest";
import { initState, reduceAction, reduceEvent, modelErrorText, resetToNewState, type TuiState } from "../../src/tui/state.js";

function withKeyModal(state: TuiState): TuiState {
  return {
    ...state,
    modal: {
      kind: "connect-key",
      providerId: "deepseek",
      providerName: "DeepSeek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      key: "",
    },
  };
}

describe("connect key 输入态（弹窗内）", () => {
  it("字符追加进 key 缓冲，不进输入框", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "input", text: "s" });
    s = reduceAction(s, { type: "input", text: "k-abc" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-abc" });
    expect(s.prompt.lines[0]).toBe("");
  });

  it("backspace 删除 key 末字符", () => {
    let s = reduceAction(withKeyModal(initState([])), { type: "input", text: "sk-12345" });
    s = reduceAction(s, { type: "backspace" });
    s = reduceAction(s, { type: "backspace" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "sk-123" });
  });

  it("key 输入态不弹 slash 候选（/ 开头的 key 不触发命令）", () => {
    let s = withKeyModal(initState([]));
    s = reduceAction(s, { type: "input", text: "/help" });
    expect(s.modal).toMatchObject({ kind: "connect-key", key: "/help" });
    expect(s.candidate).toBeUndefined();
  });

  it("普通输入态不受 connect-key 分支影响", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "hi" });
    expect(s.prompt.lines[0]).toBe("hi");
    expect(s.modal).toBeUndefined();
  });

  it("Enter（modal-confirm）/Esc（cancel）不落 key 缓冲——提交/取消由 loop 副作用落地", () => {
    const s = withKeyModal(initState([]));
    expect(reduceAction(s, { type: "modal-confirm" }).modal).toMatchObject({ kind: "connect-key", key: "" });
    expect(reduceAction(s, { type: "cancel" }).modal).toMatchObject({ kind: "connect-key", key: "" });
  });
});

describe("modelErrorText：模型调用失败的可读引导（C2 /model 边界）", () => {
  it("认证/未配置/未知模型类错误追加换模型与配 key 引导", () => {
    expect(modelErrorText("Provider openai 未配置认证：请设置环境变量")).toContain("/model 换模型");
    expect(modelErrorText("Incorrect API key provided. 401")).toContain("/connect");
    expect(modelErrorText("未知模型：gpt-9")).toContain("/model 换模型");
    // 厂商侧模型下架/改名（404 / 英文未找到）：同样给换模型引导
    expect(modelErrorText("404 The model 'gpt-9' does not exist")).toContain("/model 换模型");
    expect(modelErrorText("model not found")).toContain("/model 换模型");
  });
  it("其它错误保持原样，不误导", () => {
    expect(modelErrorText("会话存储写入失败")).toBe("会话存储写入失败");
  });
});

describe("C2 /model 边界：模型调用 error 事件渲染进消息区且回到空闲（不退出、可换回）", () => {
  it("无前缀内容时错误作为独立错误块，带引导且状态回空闲", () => {
    const s = reduceEvent(initState([]), { type: "error", message: "Incorrect API key" });
    expect(s.status).toBe("idle");
    const block = s.blocks.at(-1);
    expect(block).toMatchObject({ kind: "message", role: "assistant", isError: true });
    // 与 interact catch 同一套 modelErrorText：模型类错误附换模型/配 key 引导
    expect((block as { text: string }).text).toContain("/model 换模型");
  });
  it("非模型类 error 事件：错误块原样文本、不带模型引导", () => {
    const s = reduceEvent(initState([]), { type: "error", message: "存储写入失败" });
    const block = s.blocks.at(-1) as { text: string } | undefined;
    expect(block?.text).toBe("存储写入失败");
  });
  it("model_fallback 事件：追加常驻通知行到消息区（路由切换可见，非一闪而过 toast）", () => {
    const s = reduceEvent(initState([]), { type: "model_fallback", from: "gpt-4o", to: "deepseek-v4-flash" });
    expect(s.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: "模型 gpt-4o 不可用，已切换 deepseek-v4-flash",
    });
  });
});
describe("/clear 回会话新建态（resetToNewState 纯函数）", () => {
  it("消息区/流式/弹层/候选/聚焦/agent 树/输入清空，历史与标题保留", () => {
    let s = initState([]);
    s = reduceAction(s, { type: "input", text: "旧输入" });
    s = reduceAction(s, { type: "send" }); // 发送才写入输入历史（↑↓ 回看）
    s = { ...s, title: "旧标题", blocks: [{ kind: "message", id: "u1", role: "user", text: "旧对话", thinkingCollapsed: true }], agents: [{ path: "/root", status: "running", spawnedAt: null, completedAt: null }, { path: "/root/task_1", status: "running", spawnedAt: null, completedAt: null }] };
    const fresh = resetToNewState(s);
    expect(fresh.blocks).toEqual([]);
    expect(fresh.agents).toEqual([{ path: "/root", status: "running", spawnedAt: null, completedAt: null }]);
    expect(fresh.prompt.lines[0]).toBe("");
    expect(fresh.modal).toBeUndefined();
    expect(fresh.candidate).toBeUndefined();
    expect(fresh.focusIndex).toBe(-1);
    // 输入历史保留（↑↓ 可回看）
    expect(fresh.prompt.history).toContain("旧输入");
    // 会话标题保留（/clear 只清消息，标题不复位）
    expect(fresh.title).toBe("旧标题");
  });
});
