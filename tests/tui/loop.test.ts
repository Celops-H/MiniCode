/**
 * 层 2（reducer 可纯函数化部分）：/connect 弹窗 key 输入态的状态流转。
 * 交互链：/connect 打开供应商弹窗（loop 副作用）→ Enter 选中供应商进 key 输入态（loop modal-confirm）
 * → 字符键入弹窗内 key 缓冲（本文件 reducer）→ Enter 提交写配置（loop submitConnectKey，写配置行为
 * 由 connect.test 覆盖）→ 成功仅请求 reconfigure 保持同会话（runTui 返回信号，运行链真机核实）。
 * 本文件覆盖可纯函数断言的部分：key 缓冲增删、与普通输入态的隔离。
 */
import { it, expect, describe } from "vitest";
import { initState, reduceAction, type TuiState } from "../../src/tui/state.js";

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